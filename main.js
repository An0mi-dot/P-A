const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, webContents } = require('electron');
const { chromium } = require('playwright-core');

// --- INSPECT EXCEL (Remove after use) ---
// const inspectExcel = require('./scripts/inspect_excel');
// app.on('ready', () => {
    // inspectExcel(app);
// });

// Mirror main-process logs into the renderer's log panel for debugging
(function patchConsole() {
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;

    function forward(level, origFn, args) {
        origFn(...args);
        try {
            const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
            if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('log-message', {
            msg,
            type: level === 'error' ? 'error' : (level === 'warn' ? 'warn' : 'info'),
            tech: 'main-process console bridge',
            source: 'main',
            timestamp: new Date().toISOString(),
            details: args.length > 1 ? args.map(a => typeof a === 'string' ? a : JSON.stringify(a, null, 2)).join('\n') : ''
          });
            }
        } catch (_) {}
    }

    console.log = (...args) => forward('log', origLog, args);
    console.warn = (...args) => forward('warn', origWarn, args);
    console.error = (...args) => forward('error', origError, args);
})();



const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec, execSync } = require('child_process');
const https = require('https');
const { net } = require('electron');
const automacaoService = require('./src/automacao_service');
const historyService = require('./src/history-service');
const queueService = require('./src/queue-service');

// IPC bridge: renderer calls this to make HTTP requests via Electron's net module
// Electron's net module keeps requests in the main process.
ipcMain.handle('net-fetch', async (event, url, init) => {
  try {
    const fetchOpts = {
      method: init.method || 'GET',
      headers: init.headers || {},
    };
    if (init.body !== undefined && init.body !== null) fetchOpts.body = init.body;
    const response = await net.fetch(url, fetchOpts);
    const body = await response.text();
    const headers = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    return { ok: response.ok, status: response.status, statusText: response.statusText, headers, body };
  } catch (e) {
    console.error('net-fetch error:', url, e.message);
    // Return structured error so renderer can show useful diagnostics
    throw new Error('NETWORK_ERROR:' + e.message);
  }
});

let mainWindow;
let appTray = null;
let loadingWindow = null;

// --- Dev Live-Reload (only in development) ---
if (process.env.NODE_ENV !== 'production') {
  try {
    require('electron-reload')(__dirname, {
      electron: require(path.join(__dirname, 'node_modules', 'electron')),
      awaitWriteFinish: true,
      ignored: /node_modules|[\/\\]\.|[\/\\]Externo[\/\\]/i
    });
    console.log('Dev: electron-reload enabled');
  } catch (e) {
    console.log('Dev: electron-reload not available or failed to initialize', e);
  }
}

// Global flag set by automation service to indicate a running automation
global.isAutomationRunning = false;

// Prevent quitting when automation is active
app.on('before-quit', (e) => {
  if (global.isAutomationRunning) {
    e.preventDefault();
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['Cancelar', 'Forçar Saída'],
      defaultId: 0,
      cancelId: 0,
      title: 'Automação em Execução',
      message: 'Uma automação está em execução. Deseja forçar a saída (isso pode deixar processos órfãos)?',
      detail: 'Escolha "Cancelar" para interromper a automação com segurança antes de sair.'
    });
    if (choice === 1) {
      // User chose to force quit - allow quit to continue
      global.isAutomationRunning = false;
      app.exit(0);
    }
  }
});

// --- Persistência de Estado via app.getPath('userData') ---
const STATE_FILE = path.join(app.getPath('userData'), 'state.json');
const PLAYWRIGHT_DIR = path.join(app.getPath('userData'), 'playwright-storage');
const PJE_STORAGE = path.join(PLAYWRIGHT_DIR, 'pje.json');

ipcMain.handle('load-app-state', async () => {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error('load-app-state error', e);
  }
  return {};
});

ipcMain.on('save-app-state', (event, incomingState) => {
  try {
    // Defensive: some renderers call save-app-state without a payload; ignore to avoid overwriting with undefined
    if (typeof incomingState === 'undefined' || incomingState === null) return;
    
    // Read existing state to merge instead of overwrite
    let existingState = {};
    if (fs.existsSync(STATE_FILE)) {
        try {
            existingState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        } catch(e) { /* ignore parse error, start fresh */ }
    }
    
    // Merge: incoming overrides existing, but preserves keys not present in incoming
    const newState = { ...existingState, ...incomingState };
    
    fs.writeFileSync(STATE_FILE, JSON.stringify(newState, null, 2), 'utf8');
  } catch (e) {
    console.error('save-app-state error', e);
  }
});

// Handler requested by SharePoint service to bring the application window to front
ipcMain.on('bring-window-front', (event, args) => {
  try {
    const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
    if (!win) return;
    // Temporarily set alwaysOnTop to ensure visibility, then restore shortly after
    win.setAlwaysOnTop(true, 'screen');
    setTimeout(() => {
      try { win.setAlwaysOnTop(false); } catch (e) { /* ignore */ }
      try { if (!win.isDestroyed()) win.focus(); } catch(e) { }
    }, 300);
  } catch (e) {
    console.error('bring-window-front handler error', e);
  }
});

// Listener para redimensionamento dinâmico da janela
ipcMain.on('window-resize', (event, { width, height }) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setSize(width, height);
    mainWindow.center();
  }
});

// SharePoint preview and creation handlers
ipcMain.handle('sharepoint:get-preview', async (event, args) => {
  try {
    const runner = require('./src/sharepoint_runner');
    const res = await runner.getPreview(args || {}, event.sender);
    return res;
  } catch (e) {
    console.error('sharepoint:get-preview error', e);
    return { ok: false, error: e && e.message };
  }
});

ipcMain.handle('sharepoint:create', async (event, args) => {
  try {
    const runner = require('./src/sharepoint_runner');
    const res = await runner.createSequential(args || {}, event.sender);
    return res;
  } catch (e) {
    console.error('sharepoint:create error', e);
    return { ok: false, error: e && e.message };
  }
});

// Start a long-lived session: opens Edge, navigates and returns a sessionId + preview. Browser stays open until create-session is called or timeout.
ipcMain.handle('sharepoint:start-session', async (event, args) => {
  try {
    const runner = require('./src/sharepoint_runner');
    const res = await runner.startSession(args || {}, event.sender);
    return res;
  } catch (e) {
    console.error('sharepoint:start-session error', e);
    return { ok: false, error: e && e.message };
  }
});

