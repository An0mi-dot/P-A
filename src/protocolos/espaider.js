// EspaiderAutomator — port de espaider.py para Playwright (chromium channel msedge).
'use strict';

const { chromium } = require('playwright-core');

const ESPAIDER_URL = 'https://espaider.neoenergia.com/login/main2.aspx';

class EspaiderAutomator {
  constructor(headless = true) {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.headless = headless;
    this._filterLocator = null; // cache do input de filtro
    this._user = '';
    this._pwd = '';
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
      await this.page.waitForSelector('#userFieldEdt', { timeout: 15000 });
      await this.page.fill('#userFieldEdt', user);
      await this.page.fill('#passFieldEdt', pwd);
      await this.page.press('#passFieldEdt', 'Enter');

      // Wait for home dashboard
      await this.page.waitForSelector('span:has-text("Contencioso")', { timeout: 15000 });

      if (goToContencioso) {
        try {
          await this.page.click('div[title="Contencioso"] button', { timeout: 5000 });
          await this.page.waitForSelector('iframe', { timeout: 10000 });
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
      await this.page.click('div[title="Contencioso"] button', { timeout: 5000 });
    } catch (e) {}
  }

  async _ensureFilter() {
    let filterIn = null;
    if (await this._filterVisible(this._filterLocator)) {
      filterIn = this._filterLocator;
    } else {
      this._filterLocator = null;
    }

    if (!filterIn) {
      await this._clickContencioso();

      // Escaneia iframes por até timeout segundos (poll 0.5s)
      const timeout = this.headless ? 20 : 15;
      const tStart = Date.now();
      while (!filterIn && Date.now() - tStart < timeout * 1000) {
        await this.page.waitForTimeout(300);
        filterIn = await this._findFilter();
        if (!filterIn) await this.page.waitForTimeout(200);
      }

      // Retry por até 30s (re-clica, detecta login)
      const tRetryStart = Date.now();
      while (!filterIn && Date.now() - tRetryStart < 30000) {
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

      this._filterLocator = filterIn;
    }

    return filterIn;
  }

  async _typeClear(loc, text, pressEnter = true) {
    try { await loc.click(); } catch (e) {}
    try { await loc.evaluate((el) => { el.value = ''; }); } catch (e) {}
    try { await loc.press('Control+a'); } catch (e) {}
    try { await loc.press('Backspace'); } catch (e) {}
    await loc.fill(text);
    if (pressEnter) await loc.press('Enter');
  }

  async searchNpu(npu) {
    if (!this.page) return '';
    try {
      const filterIn = await this._ensureFilter();
      if (!filterIn) return '';

      await this._typeClear(filterIn, npu, true);

      let escritorio = '';
      for (let tentativa = 0; tentativa < 2; tentativa++) {
        const row = await this._waitForNpuRow(npu, 12000);
        if (row) {
          const tds = row.locator('td');
          const nTds = await tds.count();
          if (nTds >= 8) {
            escritorio = (await tds.nth(7).textContent()).trim();
          }
          break;
        }
        // Timeout: verifica mensagem "nenhum registro"
        if (await this._gridEmpty()) break;
        if (tentativa === 0) {
          await this._typeClear(filterIn, npu, true);
        } else {
          throw new Error(`grid timeout for ${npu}`);
        }
      }
      return escritorio;
    } catch (e) {
      console.error(`Search NPU fail for ${npu}: ${e}`);
      return '';
    }
  }

  async _waitForNpuRow(npu, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const frame of this._frames()) {
        const rows = frame.locator('tr.x-grid-row');
        const n = await rows.count().catch(() => 0);
        for (let i = 0; i < n; i++) {
          const txt = await rows.nth(i).textContent().catch(() => '');
          if (txt && txt.includes(npu)) return rows.nth(i);
        }
      }
      await this.page.waitForTimeout(500);
    }
    return null;
  }

  async _gridEmpty() {
    for (const frame of this._frames()) {
      try {
        const loc = frame.locator('div.x-grid-empty-text');
        const n = await loc.count().catch(() => 0);
        for (let i = 0; i < n; i++) {
          const txt = ((await loc.nth(i).textContent().catch(() => '')) || '').toLowerCase();
          if (txt.includes('nenhum registro')) return true;
        }
      } catch (e) {}
    }
    return false;
  }

  async stop() {
    try {
      if (this.browser) await this.browser.close();
    } catch (e) {}
    this.browser = null;
    this.page = null;
    this.context = null;
  }
}

module.exports = { EspaiderAutomator };