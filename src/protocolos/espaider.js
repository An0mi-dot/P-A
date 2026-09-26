// EspaiderAutomator — port de espaider.py para Playwright (chromium channel msedge).
'use strict';

const { chromium } = require('playwright-core');

const ESPAIDER_URL = 'https://espaider.neoenergia.com/login/main2.aspx';

class EspaiderAutomator {
  constructor(headless = true, options = {}) {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.headless = headless;
    this._filterLocator = null; // cache do input de filtro
    this._user = '';
    this._pwd = '';
    // Timeout generoso: padrão 45 segundos (Spider é lento em muitas operações)
    this.timeoutMs = options.timeoutMs || 45000;
    this.lastSearch = null;
  }

  async start() {
    try {
      this.browser = await chromium.launch({
        channel: 'msedge',
        headless: this.headless,
        args: [
          '--disable-gpu',
          '--no-sandbox',
          '--log-level=3',
          '--disable-blink-features=AutomationControlled',
          '--remote-allow-origins=*',
          '--window-size=1920,1080',
        ],
      });
      this.context = await this.browser.newContext({
        viewport: { width: 1920, height: 1080 },
        acceptDownloads: true,
      });
      // Anti-bot (Akamai / WAF / Cloudflare): ofusca o navigator.webdriver
      await this.context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US', 'en'] });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      });
      this.page = await this.context.newPage();
      this.page.setDefaultTimeout(this.timeoutMs);
      await this.page.goto(ESPAIDER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) {
      console.error(`Error starting Edge browser: ${e}`);
      this.page = null;
      throw e;
    }
  }

  async login(user, pwd, goToContencioso = true) {
    if (!this.page) return;
    this._user = user;
    this._pwd = pwd;
    try {
      await this.page.waitForSelector('#userFieldEdt', { timeout: 20000 });
      await this.page.fill('#userFieldEdt', user);
      await this.page.fill('#passFieldEdt', pwd);
      await this.page.press('#passFieldEdt', 'Enter');

      // Aguarda dashboard inicial carregar
      await this.page.waitForSelector('span:has-text("Contencioso")', { timeout: 25000 });

      if (goToContencioso) {
        try {
          await this.page.click('div[title="Contencioso"] button', { timeout: 8000 });
          await this.page.waitForSelector('iframe', { timeout: 15000 });
          await this._waitForMaskClear(10000);
        } catch (e) {}
      }
    } catch (e) {
      console.error(`Error logging in: ${e}`);
    }
  }

  _frames() {
    return this.page ? this.page.frames() : [];
  }

  // Scan iframes e retorna o input de filtro visível/habilitado, ou null.
  async _findFilter() {
    for (const frame of this._frames()) {
      try {
        const selectors = [
          'input[id*="filterTBX_gridpanel_"]',
          'input[name*="filterTBX_gridpanel_"]',
        ];
        for (const sel of selectors) {
          const loc = frame.locator(sel);
          const count = await loc.count().catch(() => 0);
          for (let i = 0; i < count; i++) {
            const el = loc.nth(i);
            const vis = await el.isVisible().catch(() => false);
            const enb = await el.isEnabled().catch(() => false);
            if (vis && enb) return el;
          }
        }
        const xloc = frame.locator('xpath=//label[text()="Filtrar"]/following::input[1]');
        const cnt = await xloc.count().catch(() => 0);
        for (let i = 0; i < cnt; i++) {
          const el = xloc.nth(i);
          const vis = await el.isVisible().catch(() => false);
          const enb = await el.isEnabled().catch(() => false);
          if (vis && enb) return el;
        }
      } catch (e) {}
    }
    return null;
  }

  async _filterVisible(loc) {
    try {
      if (loc && loc.page) return (await loc.isVisible()) && (await loc.isEnabled());
    } catch (e) {}
    return false;
  }

  async _clickContencioso() {
    try {
      await this.page.click('div[title="Contencioso"] button', { timeout: 8000 });
    } catch (e) {}
  }

  async _isGridMasked() {
    for (const frame of this._frames()) {
      try {
        const masks = frame.locator('.x-mask-loading, .x-mask, div.loading-indicator, div:has-text("Carregando...")');
        const count = await masks.count().catch(() => 0);
        for (let i = 0; i < count; i++) {
          if (await masks.nth(i).isVisible().catch(() => false)) return true;
        }
      } catch (e) {}
    }
    return false;
  }

  async _waitForMaskClear(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const masked = await this._isGridMasked();
      if (!masked) return true;
      if (this.page) await this.page.waitForTimeout(300);
    }
    return false;
  }

