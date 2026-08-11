// OCR: Tesseract.js local (multi-engine) + OCR remoto via serviço externo (estruturado/texto/AR).
// IMPORTANTE: o fornecedor do OCR remoto não deve ser mencionado em logs/UI (sigilo).
// Port fiel de src/extractor.py (funções _ocr_*, _has_key_fields, _score, _remote_*).
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const pdf = require('./pdf');
const img = require('./image');
const ex = require('./extractor');

// tessdata do OCR nativo (mesmo modelo por+eng usado pelo Python).
const TESSDATA = path.join(__dirname, 'tessdata');

function _cpus() {
  return typeof os.availableParallelism === 'function' ? os.availableParallelism() : 4;
}

// ---- OCR local NATIVO (tesseract.exe, como o Python) -------------------------
// O JS passa a chamar o MESMO binário do tesseract que o _ocr_tesseract do Python
// usa (extractor.py:254: '--oeem 1 --psm 6 -l por+eng'), em vez do WASM tesseract.js.
// Isso dá: mesma acuária (NPUs lidos a 400dpi), mesma velocidade, mesmo fluxo
// (soft -> full -> aggressive p/ local). Não faz downscale de DPI: nativo é rápido.

let _nativeCmd = null;
function _findNativeTesseract() {
  if (_nativeCmd) return _nativeCmd;
  let cfg = {};
  try { cfg = require('./config_loader').loadConfig() || {}; } catch (e) {}
  if (cfg && cfg.tesseract_cmd) _nativeCmd = cfg.tesseract_cmd;
  const user = process.env.USERPROFILE || '';
  const candidates = [
    _nativeCmd,
    process.env.TESSERACT_CMD,
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Tesseract-OCR', 'tesseract.exe'),
    'C:\\Program Files\\Tesseract-OCR\\tesseract.exe',
    'C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe',
    // bundle do app Python (fallback nesta máquina)
    path.join(user, 'Desktop', 'PROG', 'protocolos_postais', 'bin', 'tesseract', 'tesseract.exe'),
    path.join(user, 'Desktop', 'PROG', 'protocolos_postais', 'dist', 'ProtocolosPostais', '_internal', 'bin', 'tesseract', 'tesseract.exe'),
  ];
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) { _nativeCmd = c; return c; } } catch (e) {}
  }
  _nativeCmd = null;
  return null;
}