// Create using an existing session and then close it
ipcMain.handle('sharepoint:create-session', async (event, args) => {
  try {
    const runner = require('./src/sharepoint_runner');
    const res = await runner.createInSession(args && args.sessionId ? args.sessionId : null, args || {}, event.sender);
    return res;
  } catch (e) {
    console.error('sharepoint:create-session error', e);
    return { ok: false, error: e && e.message };
  }
});

// Stop analyzer capture for a session and return captured entries
// Cancel a running SharePoint session (close browser and cleanup)
ipcMain.handle('sharepoint:cancel-session', async (event, args) => {
  try {
    const runner = require('./src/sharepoint_runner');
    const res = await runner.cancelSession(args && args.sessionId ? args.sessionId : null);
    return res;
  } catch (e) {
    console.error('sharepoint:cancel-session error', e);
    return { ok: false, error: e && e.message };
  }
});

// Convert a browser dump (localStorage/sessionStorage/cookies) to Playwright storageState format
function convertToPlaywrightStorage(payload) {
  try {
    if (!payload) throw new Error('no_payload');
    const origin = payload.origin || (payload.url ? new URL(payload.url).origin : null);
    const domain = origin ? new URL(origin).hostname : null;

    // Normalize cookies: accept array or JSON-stringed array
    let cookies = payload.cookies || [];
    if (typeof cookies === 'string') {
      try { cookies = JSON.parse(cookies); } catch (e) { cookies = []; }
    }
    cookies = Array.isArray(cookies) ? cookies : [];

    const cookieObjs = cookies.map(c => ({
      name: String(c.name || ''),
      value: String(c.value || ''),
      domain: c.domain || domain || (origin ? new URL(origin).hostname : ''),
      path: c.path || '/',
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
      sameSite: c.sameSite || 'Lax'
    })).filter(c => c.name);

    // Convert localStorage object to array form expected by Playwright
    const local = payload.localStorage || {};
    const localArr = Object.keys(local || {}).map(k => ({ name: String(k), value: String(local[k]) }));

    const storage = {
      cookies: cookieObjs,
      origins: []
    };
    if (origin) storage.origins.push({ origin, localStorage: localArr });

    return storage;
  } catch (e) {
    throw e;
  }
}