  async _ensureFilter() {
    let filterIn = null;
    if (await this._filterVisible(this._filterLocator)) {
      filterIn = this._filterLocator;
    } else {
      this._filterLocator = null;
    }

    // 1. Antes de qualquer clique, verifica se o filtro já existe em algum iframe aberto!
    // Isso evita recarregar destrutivamente a página caso o locator tenha apenas sido desincronizado.
    if (!filterIn) {
      filterIn = await this._findFilter();
    }

    // 2. Apenas se NÃO foi encontrado em nenhum iframe, clica em Contencioso
    if (!filterIn) {
      await this._clickContencioso();

      const timeout = this.headless ? 30 : 20;
      const tStart = Date.now();
      while (!filterIn && Date.now() - tStart < timeout * 1000) {
        await this.page.waitForTimeout(400);
        filterIn = await this._findFilter();
        if (!filterIn) await this.page.waitForTimeout(300);
      }

      // Retry (re-clica, detecta se caiu na tela de login)
      const tRetryStart = Date.now();
      while (!filterIn && Date.now() - tRetryStart < 25000) {
        try {
          const loginEls = await this.page.locator('input[id*="login"], input[name*="login"], input[id*="username"]').count();
          if (loginEls > 0) {
            await this.login(this._user, this._pwd, false);
            try {
              await this.page.waitForSelector('span:has-text("Contencioso")', { timeout: 15000 });
            } catch (e) {}
            continue;
          }
          await this._clickContencioso();
          await this.page.waitForTimeout(2000);
        } catch (e) {}
        filterIn = await this._findFilter();
        if (!filterIn) await this.page.waitForTimeout(1000);
      }
    }

    this._filterLocator = filterIn;
    return filterIn;
  }

