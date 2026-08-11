// Motor de extração delegado ao app Python (ProtocolosPostais.exe) em modo
// headless. O Python é a fonte da verdade para NPU/AR (10/10 no PDF de
// referência); este módulo apenas spawna o exe, passa a lista de PDFs via
// --request, e lê o JSON de saída (--out). Espaider/Excel/cópia continuam no
// lado JS. Nenhum nome de fornecedor de OCR aparece aqui.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const config = require('./config_loader');

const BIN_NAME = 'ProtocolosPostais.exe';
const TIMEOUT_MS = 12 * 60 * 1000; // 12 min por lote

function candidateBins() {
  const list = [];
  // Dev — pasta Externo/ProtocolosPostais (o config pode vir do userData)
  list.push(path.join(__dirname, '..', '..', 'Externo', 'ProtocolosPostais', BIN_NAME));
  try {
    if (process.resourcesPath) list.push(path.join(process.resourcesPath, 'Externo', 'ProtocolosPostais', BIN_NAME));
  } catch (e) {}
  try {
    if (process.execPath) list.push(path.join(path.dirname(process.execPath), 'Externo', 'ProtocolosPostais', BIN_NAME));
  } catch (e) {}
  return list;
}

// Resolve o executável do motor Python. Prioridade: bin configurado em
// config.json (python_engine.exe), depois os candidatos padrão.
function findEngine() {
  try {
    const cfg = config.loadConfig();
    if (cfg.python_engine) {
      if (cfg.python_engine.enabled === false) return null;
      if (cfg.python_engine.exe && fs.existsSync(cfg.python_engine.exe)) {
        return { type: 'exe', cmd: cfg.python_engine.exe };
      }
    }
  } catch (e) {}
  for (const p of candidateBins()) {
    try {
      if (p && fs.existsSync(p)) return { type: 'exe', cmd: p };
    } catch (e) {}
  }
  return null;
}

// Roda o motor Python headless sobre uma lista de arquivos e devolve o
// payload JSON lido do arquivo --out. Se não achar o exe, resolve falho.
function extract(fileList, { modoAgencia = false, configPath = '', onLog = () => {}, timeoutMs = TIMEOUT_MS } = {}) {
  const engine = findEngine();
  if (!engine) return Promise.resolve({ ok: false, error: 'executável do motor Python não encontrado' });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proto_engine_'));
  const requestFile = path.join(tmpDir, 'request.json');
  const outFile = path.join(tmpDir, 'out.json');

  const payload = { pdfs: fileList, modo_agencia: !!modoAgencia, out: outFile };
  let cfgPath = configPath || config.findConfigPath() || '';
  // A api_key no config em disco pode estar cifrada (key-protect). O Python não
  // tem lib de criptografia, então o JS decripta e grava um config temporário
  // (deletado no final do lote) com a chave em texto puro para o exe ler via
  // PROTOCOLOS_CONFIG. Nunca persiste a chave em disco além do tmpdir efêmero.
  try {
    const cfgAll = config.loadConfig() || {};
    const rawKey = cfgAll.api_key || '';
    if (rawKey) {
      const kp = require('./key-protect');
      const plainKey = kp.isEncrypted(rawKey) ? kp.decrypt(rawKey) : rawKey;
      const tmpCfg = Object.assign({}, cfgAll, { api_key: plainKey });
      const tmpCfgPath = path.join(tmpDir, 'config.json');
      fs.writeFileSync(tmpCfgPath, JSON.stringify(tmpCfg), 'utf-8');
      cfgPath = tmpCfgPath;
    }
  } catch (e) {}
  if (cfgPath) payload.config = cfgPath;
  fs.writeFileSync(requestFile, JSON.stringify(payload), 'utf-8');

  try { fs.rmSync(outFile, { force: true }); fs.rmSync(outFile + '.tmp', { force: true }); } catch (e) {}

  return new Promise((resolve) => {
    // Além do config temporário, também injeta via env (exe atualizados leem
    // os.environ['PROTOCOLOS_API_KEY']).
    const childEnv = { ...process.env };
    try {
      const kp = require('./key-protect');
      const raw = (config.loadConfig() || {}).api_key || '';
      const plain = raw && kp.isEncrypted(raw) ? kp.decrypt(raw) : raw;
      if (plain) childEnv.PROTOCOLOS_API_KEY = plain;
    } catch (e) {}
    const child = spawn(engine.cmd, ['--request', requestFile], {
      cwd: path.dirname(engine.cmd),
      windowsHide: true,
      env: childEnv,
    });

    let stderr = '';
    child.stdout.on('data', (d) => {
      for (const line of d.toString().split('\n')) {
        const t = line.trim();
        if (!t) continue;
        // Filtra o progresso "\r spinner" e o status HTTP do OCR remoto —
        // o painel mostra só "→ Lendo via OCR...".
        if (/aguardando\.\.\.$/.test(t) || /HTTP \d+|falhou:|timeout$/i.test(t)) continue;
        onLog('dim', t.replace(/\r/g, ''));
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch (e) {}
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
      resolve({ ok: false, error: `timeout after ${Math.round(timeoutMs / 60000)} min -- python engine stalled` });
    }, timeoutMs);

    const done = (out) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
      resolve(out);
    };

    child.on('error', (err) => done({ ok: false, error: String(err) }));
    child.on('exit', (code) => {
      try {
        if (fs.existsSync(outFile)) {
          done(JSON.parse(fs.readFileSync(outFile, 'utf8')));
        } else {
          done({ ok: false, error: `motor Python terminou sem saída (exit ${code}): ${String(stderr).slice(0, 500)}` });
        }
      } catch (e) {
        done({ ok: false, error: 'falha ao parsear saída do motor Python: ' + e });
      }
    });
  });
}

module.exports = { findEngine, extract };