// IPC: import PJE session (payload can be object or string) - now merges with existing storage
ipcMain.handle('pje:import-session', async (event, payload) => {
  try {
    let parsed = payload;
    if (typeof payload === 'string') {
      try { parsed = JSON.parse(payload); } catch (e) { /* keep as string - conversion will fail */ }
    }

    const incoming = convertToPlaywrightStorage(parsed);

    // Read any existing storage (project-local and userData)
    let existing = null;
    try {
      if (fs.existsSync(PJE_STORAGE)) existing = JSON.parse(fs.readFileSync(PJE_STORAGE, 'utf8'));
    } catch (e) { /* ignore */ }
    try {
      const userPje = path.join(app.getPath('userData'), 'playwright-storage', 'pje.json');
      if (!existing && fs.existsSync(userPje)) existing = JSON.parse(fs.readFileSync(userPje, 'utf8'));
    } catch (e) { /* ignore */ }

    // Merge cookies (unique by name+domain+path) - incoming wins
    const cookieKey = (c) => `${c.name || ''}|${c.domain || ''}|${c.path || '/'}|${c.value || ''}`;
    const cookiesMap = new Map();
    (existing && Array.isArray(existing.cookies) ? existing.cookies : []).forEach(c => {
      const key = `${c.name || ''}|${c.domain || ''}|${c.path || '/'}|${c.value || ''}`;
      cookiesMap.set(key, c);
    });
    (incoming && Array.isArray(incoming.cookies) ? incoming.cookies : []).forEach(c => {
      const key = `${c.name || ''}|${c.domain || ''}|${c.path || '/'}|${c.value || ''}`;
      cookiesMap.set(key, c);
    });
    const mergedCookies = Array.from(cookiesMap.values());

    // Merge origins/localStorage: for same origin, merge key/value pairs (incoming wins)
    const originMap = new Map();
    const toLocalMap = (arr) => (arr || []).reduce((acc, i) => { acc[String(i.name)] = String(i.value); return acc; }, {});

    (existing && Array.isArray(existing.origins) ? existing.origins : []).forEach(o => {
      originMap.set(o.origin, { origin: o.origin, local: toLocalMap(o.localStorage) });
    });
    (incoming && Array.isArray(incoming.origins) ? incoming.origins : []).forEach(o => {
      const prev = originMap.get(o.origin) || { origin: o.origin, local: {} };
      const incomingLocal = toLocalMap(o.localStorage);
      // Merge: incoming overrides existing keys
      const mergedLocal = Object.assign({}, prev.local || {}, incomingLocal || {});
      originMap.set(o.origin, { origin: o.origin, local: mergedLocal });
    });

    const mergedOrigins = Array.from(originMap.values()).map(o => ({ origin: o.origin, localStorage: Object.keys(o.local).map(k => ({ name: k, value: String(o.local[k]) })) }));

    const merged = { cookies: mergedCookies, origins: mergedOrigins };

    // Ensure directories exist and write both local and userData copies
    if (!fs.existsSync(PLAYWRIGHT_DIR)) fs.mkdirSync(PLAYWRIGHT_DIR, { recursive: true });
    fs.writeFileSync(PJE_STORAGE, JSON.stringify(merged, null, 2), 'utf8');

    try {
      const userDir = path.join(app.getPath('userData'), 'playwright-storage');
      if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
      fs.writeFileSync(path.join(userDir, 'pje.json'), JSON.stringify(merged, null, 2), 'utf8');
    } catch (e) { /* ignore userData write failures */ }

    return { ok: true, path: PJE_STORAGE };
  } catch (e) {
    console.error('pje:import-session error', e);
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});

ipcMain.handle('pje:has-session', async () => {
  try {
    const local = path.join(__dirname, 'playwright-storage', 'pje.json');
    if (fs.existsSync(PJE_STORAGE)) return true;
    if (fs.existsSync(local)) return true;
    return false;
  } catch (e) { return false; }
});

ipcMain.handle('pje:get-session', async () => {
  try { if (fs.existsSync(PJE_STORAGE)) return JSON.parse(fs.readFileSync(PJE_STORAGE, 'utf8')); } catch (e) { console.error('pje:get-session error', e); }
  return null;
});

// --- PJE DevTools Flow (browser session management) ---
const pjeSessions = new Map();

function findEdgeExec() {
  const paths = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  return paths.find(p => fs.existsSync(p));
}

ipcMain.handle('pje:start-session', async (event, args) => {
  try {
    const url = args && args.url ? args.url : 'https://pje.tjba.jus.br/pje/';
    const edgePath = findEdgeExec();
    if (!edgePath) return { ok: false, error: 'Edge executable not found' };

    // Load saved storage if available
    let storagePath = null;
    try {
      if (fs.existsSync(PJE_STORAGE)) storagePath = PJE_STORAGE;
    } catch (e) {}

    const browser = await chromium.launch({
      executablePath: edgePath,
      headless: false,
      devtools: true,
      args: ['--start-maximized', '--disable-blink-features=AutomationControlled']
    });
    const context = await browser.newContext({
      viewport: null,
      ...(storagePath ? { storageState: storagePath } : {})
    });

    const page = await context.newPage();
    page.setDefaultTimeout(60000);

    if (storagePath) {
      try { event.sender.send('log-message', { type: 'info', msg: 'Sessão salva carregada automaticamente. ✓' }); } catch (e) {}
    } else {
      try { event.sender.send('log-message', { type: 'info', msg: 'Nenhuma sessão salva encontrada.' }); } catch (e) {}
    }

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const sessionId = Math.random().toString(36).slice(2, 10);
    pjeSessions.set(sessionId, { browser, context, page });

    try { event.sender.send('log-message', { type: 'info', msg: `Navegador PJE aberto em ${url}` }); } catch (e) {}

    return { ok: true, sessionId, hasSession: !!storagePath };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});

ipcMain.handle('pje:navigate-to-extraction', async (event, args) => {
  try {
    const session = pjeSessions.get(args && args.sessionId);
    if (!session) return { ok: false, error: 'Sessão não encontrada' };

    const { page } = session;
    const instance = args && args.instance ? args.instance : 'pje1';

    if (instance === 'pje1') {
      try { event.sender.send('log-message', { type: 'info', msg: 'Executando sequência de navegação PJE 1º Grau...' }); } catch (e) {}

      // Step 1: Click user dropdown
      try {
        await page.waitForSelector('.dropdown-toggle', { timeout: 15000 });
        await page.click('.dropdown-toggle');
        try { event.sender.send('log-message', { type: 'info', msg: 'Dropdown do usuário clicado.' }); } catch (e) {}
      } catch (e) {
        try { event.sender.send('log-message', { type: 'warn', msg: 'Dropdown não encontrado, continuando...' }); } catch (e) {}
      }

      await page.waitForTimeout(1500);

      // Step 2: Click Procuradoria profile via JSF-generated table
      try {
        const profileLink = await page.locator('[id="papeisUsuarioForm:dtPerfil:2:colPerfil"] > a').first();
        await profileLink.waitFor({ timeout: 10000 });
        await profileLink.click();
        try { event.sender.send('log-message', { type: 'info', msg: 'Perfil Procuradoria clicado.' }); } catch (e) {}
      } catch (e) {
        try { event.sender.send('log-message', { type: 'warn', msg: 'Link Procuradoria via ID não encontrado, tentando por texto...' }); } catch (e) {}
        try {
          const fallback = await page.locator('a:has-text("Procuradoria")').first();
          await fallback.waitFor({ timeout: 5000 });
          await fallback.click();
          try { event.sender.send('log-message', { type: 'info', msg: 'Perfil Procuradoria selecionado (fallback).' }); } catch (e) {}
        } catch (e2) {
          try { event.sender.send('log-message', { type: 'warn', msg: 'Link Procuradoria não encontrado.' }); } catch (e2) {}
        }
      }

      // Step 3: Wait for page reload after profile switch, then click Expedientes tab
      try {
        await page.waitForTimeout(4000);
        const expTab = await page.locator('#tabExpedientes_lbl').first();
        await expTab.waitFor({ timeout: 20000 });
        await expTab.click();
        try { event.sender.send('log-message', { type: 'info', msg: 'Aba EXPEDIENTES clicada.' }); } catch (e) {}
      } catch (e) {
        try { event.sender.send('log-message', { type: 'warn', msg: 'Aba EXPEDIENTES não encontrada, tentando fallback...' }); } catch (e) {}
        try {
          const fallback = await page.locator('td:has-text("Expedientes")').first();
          await fallback.waitFor({ timeout: 10000 });
          await fallback.click();
          try { event.sender.send('log-message', { type: 'info', msg: 'Aba Expedientes clicada (fallback).' }); } catch (e) {}
        } catch (e2) {}
      }

      await page.waitForTimeout(2000);

      // Step 4: Click "Pendentes de ciência ou de resposta"
      try {
        const pendLink = await page.locator('[id="formAbaExpediente:listaAgrSitExp:0:j_id165"] > span.nomeTarefa').first();
        await pendLink.waitFor({ timeout: 15000 });
        await pendLink.click();
        try { event.sender.send('log-message', { type: 'info', msg: 'Pendentes de ciência ou de resposta clicado.' }); } catch (e) {}
      } catch (e) {
        try { event.sender.send('log-message', { type: 'warn', msg: 'Seletor de Pendentes não encontrado, tentando fallback...' }); } catch (e) {}
        try {
          const fallback = await page.locator('span.nomeTarefa:has-text("Pendentes")').first();
          await fallback.waitFor({ timeout: 8000 });
          await fallback.click();
          try { event.sender.send('log-message', { type: 'info', msg: 'Pendentes clicado (fallback).' }); } catch (e) {}
        } catch (e2) {
          try { event.sender.send('log-message', { type: 'warn', msg: 'Link Pendentes não encontrado.' }); } catch (e2) {}
        }
      }

      await page.waitForTimeout(2000);
    }

    // Save storage state after successful navigation (cookies + localStorage)
    try {
      const session = pjeSessions.get(args && args.sessionId);
      if (session && session.context) {
        if (!fs.existsSync(PLAYWRIGHT_DIR)) fs.mkdirSync(PLAYWRIGHT_DIR, { recursive: true });
        await session.context.storageState({ path: PJE_STORAGE });
        try {
          const userDir = path.join(app.getPath('userData'), 'playwright-storage');
          if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
          await session.context.storageState({ path: path.join(userDir, 'pje.json') });
        } catch (e) {}
        try { event.sender.send('log-message', { type: 'info', msg: 'Sessão salva para próximas execuções. 💾' }); } catch (e) {}
      }
    } catch (e) {
      try { event.sender.send('log-message', { type: 'warn', msg: 'Não foi possível salvar sessão: ' + (e.message || e) }); } catch (e2) {}
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});

ipcMain.handle('pje:save-session', async (event, args) => {
  try {
    const session = pjeSessions.get(args && args.sessionId);
    if (!session || !session.context) return { ok: false, error: 'Sessão não encontrada' };
    if (!fs.existsSync(PLAYWRIGHT_DIR)) fs.mkdirSync(PLAYWRIGHT_DIR, { recursive: true });
    await session.context.storageState({ path: PJE_STORAGE });
    try {
      const userDir = path.join(app.getPath('userData'), 'playwright-storage');
      if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
      await session.context.storageState({ path: path.join(userDir, 'pje.json') });
    } catch (e) {}
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});

ipcMain.handle('pje:cancel-session', async (event, args) => {
  try {
    const session = pjeSessions.get(args && args.sessionId);
    if (session) {
      try { if (session.browser) await session.browser.close(); } catch (e) {}
      pjeSessions.delete(args.sessionId);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});
ipcMain.handle('pje:run-extraction', async (event, args) => {
  try {
    const session = pjeSessions.get(args && args.sessionId);
    if (!session || !session.page) return { ok: false, error: 'Sessão não encontrada' };

    const { page } = session;
    const script = args.script;
    const limit = args.limit || 5;
    const mergeChoice = args.mergeChoice !== undefined ? args.mergeChoice : 1;

    if (!script) return { ok: false, error: 'Script não fornecido' };

    const consoleHandler = (msg) => {
      try { event.sender.send('log-message', { type: msg.type(), msg: msg.text() }); } catch (e) {}
    };
    page.on('console', consoleHandler);

    try {
      // Open DevTools via CDP so the user can see execution in the console
      try {
        const cdpSession = await page.context().newCDPSession(page);
        await cdpSession.send('Runtime.evaluate', {
          expression: `window.__pje_origPrompt = window.prompt;
window.prompt = (msg) => {
  if (msg && msg.toLowerCase().includes('quantas')) return String(${limit});
  if (msg && msg.toLowerCase().includes('juntar')) return String(${mergeChoice || 1});
  return window.__pje_origPrompt ? window.__pje_origPrompt(msg) : prompt(msg);
};`,
          replMode: false,
          includeCommandLineAPI: true,
          userGesture: true
        });
      } catch (e) {
        // Fallback: inject prompt override via page.evaluate
        await page.evaluate((opts) => {
          window.__pje_origPrompt = window.prompt;
          window.PJE_PARAR = false;
          window.prompt = (msg) => {
            if (msg && msg.toLowerCase().includes('quantas')) return String(opts.limit);
            if (msg && msg.toLowerCase().includes('juntar')) return String(opts.mergeChoice);
            return window.__pje_origPrompt ? window.__pje_origPrompt(msg) : prompt(msg);
          };
        }, { limit, mergeChoice });
      }

      // Execute the script via page.evaluate (reliable for long-running scripts)
      await page.evaluate(async (scriptStr) => {
        window.PJE_PARAR = false;
        // Strip the outer IIFE wrapper and use AsyncFunction for proper awaiting
        const body = scriptStr
          .replace(/^window\.PJE_PARAR\s*=\s*false\s*;?\s*\n?/, '')
          .replace(/^\(async\s+function\s*\(\)\s*\{/, '')
          .replace(/\}\)\(\);\s*$/, '');
        const AsyncFunction = (async function(){}).constructor;
        const fn = new AsyncFunction(body);
        return await fn();
      }, script);

      return { ok: true };
    } finally {
      page.removeListener('console', consoleHandler);
    }
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});

ipcMain.handle('pje:stop-extraction', async (event, args) => {
  try {
    const session = pjeSessions.get(args && args.sessionId);
    if (session && session.page) {
      try { await session.page.evaluate(() => { window.PJE_PARAR = true; }); } catch (e) {}
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});
// --- End PJE DevTools Flow ---

// State helpers used by update routines
function readStateFile() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {};
  } catch (e) { console.error('readStateFile', e); }
  return {};
}

function writeStateFile(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8'); }
  catch (e) { console.error('writeStateFile', e); }
}

// --- Local app information ---
ipcMain.handle('get-app-version', async () => {
  try { return require(path.join(__dirname, 'package.json')).version || '0.0.0'; }
  catch (e) { return '0.0.0'; }
});

// Show Windows Native Notification for Subsidios
// Called from hub_subsidios.html when a new record is created for the current user's comarca
ipcMain.handle('show-notification', async (event, options) => {
  try {
    const { title, body, icon } = options;
    if (!title || !body) {
      return { ok: false, error: 'title_or_body_missing' };
    }

    // Use Electron's Notification API (Windows 10+ only)
    // Falls back gracefully on older systems
    const notification = new (require('electron').Notification)({
      title: title || '',
      body: body,
      icon: icon ? path.resolve(__dirname, icon) : undefined,
      urgency: 'normal'
    });

    notification.on('click', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      }
    });

    notification.show();
    return { ok: true };
  } catch (e) {
    console.warn('show-notification error (may be unsupported OS):', e.message);
    // Don't fail hard — just log warning
    return { ok: false, warn: e.message };
  }
});

// Generic open-external handler so renderers can request the main process to open URLs (safer)
ipcMain.handle('open-external', async (event, url) => {
  try {
    if (!url) return { ok: false, error: 'no_url' };
    // Try normal open
    const res = await shell.openExternal(url);
    // shell.openExternal may return false on some platforms/clients — attempt Windows fallback for mailto
    if ((res === false || res === 0) && process.platform === 'win32' && String(url).startsWith('mailto:')) {
      try {
        const { exec } = require('child_process');
        // Use cmd start to delegate to default mail client (works when shell.openExternal silently fails)
        const safe = String(url).replace(/"/g, '\\"');
        exec(`cmd /c start "" "${safe}"`, (err) => { if (err) console.error('open-external fallback exec error', err); });
        return { ok: true, fallback: true };
      } catch (e2) {
        console.error('open-external fallback error', e2);
        return { ok: false, error: e2 && e2.message ? e2.message : String(e2) };
      }
    }
    return { ok: true };
  } catch (e) {
    console.error('open-external', e);
    // On Windows try cmd fallback for mailto specifically
    try {
      if (process.platform === 'win32' && String(url).startsWith('mailto:')) {
        const { execSync } = require('child_process');
        const safe = String(url).replace(/"/g, '\\"');
        execSync(`cmd /c start "" "${safe}"`);
        return { ok: true, fallback: true };
      }
    } catch (e2) {
      console.error('open-external fallback sync error', e2);
      return { ok: false, error: e2 && e2.message ? e2.message : String(e2) };
    }
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});

// Create an Outlook compose window with HTML body on Windows using PowerShell + COM
ipcMain.handle('create-outlook-mail-html', async (event, args) => {
  try {
    if (process.platform !== 'win32') return { ok: false, error: 'not_windows' };
    const { html, subject, to } = args || {};
    if (!html) return { ok: false, error: 'no_html' };

    // Build PowerShell script to create an Outlook mail item with HTMLBody
    const safeSubject = String(subject || '').replace(/"/g, '""');
    const safeTo = String(to || '');
    const psScript = `try {
  $ol = New-Object -ComObject Outlook.Application
  $mail = $ol.CreateItem(0)
  $mail.To = "${safeTo}"
  $mail.Subject = "${safeSubject}"
  $mail.HTMLBody = @'
${html}
'@
  $mail.Display()
} catch { Write-Error $_ }
`;

    const tmp = path.join(os.tmpdir(), `extjt_mail_${Date.now()}.ps1`);
    // Write with BOM to help PowerShell interpret UTF-8 properly
    fs.writeFileSync(tmp, '\uFEFF' + psScript, 'utf8');
    // Execute asynchronously so UI is not blocked; remove tmp after spawn
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmp}"`, (err) => {
      try { fs.unlinkSync(tmp); } catch (e) {}
      if (err) console.error('create-outlook-mail-html exec error', err);
    });
    return { ok: true };
  } catch (e) {
    console.error('create-outlook-mail-html', e);
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});


// --- Login Logic ---
let currentUser = null; // Store user in memory

ipcMain.on('login-success', (event, user) => {
    console.log('Login success for:', user.email);
    currentUser = user; // Save for the main window
    
    if (mainWindow) {
        mainWindow.setSize(1200, 800);
        mainWindow.center();
        mainWindow.setResizable(true);
        mainWindow.loadFile(path.join('public', 'index.html'));
    }
});

ipcMain.handle('get-current-user', () => currentUser);
// ipcMain.handle('get-app-version', () => app.getVersion()); // Removed duplicate handler

ipcMain.on('update-user-cache', (event, user) => {
    currentUser = user;
    // Log role verification for debug
    if (user && user.role) console.log(`User cached with role: ${user.role}`);
});

function createWindow() {
  const state = readStateFile();
  const config = state.general || {};

  mainWindow = new BrowserWindow({
    width: 1000, // Initial size for login (can be smaller if desired, but 1000 is fine)
    height: 750,
    title: '',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'public', 'assets', 'icon_black.ico'),
    webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js')
    }
  });

  if (config.alwaysOnTop) {
      mainWindow.setAlwaysOnTop(true);
  }

  mainWindow.setMenu(null); // Remove o menu completamente
  
  // Enable DevTools via Shortcut (F12 or Ctrl+Shift+I) - TEMPORARY: Allow for all users during development
  mainWindow.webContents.on('before-input-event', (event, input) => {
      // Allow F12 or Ctrl+Shift+I
      if (input.type === 'keyDown') {
          if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
              // TEMP: Allow all authenticated users during development
              // TODO: Change back to admin-only after fixing role system
              mainWindow.webContents.toggleDevTools();
              event.preventDefault();
          }
      }
  });

  // Show a modal loading window using the new loading.html to act as the app-wide loader
  try {
    if (!loadingWindow || loadingWindow.isDestroyed()) {
      loadingWindow = new BrowserWindow({
        width: 880,
        height: 260,
        frame: false,
        resizable: false,
        modal: true,
        parent: mainWindow,
        show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true }
      });
      loadingWindow.loadFile(path.join(__dirname, 'public', 'loading.html')).catch(() => {});
      loadingWindow.once('ready-to-show', () => { try { loadingWindow.show(); } catch(e){} });
    }
  } catch (e) { console.error('loadingWindow create error', e); }

// Load main app instead of login screen
  mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));
  
  // Close behavior: Minimize to Tray if enabled
  mainWindow.on('close', (event) => {
      // Re-read strictly for closing logic
      const currentState = readStateFile();
      const currentConfig = currentState.general || {};

      if (currentConfig.minimizeToTray && !app.isQuitting) {
          event.preventDefault();
          mainWindow.hide();
          if (appTray) {
              appTray.displayBalloon({
                  title: '',
                  content: 'O aplicativo continua rodando em segundo plano.'
              });
          }
      }
      return false;
  });

  // Send initial automation status to renderer after load and close loader
  mainWindow.webContents.on('did-finish-load', () => {
    // Close modal loader if present
    try {
      if (loadingWindow && !loadingWindow.isDestroyed()) {
        try { loadingWindow.close(); } catch(e) {}
        loadingWindow = null;
      }
    } catch (e) { /* ignore */ }

    mainWindow.webContents.send('automation-status', global.isAutomationRunning || false);
  });
}

// Handler for frontend setting changes
ipcMain.handle('set-general-config', (event, newConfig) => {
    try {
        const state = readStateFile();
        state.general = { ...state.general, ...newConfig };
        
        if (mainWindow) {
            if (typeof newConfig.alwaysOnTop === 'boolean') {
                mainWindow.setAlwaysOnTop(newConfig.alwaysOnTop);
            }
        }
        
        writeStateFile(state);
        return { ok: true };
    } catch(e) {
        console.error('set-general-config error', e); 
        return { ok: false };
    }
});

ipcMain.handle('get-general-config', () => {
    const s = readStateFile();
    return s.general || { minimizeToTray: false, alwaysOnTop: false };
});

app.whenReady().then(async () => {

  try {
      // Tray Setup
      const iconPath = path.join(__dirname, 'public', 'assets', 'icon_black.ico');
      appTray = new Tray(iconPath);
      appTray.setToolTip('');
      
      const contextMenu = Menu.buildFromTemplate([
          { label: 'Abrir', click: () => { if(mainWindow) mainWindow.show(); } },
          { type: 'separator' },
          { label: 'Sair', click: () => { app.isQuitting = true; app.quit(); } }
      ]);
      
      appTray.setContextMenu(contextMenu);
      
      appTray.on('double-click', () => {
          if(mainWindow) mainWindow.show();
      });
  } catch(e) { console.error('Tray Init Error', e); }

  createWindow();

  // If we have a project-local PJE storage (for testing), seed the user's appData on first run so automation can reuse it immediately
  try {
    const localPje = path.join(__dirname, 'playwright-storage', 'pje.json');
    const userPjeDir = path.join(app.getPath('userData'), 'playwright-storage');
    const userPje = path.join(userPjeDir, 'pje.json');
    if (fs.existsSync(localPje) && !fs.existsSync(userPje)) {
      try {
        if (!fs.existsSync(userPjeDir)) fs.mkdirSync(userPjeDir, { recursive: true });
        fs.copyFileSync(localPje, userPje);
        console.log('Seeded userData PJE storage from project copy');
      } catch (e) { console.error('Error seeding userData PJE storage', e); }
    }
  } catch (e) { /* ignore */ }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Global renderer log forward handler (always active)
ipcMain.on('renderer-log', (e, { level, args }) => {
    try {
        console[level ? level : 'log']('[renderer]', ...(Array.isArray(args) ? args : []));
    } catch (_){ console.log('[renderer] (log error)', args); }
});

// --- History Service IPC Handlers ---
ipcMain.handle('history:get-records', (event, filter) => {
    return historyService.getRecords(filter || {});
});

ipcMain.handle('history:get-record', (event, id) => {
    return historyService.getRecord(id);
});

ipcMain.handle('history:delete-record', (event, id) => {
    return historyService.deleteRecord(id);
});

ipcMain.handle('history:clear', () => {
    historyService.clearHistory();
    return { ok: true };
});

ipcMain.handle('history:get-stats', () => {
    return historyService.getStats();
});

// Track current running execution for history
global._currentExecId = null;

ipcMain.handle('history:start', (event, record) => {
    const id = historyService.addRecord({
        type: record.type || 'unknown',
        status: 'running',
        args: record.args || {},
        logFile: record.logFile || null
    });
    global._currentExecId = id;
    return id;
});

// Aceita id explícito (execução paralela) ou recai no global _currentExecId.
// Chamada: history:finish(id, data)  ou  history:finish(data).
ipcMain.handle('history:finish', (event, idOrData, maybeData) => {
    let id = global._currentExecId;
    let data = idOrData;
    if (typeof idOrData === 'string') { id = idOrData; data = maybeData || {}; }
    if (!id) return false;
    const result = historyService.updateRecord(id, {
        status: (data && data.status) || 'success',
        finishedAt: new Date().toISOString(),
        files: (data && data.files) || [],
        error: (data && data.error) || null
    });
    if (id === global._currentExecId) global._currentExecId = null;
    return result;
});

// Backup: main process also finishes history directly (in case renderer navigated away)
process.on('automation-finished', (code) => {
    if (!global._currentExecId) return;
    console.log('[main] automation-finished event received, finishing history record');
    historyService.updateRecord(global._currentExecId, {
        status: code === 0 ? 'success' : 'error',
        finishedAt: new Date().toISOString()
    });
    global._currentExecId = null;
});

ipcMain.handle('history:add-log', (event, idOrEntry, maybeEntry) => {
    let id = global._currentExecId;
    let logEntry = idOrEntry;
    if (typeof idOrEntry === 'string') { id = idOrEntry; logEntry = maybeEntry || {}; }
    if (!id) return false;
    return historyService.addLog(id, logEntry);
});

// --- Queue Service IPC Handlers ---
ipcMain.handle('queue:add-job', (event, job) => {
    return queueService.addJob(job);
});

ipcMain.handle('queue:remove-job', (event, id) => {
    return queueService.removeJob(id);
});

ipcMain.handle('queue:get-jobs', (event, filter) => {
    return queueService.getJobs(filter || {});
});

ipcMain.handle('queue:clear-completed', () => {
    queueService.clearCompleted();
    return { ok: true };
});

ipcMain.handle('queue:get-stats', () => {
    return queueService.getStats();
});

// --- IPC Handler ---
ipcMain.on('run-script', async (event, args) => {
  console.log('[main] run-script invoked');
  // simple merge of global log dir state
  let state = {};
  try {
    if (fs.existsSync(STATE_FILE)) {
      state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) { console.error('Error reading state file:', e); }

  if (!args || typeof args !== 'object') args = {};
  if (state && state.globalLogDir) {
    args.globalLogDir = state.globalLogDir;
    console.log('Using Global Log Dir:', state.globalLogDir);
  }

  // always run external automation (no webview logic)
  automacaoService.runAutomation(event.sender, ipcMain, args);
});

// IPC handler to collect webview url and cookies in one shot
ipcMain.handle('collect-webview-state', async () => {
    try {
        if (!mainWindow || mainWindow.isDestroyed()) return { url: null, cookies: [] };
        // execute scripts in renderer context to get URL and webContentsId
        const url = await mainWindow.webContents.executeJavaScript(`(() => {
            const w = document.getElementById('integrated-webview');
            return w ? w.getURL() : null;
        })();`);
        const wcId = await mainWindow.webContents.executeJavaScript(`(() => {
            const w = document.getElementById('integrated-webview');
            return w ? w.getWebContentsId() : null;
        })();`);
        let cookies = [];
        if (wcId) {
            try {
                const wc = webContents.fromId(wcId);
                cookies = await wc.session.cookies.get({});
            } catch (e) {
                console.error('collect-webview-state cookie error', e);
            }
        }
        return { url, cookies };
    } catch (e) {
        console.error('collect-webview-state error', e);
        return { url: null, cookies: [] };
    }
});


ipcMain.on('run-archived-script', (event, args) => {
  let state = {};
  try {
    if (fs.existsSync(STATE_FILE)) {
      state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) { console.error('Error reading state file:', e); }

  if (!args || typeof args !== 'object') {
      args = {};
  }

  if (state && state.globalLogDir) {
       args.globalLogDir = state.globalLogDir;
       console.log('Using Global Log Dir (Archived):', state.globalLogDir);
  }

  // Executa a automação nativa (Node.js) -> Arquivados
  automacaoService.runArchivedAutomation(event.sender, ipcMain, args);
});

ipcMain.on('run-pje-script', (event, args) => {
    let state = {};
    try {
      if (fs.existsSync(STATE_FILE)) {
        state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      }
    } catch (e) { console.error('Error reading state file:', e); }

    if (!args || typeof args !== 'object') {
        args = {};
    }

    if (state && state.globalLogDir) {
        args.globalLogDir = state.globalLogDir;
        console.log('Using Global Log Dir (PJE):', state.globalLogDir);
    }
    
    // Executa a automação nativa (Node.js) -> PJE
    automacaoService.runPjeAutomation(event.sender, ipcMain, args);
});

// Test helper: show standalone loading screen (used by renderer via F5+B for visual check)
ipcMain.handle('show-loading-test', async () => {
  try {
    if (loadingWindow && !loadingWindow.isDestroyed()) {
      try { loadingWindow.show(); } catch (e) {}
      return { ok: true };
    }

    loadingWindow = new BrowserWindow({
      width: 880,
      height: 260,
      frame: false,
      resizable: false,
      modal: true,
      parent: mainWindow || undefined,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    loadingWindow.loadFile(path.join(__dirname, 'public', 'loading.html'))
      .catch(err => console.error('Loading test screen failed', err));

    loadingWindow.once('ready-to-show', () => {
      try { loadingWindow.show(); } catch (e) {}
    });

    // Auto-close after a short demo period
    setTimeout(() => {
      try {
        if (loadingWindow && !loadingWindow.isDestroyed()) loadingWindow.close();
      } catch (e) {}
      loadingWindow = null;
    }, 5000);

    loadingWindow.on('closed', () => { loadingWindow = null; });

    return { ok: true };
  } catch (e) {
    console.error('show-loading-test error', e);
    return { ok: false, error: e && e.message };
  }
});

// Show/hide global loading overlay inside the main window (for app-wide loading UI)
ipcMain.handle('show-loading-global', async () => {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: 'no_main_window' };
    const html = fs.readFileSync(path.join(__dirname, 'public', 'loading.html'), 'utf8');
    // Inject HTML into renderer safely via executeJavaScript
    await mainWindow.webContents.executeJavaScript(`(function(html){
      try{
        const existing = document.getElementById('global-loading-overlay');
        if(existing) existing.remove();
        const wrapper = document.createElement('div');
        wrapper.id = 'global-loading-overlay';
        wrapper.style.position = 'fixed'; wrapper.style.left='0'; wrapper.style.top='0'; wrapper.style.right='0'; wrapper.style.bottom='0';
        wrapper.style.zIndex = '999999';
        wrapper.innerHTML = html;
        document.body.appendChild(wrapper);
        // Small auto-progress hint
        try{ const pb = wrapper.querySelector('#progressBar'); if(pb) pb.style.width = '92%'; } catch(e){}
      }catch(e){ console.error('inject loading overlay error', e); }
    })(${JSON.stringify(html)});`);
    return { ok: true };
  } catch (e) { console.error('show-loading-global error', e); return { ok: false, error: e && e.message }; }
});

ipcMain.handle('hide-loading-global', async () => {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: 'no_main_window' };
    await mainWindow.webContents.executeJavaScript(`(function(){ try{ const el = document.getElementById('global-loading-overlay'); if(el) el.remove(); }catch(e){} })();`);
    return { ok: true };
  } catch (e) { console.error('hide-loading-global error', e); return { ok: false, error: e && e.message }; }
});

ipcMain.on('skip-pje-script', (event) => {
    automacaoService.skipCurrentStep(event.sender);
});

ipcMain.on('stop-script', (event) => {
    automacaoService.stopAutomation(event.sender);
    event.sender.send('log-message', 'Processo de parada iniciado...');
    
    // Resetar UI após delay
    setTimeout(() => {
        event.sender.send('script-finished', 1);
    }, 2000);
});

// Mapeamento de Entrada do Usuário
// O front-end envia 'send-input' quando clica em CONFIRMAR
ipcMain.on('send-input', (event, input) => {
    // Repassa como evento interno que o automacao_service está esperando
    // O service espera 'user-confirm-input'
    console.log("Recebido input do usuário, repassando...");
    ipcMain.emit('user-confirm-input');
});

ipcMain.on('pje-input-response', (event, response) => {
    console.log("Recebido resposta PJE:", response);
    ipcMain.emit('pje-input-received', response);
});

ipcMain.handle('dialog:openDirectory', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
        properties: ['openDirectory']
    });
    if (canceled) {
        return null;
    } else {
        return filePaths[0];
    }
});

// --- Protocolos Postais (app Python empacotado, abre como janela separada) ---
// O app vive na pasta "Externo". Não há opção de selecionar caminho:
// ele é localizado automaticamente em (1) pasta de instalação, (2) recursos
// empacotados, (3) pasta raiz do projeto em desenvolvimento.
function findProtocolosPostaisExe() {
    const REL = ['Externo', 'ProtocolosPostais', 'ProtocolosPostais.exe'];
    const candidates = [];

    // 1) Instalado — o instalador cria Externo/ProtocolosPostais no diretório de instalação
    try {
        if (process.execPath) candidates.push(path.join(path.dirname(process.execPath), ...REL));
    } catch (e) {}

    // 2) Empacotado dentro do app (process.resourcesPath)
    try {
        candidates.push(path.join(process.resourcesPath, ...REL));
    } catch (e) {}

    // 3) Em desenvolvimento — pasta raiz do projeto
    try {
        candidates.push(path.join(__dirname, ...REL));
    } catch (e) {}

    for (const c of candidates) {
        try { if (c && fs.existsSync(c)) return c; } catch (e) {}
    }
    return null;
}

ipcMain.handle('protocolos:get-status', async () => {
    const exe = findProtocolosPostaisExe();
    return { found: !!exe, path: exe || null };
});

ipcMain.handle('protocolos:open', async (event) => {
    try {
        const exe = findProtocolosPostaisExe();
        if (!exe) return { ok: false, error: 'Aplicativo não encontrado. Reinstale o app.' };
        // Abre como processo filho separado (cwd = pasta do exe para o app achar config.json)
        const child = require('child_process').spawn(exe, [], {
            detached: true,
            stdio: 'ignore',
            cwd: path.dirname(exe)
        });
        child.unref();
        return { ok: true, path: exe };
    } catch (e) {
        return { ok: false, error: e.message || String(e) };
    }
});

// Native OS dialogs (so they appear as real OS windows, not in-page overlays)
ipcMain.handle('dialog:alert', async (event, message, title = '') => {
    const win = BrowserWindow.fromWebContents(event.sender);
    await dialog.showMessageBox(win, {
        type: 'info',
        buttons: ['OK'],
        defaultId: 0,
        title,
        message: String(message)
    });
});

ipcMain.handle('dialog:confirm', async (event, message, title = '') => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Cancelar', 'OK'],
        defaultId: 1,
        cancelId: 0,
        title,
        message: String(message)
    });
    return response === 1;
});

