// Localiza/lê/grava o config.json do Protocolos Postais dentro do EXTRATJUD.
// Dev: EXTRATJUD/Externo/ProtocolosPostais/config.json
// Empacotado: <resources>/Externo/ProtocolosPostais/config.json
'use strict';

const fs = require('fs');
const path = require('path');

function candidatePaths() {
  const list = [];
  // 1) Cópia por-máquina (userData) — gravável mesmo quando o config do deploy
  //    é somente leitura (Program Files). Priorizada: guarda credenciais do
  //    usuário local e nunca é sobrescrita por atualizações do instalador.
  try {
    const { app } = require('electron');
    if (app && app.getPath) list.push(path.join(app.getPath('userData'), 'protocolos_config.json'));
  } catch (e) {}
  // 2) Raiz do projeto (P-A/config.json)
  list.push(path.join(__dirname, '..', '..', 'config.json'));
  // 3) Dev — pasta Externo do projeto
  list.push(path.join(__dirname, '..', '..', 'Externo', 'ProtocolosPostais', 'config.json'));
  // 4) Empacotado (extraResources) — resourcesPath
  try {
    if (process.resourcesPath) list.push(path.join(process.resourcesPath, 'Externo', 'ProtocolosPostais', 'config.json'));
  } catch (e) {}
  // 4) Pasta de instalação (mesmo diretório do exe do EXTRATJUD)
  try {
    if (process.execPath) list.push(path.join(path.dirname(process.execPath), 'Externo', 'ProtocolosPostais', 'config.json'));
  } catch (e) {}
  // 5) userData (fallback final de gravação)
  try {
    const { app } = require('electron');
    if (app && app.getPath && list.indexOf(path.join(app.getPath('userData'), 'protocolos_config.json')) === -1) {
      list.push(path.join(app.getPath('userData'), 'protocolos_config.json'));
    }
  } catch (e) {}
  return list;
}

function findConfigPath() {
  for (const p of candidatePaths()) {
    try { if (p && fs.existsSync(p)) return p; } catch (e) {}
  }
  return candidatePaths()[0];
}

function loadConfig() {
  try {
    const p = findConfigPath();
    if (p && fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {}
  return {};
}

function userConfigPath() {
  try {
    const { app } = require('electron');
    if (app && app.getPath) return path.join(app.getPath('userData'), 'protocolos_config.json');
  } catch (e) {}
  return path.join(__dirname, '..', '..', 'Externo', 'ProtocolosPostais', 'config.json');
}

// Grava na cópia por-máquina (userData): funciona mesmo quando o config
// embutido (instalação/extraResources) é somente leitura.
function saveConfig(cfg) {
  const p = userConfigPath();
  try {
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf-8');
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function projectRoot() {
  try {
    const p = findConfigPath();
    if (p) return path.dirname(p);
  } catch (e) {}
  return __dirname;
}

function defaultOutputFolder() {
  const cfg = loadConfig();
  return cfg.output_folder || '';
}

module.exports = { candidatePaths, findConfigPath, loadConfig, saveConfig, projectRoot, defaultOutputFolder };