// Roda o tesseract nativo numa imagem já pré-processada. Retorna o texto.
// args[0]: caminho do PNG temporário. Usa a mesquida config do Python.
function _runNativeTesseract(pngBuffer, tessdataDir) {
  const exe = _findNativeTesseract();
  if (!exe) return Promise.resolve(''); // sem binário -> caller usa fallback
  const base = path.join(os.tmpdir(), 'tess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
  const pngPath = base + '.png';
  return new Promise((resolve) => {
    fs.writeFile(pngPath, pngBuffer, (werr) => {
      if (werr) { resolve(''); return; }
      const args = [pngPath, 'stdout', '--tessdata-dir', tessdataDir, '--oem', '1', '--psm', '6', '-l', 'por+eng'];
      execFile(exe, args, { cwd: path.dirname(exe), maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
        // limpa temp (best-effort)
        try { fs.unlinkSync(pngPath); } catch (e) {}
        try { fs.unlinkSync(base + '.txt'); } catch (e) {}
        if (err) { resolve(''); return; }
        resolve(stdout || '');
      });
    });
  });
}

// Port de _ocr_tesseract (preprocess: full|soft|aggressive|none) — via binário nativo.
// Páginas processadas em paralelo com teto min(4, n) (igual ao Python.
async function ocrTesseract(images, preprocess = 'full', onPage) {
  const n = images.length;
  if (n === 0) return '';
  const prepFn = { full: img.preprocessFull, soft: img.preprocessSoft, aggressive: img.preprocessAggressive, none: (x) => x }[preprocess] || img.preprocessFull;
  const output = new Array(n);
  const concurrency = Math.max(1, Math.min(4, n, _cpus()));
  let next = 0;
  const workOne = async (i) => {
    const image = images[i];
    let text = '';
    try {
      const processed = prepFn(image);       // MESMO pré-processamento do Python
      text = await _runNativeTesseract(pdf.toPng(processed), TESSDATA);
    } catch (e) {
      text = '';
    }
    if (!text) {
      // fallback: sem config (como pytesseract.image_to_string(img) no Python)
      try { text = await _runNativeTesseract(pdf.toPng(image), TESSDATA); } catch (e) { text = ''; }
    }
    output[i] = text || '';
    if (onPage) { try { onPage(i + 1, n); } catch (e) {} }
  };
  const workers = [];
  for (let w = 0; w < concurrency; w++) {
    workers.push((async () => {
      while (next < n) await workOne(next++);
    })());
  }
  await Promise.all(workers);
  return output.join('\n');
}

async function ocrTesseractSingle(image, preprocess = 'full') {
  return ocrTesseract([image], preprocess);
}

// Port de _has_key_fields
function hasKeyFields(text) {
  if (!text || text.trim().length < 200) return false;
  const hasNpu = /\d{7}[\s\-\.]\d{2}[\s\-\.]\d{4}/.test(text);
  const hasComarca = /CEP\s*\d|VSJE|VARA\s/i.test(text);
  const hasParte = /PARTE\(S\)/i.test(text);
  return hasNpu && hasComarca && hasParte;
}

// Port do _score interno de _ocr_multi_engine
function scoreText(text) {
  let s = text.trim().length;
  if (/\d{7}[\s\-\.]\d{2}[\s\-\.]\d{4}/.test(text)) s += 500;
  if (/PARTE\(S\)/i.test(text)) s += 300;
  if (/AUDI[ÊE]NCIA/i.test(text)) s += 300;
  if (/CEP/i.test(text)) s += 200;
  if (/YH\s*\d/i.test(text)) s += 400;
  return s;
}

// Port de _ocr_multi_engine (sem EasyOCR — indisponível no build JS)
async function ocrMultiEngine(images, onPage) {
  const results = []; // [{text, desc}]
  const t1 = await ocrTesseract(images, 'soft', onPage);
  if (t1.trim()) {
    if (hasKeyFields(t1)) return t1;
    results.push([t1, 'tesseract-soft']);
  }
  const t2 = await ocrTesseract(images, 'full', onPage);
  if (t2.trim()) {
    if (hasKeyFields(t2)) return t2;
    results.push([t2, 'tesseract-full']);
  }
  // Passo 3 era EasyOCR — indisponível; pula.
  if (!results.length) {
    const t4 = await ocrTesseract(images, 'aggressive', onPage);
    if (t4.trim()) results.push([t4, 'tesseract-aggressive']);
  }
  if (!results.length) return '';
  let best = results[0];
  for (const r of results) if (scoreText(r[0]) > scoreText(best[0])) best = r;
  return best[0];
}

// --- OCR remoto (serviço externo) ---

const REMOTE_MODELS = [
  ['modelo-01', 'gemini-2.5-flash-lite'],
  ['modelo-02', 'gemini-flash-latest'],
  ['modelo-03', 'gemini-2.0-flash'],
];
let lastWorkingModel = null;

// Hook opcional de log (ligado pelo orquestrador) p/ dar visibilidade ao OCR remoto
let _logHook = null;
function setOcrLogHook(fn) { _logHook = fn; }
function _log(level, msg) { if (_logHook) { try { _logHook(level, msg); } catch (e) {} } }

function readApiKey() {
  try {
    const fs = require('fs');
    // Prioridade: config da cópia userData guarda api_key cifrada e pode
    // apontar para protocolos_config.json (não config.json). Usa loadConfig()
    // que varre os caminhos candidatos.
    const cfg = require('./config_loader').loadConfig() || {};
    const value = cfg.api_key || '';
    const kp = require('./key-protect');
    return kp.isEncrypted(value) ? kp.decrypt(value) : value;
  } catch (e) {}
  return '';
}

// request com timeout via Electron net (proxy corporativo nativo).
// Em worker_thread (pipeline off-main), o request é delegado ao processo
// principal via mensagem 'remote'/'remote-result' (worker.ts só existe lá).
const { isMainThread, parentPort } = require('worker_threads');
let _reqSeq = 0;
const _pending = new Map();

function _registerRemoteListener() {
  if (isMainThread || !parentPort) return;
  if (_registerRemoteListener.done) return;
  _registerRemoteListener.done = true;
  parentPort.on('message', (m) => {
    if (m && m.type === 'remote-result') {
      const cb = _pending.get(m.id);
      if (cb) { _pending.delete(m.id); cb(m.payload); }
    }
  });
}
_registerRemoteListener();

async function _fetchJson(url, opts, timeoutMs) {
  if (isMainThread) {
    try {
      const { net } = require('electron');
      if (net && net.fetch) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const resp = await net.fetch(url, { ...opts, signal: controller.signal });
        clearTimeout(timer);
        const raw = await resp.text();
        let j = null;
        try { j = JSON.parse(raw); } catch (e) { j = {}; }
        return { __status: resp.status, ...(j || {}) };
      }
    } catch (e) {
    }
    // Fallback: fetch global (Node 18+/Electron) — sem proxy corporativo.
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const resp = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(timer);
      const raw = await resp.text();
      let j = null;
      try { j = JSON.parse(raw); } catch (e) { j = {}; }
      return { __status: resp.status, ...(j || {}) };
    } catch (e) {
      return null;
    }
  }
  // Worker: round-trip para o processo principal (onde net.fetch existe).
  // Timeout local garantido: se o main não responder, resolve null em vez de
  // travar o pipeline em silêncio (causa raiz do "travou ~27s sem log").
  return new Promise((resolve) => {
    const id = 'r' + (++_reqSeq);
    const timer = setTimeout(() => {
      if (_pending.has(id)) { _pending.delete(id); resolve(null); }
    }, timeoutMs + 5000);
    _pending.set(id, (payload) => { clearTimeout(timer); resolve(payload); });
    parentPort.postMessage({ type: 'remote', payload: { id, url, opts, timeoutMs } });
  });
}