// Return the current URL loaded inside the integrated webview (renderer side)
ipcMain.handle('get-webview-url', async () => {
    try {
        if (mainWindow && !mainWindow.isDestroyed()) {
            const script = `(() => {
                const w = document.getElementById('integrated-webview');
                return w ? w.getURL() : null;
            })();`;
            return await mainWindow.webContents.executeJavaScript(script);
        }
    } catch (e) {
        console.error('get-webview-url error', e);
    }
    return null;
});

// ============================================================================
// PROTOCOLOS POSTAIS — Página nativa (JS port)
// ============================================================================
const proto = require('./src/protocolos/process');
const protoConfig = require('./src/protocolos/config_loader');
const { Worker } = require('worker_threads');
const protoWorkers = new Set();

const protoState = {
    cancelled: false,
};

function protoWin(event) {
    try { return BrowserWindow.fromWebContents(event.sender); } catch (e) { return null; }
}
function protoSend(win, channel, payload) {
    try { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); } catch (e) {}
}

// Finaliza o registro de histórico de protocolos no processo principal. Isso
// garante que o registro não fique "running" se o renderer navegar (a página
// antiga morre e seu closure de history:finish nunca roda).
function finishProtoHistory(execId, out) {
    if (!execId) return false;
    const cancelled = !!protoState.cancelled;
    const status = cancelled ? 'stopped' : (out && out.ok ? 'success' : 'error');
    const count = (out && out.results && out.results.length) || 0;
    return historyService.updateRecord(execId, {
        status,
        finishedAt: new Date().toISOString(),
        files: count ? [String(count) + ' registro(s)'] : [],
        error: cancelled ? 'Cancelado pelo usuário' : (out && out.ok ? null : ((out && out.error) || 'Erro no processamento de protocolos')),
    });
}