  async _typeClear(loc, text, pressEnter = true) {
    try { await loc.click({ timeout: 5000 }); } catch (e) {}
    try { await loc.evaluate((el) => { el.value = ''; }); } catch (e) {}
    try { await loc.press('Control+a'); } catch (e) {}
    try { await loc.press('Backspace'); } catch (e) {}
    try {
      await loc.fill(text, { timeout: 5000 });
    } catch (e) {
      try {
        await loc.evaluate((el, val) => {
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, text);
      } catch (e2) {}
    }
    try {
      await loc.evaluate((el) => {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
    } catch (e) {}
    if (pressEnter) {
      try { await loc.press('Enter'); } catch (e) {}
    }
  }

  async _findNpuRow(npuRaw, npuDigits) {
    for (const frame of this._frames()) {
      try {
        const rows = frame.locator('tr.x-grid-row, tr.x-grid3-row');
        const n = await rows.count().catch(() => 0);
        for (let i = 0; i < n; i++) {
          const row = rows.nth(i);
          const txt = await row.textContent().catch(() => '');
          if (!txt) continue;
          if (npuRaw && txt.includes(npuRaw)) return row;
          if (npuDigits && npuDigits.length >= 10) {
            const txtDigits = txt.replace(/\D/g, '');
            if (txtDigits.includes(npuDigits)) return row;
          }
        }
      } catch (e) {}
    }
    return null;
  }

  async _gridEmpty() {
    for (const frame of this._frames()) {
      try {
        const selectors = [
          'div.x-grid-empty-text',
          'div.x-grid-empty',
          'div.x-grid3-body:has-text("Nenhum")',
          'div.x-toolbar:has-text("Nenhum registro")',
          'div:has-text("Nenhum registro")',
          'div:has-text("Nenhum registro encontrado")',
        ];
        for (const sel of selectors) {
          const loc = frame.locator(sel);
          const count = await loc.count().catch(() => 0);
          for (let i = 0; i < count; i++) {
            const el = loc.nth(i);
            const vis = await el.isVisible().catch(() => false);
            if (vis) {
              const txt = ((await el.textContent().catch(() => '')) || '').toLowerCase();
              if (
                txt.includes('nenhum registro') ||
                txt.includes('não há registros') ||
                txt.includes('nao ha registros') ||
                txt.includes('não foram encontrados') ||
                txt.includes('sem registros') ||
                txt.includes('0 de 0') ||
                txt.includes('0 registros')
              ) {
                return true;
              }
            }
          }
        }
      } catch (e) {}
    }
    return false;
  }

  // Estabiliza e recupera a sessão quando o Spider trava ou demora
  async recoverSession() {
    if (!this.page || this.page.isClosed()) return;
    try {
      // 1. Fecha eventuais popups de erro ou alertas do ExtJS
      for (const frame of this._frames()) {
        try {
          const btnOk = frame.locator('.x-window-dlg button:has-text("OK"), .x-message-box button:has-text("OK"), button:has-text("Fechar")');
          const n = await btnOk.count().catch(() => 0);
          for (let i = 0; i < n; i++) {
            if (await btnOk.nth(i).isVisible().catch(() => false)) {
              await btnOk.nth(i).click().catch(() => {});
            }
          }
        } catch (e) {}
      }

      // 2. Aguarda máscaras de carregamento ativas sumirem
      await this._waitForMaskClear(8000);

      // 3. Tenta localizar e limpar o campo de filtro para restaurar a grid
      let f = this._filterLocator;
      if (!f || !(await this._filterVisible(f))) {
        f = await this._findFilter();
        this._filterLocator = f;
      }

      if (f && (await this._filterVisible(f))) {
        await this._typeClear(f, '', true);
        await this.page.waitForTimeout(1000);
      } else {
        // Se realmente perdeu a tela do Contencioso, re-clica
        await this._clickContencioso();
        await this.page.waitForTimeout(2000);
        this._filterLocator = await this._findFilter();
      }
    } catch (e) {
      console.error('Error recovering Espaider session:', e);
      this._filterLocator = null;
    }
  }

  // Pesquisa com detalhes de diagnóstico
  async searchNpuDetailed(npu, options = {}) {
    if (!this.page) {
      const res = { ok: false, error: 'no_page', escritorio: '', found: false, timedOut: false };
      this.lastSearch = res;
      return res;
    }

    const npuRaw = (npu || '').trim();
    if (!npuRaw) {
      const res = { ok: true, error: null, escritorio: '', found: false, timedOut: false };
      this.lastSearch = res;
      return res;
    }
    const npuDigits = npuRaw.replace(/\D/g, '');

    const timeoutMs = options.timeoutMs || this.timeoutMs || 45000;
    const deadline = Date.now() + timeoutMs;

    try {
      const filterIn = await this._ensureFilter();
      if (!filterIn) {
        const res = { ok: false, error: 'filter_not_found', escritorio: '', found: false, timedOut: false };
        this.lastSearch = res;
        return res;
      }

      // Aguarda qualquer requisição pendente anterior finalizar
      await this._waitForMaskClear(10000);

      // Digita o NPU e aciona a pesquisa
      await this._typeClear(filterIn, npuRaw, true);
      await this.page.waitForTimeout(600);

      let keyPressRetried = false;
      const typeTime = Date.now();

      while (Date.now() < deadline) {
        const isMasked = await this._isGridMasked();

        // Verifica se a linha com o NPU já está presente
        const row = await this._findNpuRow(npuRaw, npuDigits);
        if (row) {
          const tds = row.locator('td');
          const nTds = await tds.count().catch(() => 0);
          let escritorio = '';
          if (nTds >= 8) {
            escritorio = ((await tds.nth(7).textContent().catch(() => '')) || '').trim();
          }
          const res = { ok: true, found: true, escritorio, error: null, timedOut: false };
          this.lastSearch = res;
          return res;
        }

        // Se NÃO estiver em carregamento, verifica se a mensagem de "nenhum registro" apareceu
        if (!isMasked) {
          if (await this._gridEmpty()) {
            await this.page.waitForTimeout(400);
            if (await this._gridEmpty() && !(await this._isGridMasked())) {
              const res = { ok: true, found: false, escritorio: '', error: null, timedOut: false };
              this.lastSearch = res;
              return res;
            }
          }
        }

        // Se passou mais de 16s sem máscara e sem resultado, tenta pressionar Enter novamente
        if (!keyPressRetried && (Date.now() - typeTime > 16000) && !isMasked) {
          keyPressRetried = true;
          try {
            await filterIn.press('Enter');
          } catch (e) {}
        }

        await this.page.waitForTimeout(500);
      }

      // Se atingiu o deadline (timeout)
      console.warn(`[Espaider] Timeout (${Math.round(timeoutMs / 1000)}s) ao consultar NPU: ${npuRaw}`);
      const res = { ok: false, found: false, escritorio: '', error: 'timeout', timedOut: true };
      this.lastSearch = res;
      return res;
    } catch (e) {
      console.error(`Search NPU fail for ${npuRaw}: ${e}`);
      const res = { ok: false, found: false, escritorio: '', error: (e && e.message) || String(e), timedOut: false };
      this.lastSearch = res;
      return res;
    }
  }

  // Compatibilidade com a API anterior: retorna o nome do escritório (string)
  async searchNpu(npu, options = {}) {
    const res = await this.searchNpuDetailed(npu, options);
    return res.escritorio || '';
  }

  async stop() {
    try {
      if (this.browser) await this.browser.close();
    } catch (e) {}
    this.browser = null;
    this.page = null;
    this.context = null;
    this._filterLocator = null;
    this.lastSearch = null;
  }
}

module.exports = { EspaiderAutomator };