async function remoteRequest(payload, apiKey = '', timeoutMs = 45000) {
  if (!apiKey) apiKey = readApiKey();
  if (!apiKey) return '';
  const models = [...REMOTE_MODELS];
  if (lastWorkingModel) {
    const idx = models.findIndex(([, m]) => m === lastWorkingModel);
    if (idx > 0) models.unshift(models.splice(idx, 1)[0]);
  }
  for (const [, apiModel] of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${apiModel}:generateContent?key=${apiKey}`;
    try {
      const data = await _fetchJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }, timeoutMs);
      if (!data) { continue; }
      if (data.__status === 200) {
        const candidates = data && data.candidates;
        if (candidates && candidates.length) {
          const text = (candidates[0].content && candidates[0].content.parts && candidates[0].content.parts[0] && candidates[0].content.parts[0].text) || '';
          if (text) {
            lastWorkingModel = apiModel;
            return text;
          }
        }
        continue;
      }
      continue;
    } catch (e) {
      continue;
    }
  }
  return '';
}

// Port de _ocr_remote (texto exato de todas as páginas)
async function ocrRemote(images, apiKey = '') {
  if (!apiKey) apiKey = readApiKey();
  if (!apiKey) return '';
  const parts = [];
  for (const image of images) {
    const jpeg = encodeJpegResized(image, 1600, 85);
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: jpeg } });
  }
  const prompt = 'Extraia TODO o texto visivel EXATAMENTE como escrito neste documento juridico (protocolo postal). '
    + 'Este documento pode conter VARIOS protocolos empilhados. Cada protocolo comeca com um numero NPU '
    + '(formato NNNNNNN-NN.AAAA.8.05.NNNN) e termina com um codigo AR (formato YH mais 9 digitos mais BR).\n\n'
    + 'REGRAS:\n - Preserve a SEPARACAO entre protocolos. Nao misture informacoes de um protocolo com outro.\n'
    + ' - Mantenha numeros, nomes, datas e enderecos exatamente como escritos.\n'
    + ' - Retorne APENAS o texto encontrado, sem comentarios.';
  parts.push({ text: prompt });
  const timeoutMs = Math.max(45000, 12000 * images.length);
  return remoteRequest({ contents: [{ parts }] }, apiKey, timeoutMs);
}

function encodeJpegResized(image, maxDim, quality) {
  let img = image;
  const w = img.width, h = img.height;
  const scale = Math.min(maxDim / Math.max(w, h), 1.0);
  if (scale < 1.0) img = pdf.resizeImage(img, Math.round(w * scale), Math.round(h * scale));
  return pdf.toJpeg(img, quality).toString('base64');
}

function encodeJpegCropBottom(image, maxDim, quality) {
  const w = image.width, h = image.height;
  const crop = pdf.cropImage(image, 0, Math.floor(h * 0.75), w, h);
  // Escala calculada sobre a imagem ORIGINAL (como em _find_ar_remote:
  // scale = min(2400 / max(w,h), 1.0), aplicado ao crop), extractor.py:668-676.
  const scale = Math.min(maxDim / Math.max(w, h), 1.0);
  let c = crop;
  if (scale < 1.0) c = pdf.resizeImage(crop, Math.round(crop.width * scale), Math.round(crop.height * scale));
  return pdf.toJpeg(c, quality).toString('base64');
}

// Port de _extract_structured (JSON de campos)
async function extractStructured(images, apiKey = '', modoAgencia = false) {
  if (!apiKey) apiKey = readApiKey();
  if (!apiKey) return {};
  const parts = [];
  for (const image of images) {
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: encodeJpegResized(image, 1600, 85) } });
  }
  let prompt;
  if (modoAgencia) {
    prompt = 'You are an OCR system for Brazilian physical (agência) legal documents.\n\n'
      + 'Each process consists of 2 pages: one with technical information and another describing the subject matter.\n\n'
      + 'CRITICAL: These documents have NO hearing date, NO hearing time, and NO AR tracking code. '
      + 'Any dates you see (document date, protocol date, signature date) are NOT hearing dates.\n\n'
      + 'If there is only ONE process, return a JSON object:\n'
      + '{"parte":"Party name","npu":"NNNNNNN-NN.AAAA.J.TR.OOOO","comarca":"UPPERCASE city name","data":"","hora":"","ar":""}\n\n'
      + 'If there are MULTIPLE processes, return a JSON ARRAY of objects, one per process.\n\n'
      + 'RULES:\n'
      + '  - parte: Full party name. Preserve ª, º, ç, ã exactly. '
      + 'NEVER include "COMPANHIA DE ELETRICIDADE DO ESTADO DA BAHIA" or "COELBA" — skip utility company names entirely, use the actual party.\n'
      + '  - npu: 25 characters exactly, NNNNNNN-NN.AAAA.J.TR.OOOO. Read each digit carefully.\n'
      + '  - comarca: UPPERCASE city name. For Salvador, if the header says "VSJE DO CONSUMIDOR", use that (e.g. "17ª VSJE DO CONSUMIDOR").\n'
      + '  - data: MUST be empty string "". DO NOT put any date here. No exceptions.\n'
      + '  - hora: MUST be empty string "". DO NOT put any time here. No exceptions.\n'
      + '  - ar: MUST be empty string "". DO NOT put anything here. No exceptions.\n\n'
      + 'Return ONLY valid JSON, no markdown, no backticks, no explanation.';
  } else {
    prompt = 'You are an OCR system for Brazilian legal documents (protocolos postais). '
      + 'This document may contain ONE or MULTIPLE protocols stacked vertically. '
      + 'Each protocol starts with an NPU number and ends with an AR tracking code. '
      + 'DO NOT mix fields from different protocols.\n\n'
      + 'If there is only ONE protocol, return a JSON object with exactly these keys:\n'
      + '{"npu":"NNNNNNN-NN.AAAA.J.TR.OOOO","parte":"...","comarca":"...","data":"DD/MM/AAAA","hora":"HH:MM","ar":"YH123456789BR"}\n\n'
      + 'If there are MULTIPLE protocols, return a JSON ARRAY of objects, one per protocol in order:\n'
      + '[{"npu":"...","parte":"...","comarca":"...","data":"...","hora":"...","ar":"..."}]\n\n'
      + 'STRICT RULES:\n'
      + '  - ar: EXACTLY 13 characters, YH + 9 digits + BR. Never omit digits.\n'
      + '  - data: DD/MM/AAAA numeric only, NEVER textual like "17 de Junho".\n'
      + '  - parte: Preserve ª, º, ç, ã exactly. "14ª" NOT "14?".\n'
      + '  - npu: 25 characters exactly, NNNNNNN-NN.AAAA.J.TR.OOOO.\n'
      + '  - comarca: UPPERCASE city name. EXCEPTION for Salvador: if the document says "SALVADOR" but also contains "VSJE DO CONSUMIDOR" in the header, use that instead. Ignore "(MATUTINO)" or "(VESPERTINO)" suffixes.\n\n'
      + 'Return ONLY valid JSON, no markdown, no backticks, no explanation.';
  }
  parts.push({ text: prompt });
  const raw = await remoteRequest({ contents: [{ parts }] }, apiKey, Math.max(45000, 12000 * images.length));
  if (!raw) return {};
  let cleaned = raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
  try {
    const result = JSON.parse(cleaned);
    if (Array.isArray(result)) return result;
    if (typeof result === 'object' && result !== null) return result;
    return {};
  } catch (e) {
    return {};
  }
}

// Port de _find_ar_remote (crope base 25% + resolução maior)
async function findArRemote(images, apiKey = '') {
  if (!apiKey) apiKey = readApiKey();
  if (!apiKey) return '';
  const parts = [];
  for (const image of images) {
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: encodeJpegCropBottom(image, 2400, 95) } });
  }
  parts.push({ text: 'Focus ONLY on the AR tracking number in this Brazilian postal document. '
    + 'The AR code is exactly 13 characters: YH followed by 9 digits followed by BR, e.g. YH088697725BR.\n'
    + 'Return ONLY the 13-character code, nothing else. No quotes, no explanation.' });
  const raw = await remoteRequest({ contents: [{ parts }] }, apiKey);
  if (!raw) return '';
  const m = /\bY[Hh]\d{9}B[Rr]\b/.exec(raw);
  return m ? m[0].toUpperCase() : '';
}

// Port de _find_ar_in_images (tesseract local)
async function findArInImages(images) {
  let bestRes = null;
  for (const image of images) {
    try {
      const w = image.width, h = image.height;
      const cropImg = pdf.cropImage(image, 0, Math.floor(h / 2), w, h);
      const processed = img.preprocessSoft(image);
      const txtProc = await ocrTesseractSingle(processed);
      const resProc = ex.findArInText(txtProc);
      if (resProc && resProc.length === 13) return resProc;

      const txtRot = await ocrTesseractSingle(pdf.rotate90(image), 'full');
      const resRot = ex.findArInText(txtRot);
      if (resRot && resRot.length === 13) return resRot;

      const txtCrop = await ocrTesseractSingle(cropImg, 'full');
      const resCrop = ex.findArInText(txtCrop);
      if (resCrop && resCrop.length === 13) return resCrop;

      if (resProc && !bestRes) bestRes = resProc;
      if (resRot && !bestRes) bestRes = resRot;
      if (resCrop && !bestRes) bestRes = resCrop;
    } catch (e) {}
  }
  return bestRes;
}

module.exports = {
  ocrTesseract, ocrTesseractSingle, ocrMultiEngine,
  hasKeyFields, scoreText, readApiKey,
  setOcrLogHook,
  remoteRequest, ocrRemote, extractStructured, findArRemote, findArInImages,
  encodeJpegResized,
};