// Executa o pipeline em worker_thread (main nunca bloqueia).
function runProtoWorker(win, kind, opts) {
    return new Promise((resolve) => {
        let w = null;
        try {
            w = new Worker(require('path').join(__dirname, 'src', 'protocolos', 'worker.js'));
        } catch (e) {
            resolve({ ok: false, error: 'Falha ao iniciar worker: ' + (e.message || e) });
            return;
        }
        protoWorkers.add(w);
        const timeout = setTimeout(() => { finish({ ok: false, error: 'Timeout no processamento (15 min)' }); }, 900000);
        function finish(res) {
            clearTimeout(timeout);
            protoWorkers.delete(w);
            try { w.terminate(); } catch (e) {}
            resolve(res);
        }
        w.on('message', async (m) => {
            if (!m || typeof m !== 'object') return;
            if (m.type === 'log') protoSend(win, 'proto:log', m.payload);
            else if (m.type === 'progress') protoSend(win, 'proto:progress', m.payload);
            else if (m.type === 'done') {
                finish({ ok: m.payload.ok, results: m.payload.results || [], errorRows: m.payload.errorRows || [], totalSec: m.payload.totalSec || 0, error: m.payload.error });
            }
        });
        w.on('error', (e) => {
            finish({ ok: false, error: (e && e.stack) || String(e) });
        });
        w.postMessage({ type: kind, opts });
    });
}

