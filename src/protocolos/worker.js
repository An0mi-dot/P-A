// Pipeline de Protocolos Postais executado em worker_thread — mantém o
// processo principal do Electron livre (UI nunca trava) e permite log/progresso
// em tempo real.
'use strict';

const { parentPort } = require('worker_threads');
const proc = require('./process');

let cancelled = false;

function post(type, payload) {
  try { parentPort.postMessage({ type, payload }); } catch (e) {}
}

async function run(kind, opts) {
  const ctx = {
    shouldCancel: () => cancelled,
    log: (level, msg) => post('log', { level, msg }),
    progress: (pct) => post('progress', pct),
  };
  try {
    if (kind === 'consultar-npus') {
      const out = await proc.consultarNpus(ctx, opts);
      post('done', { ok: true, results: out.results, totalSec: out.totalSec });
    } else {
      const out = await proc.processFiles(ctx, opts);
      post('done', { ok: true, results: out.results, errorRows: out.errorRows, totalSec: out.totalSec });
    }
  } catch (e) {
    post('done', { ok: false, error: (e && e.stack) || String(e) });
  }
}

if (parentPort) {
  parentPort.on('message', (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'cancel') { cancelled = true; return; }
    if (m.type === 'process-files' || m.type === 'consultar-npus') {
      cancelled = false;
      run(m.type, m.opts || {});
    }
  });
}