protoConfig.loadConfig();

// Config (usuario/mascara senha/pasta)
ipcMain.handle('proto:config', async (event) => {
    const cfg = protoConfig.loadConfig();
    return {
        user: cfg.user || '',
        pwd: cfg.pwd ? '********' : '',
        pwdSet: !!cfg.pwd,
        output_folder: cfg.output_folder || '',
    };
});

ipcMain.handle('proto:save-config', async (event, data = {}) => {
    const cfg = protoConfig.loadConfig();
    if (typeof data.user === 'string') cfg.user = data.user;
    if (typeof data.pwd === 'string' && data.pwd && data.pwd !== '********') cfg.pwd = data.pwd;
    if (typeof data.output_folder === 'string' && data.output_folder) cfg.output_folder = data.output_folder;
    const res = protoConfig.saveConfig(cfg);
    return res.ok ? { ok: true } : { ok: false, error: res.error };
});

// Dialogo de selecao de pasta
ipcMain.handle('proto:pick-folder', async (event, folder = '') => {
    const win = protoWin(event);
    const r = await dialog.showOpenDialog(win, {
        title: 'Selecionar pasta de destino',
        defaultPath: folder || undefined,
        properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
});

// Dialogo de selecao de arquivos PDF
ipcMain.handle('proto:pick-files', async (event, folder = '') => {
    const win = protoWin(event);
    const r = await dialog.showOpenDialog(win, {
        title: 'Selecione arquivos PDF',
        defaultPath: folder || undefined,
        filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
        properties: ['openFile', 'multiSelections'],
    });
    if (r.canceled || !r.filePaths.length) return [];
    return r.filePaths;
});

// Dialogo de salvar planilha
ipcMain.handle('proto:save-file', async (event, opts = {}) => {
    const win = protoWin(event);
    const r = await dialog.showSaveDialog(win, {
        title: 'Exportar planilha',
        defaultPath: opts.defaultPath,
        filters: [{ name: 'Excel', extensions: ['xlsx'] }],
    });
    if (r.canceled || !r.filePath) return null;
    return r.filePath;
});

// Processar arquivos PDF
ipcMain.handle('proto:process-files', async (event, opts) => {
    const win = protoWin(event);
    protoState.cancelled = false;
    let out;
    try {
        out = await runProtoWorker(win, 'process-files', {
            files: opts.files || [],
            outputFolder: opts.output_folder || '',
            user: opts.user || '',
            pwd: opts.pwd || '',
            headless: opts.headless !== false,
            modoAgencia: !!opts.modo_agencia,
        });
    } catch (e) {
        out = { ok: false, error: e.message || String(e) };
    }
    // Finaliza o registro no main (sobrevive à navegação do renderer) e avisa a
    // página — mesmo se ela foi recarregada durante o processamento.
    finishProtoHistory(opts.execId || null, out);
    protoSend(win, 'proto:done', out);
    return out;
});

// Consultar NPUs (modo consulta)
ipcMain.handle('proto:consultar-npus', async (event, opts) => {
    const win = protoWin(event);
    protoState.cancelled = false;
    let out;
    try {
        out = await runProtoWorker(win, 'consultar-npus', {
            npus: opts.npus || [],
            comarcas: opts.comarcas || [],
            outputFolder: opts.output_folder || '',
            user: opts.user || '',
            pwd: opts.pwd || '',
            headless: opts.headless !== false,
        });
    } catch (e) {
        out = { ok: false, error: e.message || String(e) };
    }
    finishProtoHistory(opts.execId || null, out);
    protoSend(win, 'proto:done', out);
    return out;
});

// Exportar XLSX (3 abas)
ipcMain.handle('proto:export-file', async (event, payload) => {
    try {
        const { results = [], filename = '', data_intimacao = '' } = payload || {};
        if (!filename) return { ok: false, error: 'Pasta de destino não definida.' };
        await proto.exportToExcel(results, filename, data_intimacao);
        return { ok: true, path: filename };
    } catch (e) {
        return { ok: false, error: e.message || String(e) };
    }
});

ipcMain.handle('proto:cancel', async (event) => {
    protoState.cancelled = true;
    for (const w of protoWorkers) {
        try { w.postMessage({ type: 'cancel' }); } catch (e) {}
    }
    return { ok: true };
});
