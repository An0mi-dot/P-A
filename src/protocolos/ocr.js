// OCR local com Tesseract nativo.
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const pdf = require('./pdf');
const img = require('./image');
const ex = require('./extractor');

const TESSDATA = path.join(__dirname, 'tessdata');

function _cpus() {
  return typeof os.availableParallelism === 'function' ? os.availableParallelism() : 4;
}

let _nativeCmd = null;
let _jsWorkerPromise = null;
let _engineWarningShown = false;
function _findNativeTesseract() {
  if (_nativeCmd) return _nativeCmd;
  let cfg = {};
  try { cfg = require('./config_loader').loadConfig() || {}; } catch (e) {}
  if (cfg && cfg.tesseract_cmd) _nativeCmd = cfg.tesseract_cmd;
  const user = process.env.USERPROFILE || '';
  const candidates = [
    _nativeCmd,
    process.env.TESSERACT_CMD,
    path.join(process.env.LOCALAPPDATA || '', 'Tesseract-OCR', 'tesseract.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Tesseract-OCR', 'tesseract.exe'),
    'C:\\Program Files\\Tesseract-OCR\\tesseract.exe',
    'C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe',
    path.join(user, 'Desktop', 'PROG', 'protocolos_postais', 'bin', 'tesseract', 'tesseract.exe'),
    path.join(user, 'Desktop', 'PROG', 'protocolos_postais', 'dist', 'ProtocolosPostais', '_internal', 'bin', 'tesseract', 'tesseract.exe'),
  ];
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        _nativeCmd = candidate;
        return candidate;
      }
    } catch (e) {}
  }
  _nativeCmd = null;
  return null;
}

async function _getJsWorker() {
  if (!_jsWorkerPromise) {
    _jsWorkerPromise = (async () => {
      const { createWorker } = require('tesseract.js');
      return createWorker('por+eng', 1, {
        langPath: TESSDATA,
        gzip: false,
        cacheMethod: 'none',
        logger: () => {},
      });
    })().catch((error) => {
      _jsWorkerPromise = null;
      throw error;
    });
  }
  return _jsWorkerPromise;
}

async function _runJsTesseract(pngBuffer) {
  const worker = await _getJsWorker();
  const result = await worker.recognize(pngBuffer, {}, { tessedit_pageseg_mode: '6' });
  return result && result.data ? result.data.text || '' : '';
}

function _runNativeTesseract(pngBuffer, tessdataDir) {
  const exe = _findNativeTesseract();
  if (!exe) {
    if (!_engineWarningShown) {
      _engineWarningShown = true;
      console.warn('[OCR] tesseract.exe não encontrado; usando tesseract.js local.');
    }
    return _runJsTesseract(pngBuffer).catch((error) => {
      console.error('[OCR] Falha no tesseract.js local:', error && error.message ? error.message : error);
      return '';
    });
  }
  const base = path.join(os.tmpdir(), 'tess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
  const pngPath = base + '.png';
  return new Promise((resolve) => {
    fs.writeFile(pngPath, pngBuffer, (writeError) => {
      if (writeError) { resolve(''); return; }
      const args = [pngPath, 'stdout', '--tessdata-dir', tessdataDir, '--oem', '1', '--psm', '6', '-l', 'por+eng'];
      execFile(exe, args, { cwd: path.dirname(exe), maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
        try { fs.unlinkSync(pngPath); } catch (e) {}
        try { fs.unlinkSync(base + '.txt'); } catch (e) {}
        if (error) { resolve(''); return; }
        resolve(stdout || '');
      });
    });
  });
}

async function ocrTesseract(images, preprocess = 'full', onPage) {
  const n = images.length;
  if (n === 0) return '';
  const prepFn = {
    full: img.preprocessFull,
    soft: img.preprocessSoft,
    aggressive: img.preprocessAggressive,
    none: (value) => value,
  }[preprocess] || img.preprocessFull;
  const output = new Array(n);
  const concurrency = Math.max(1, Math.min(4, n, _cpus()));
  let next = 0;
  let completed = 0;
  const workOne = async (index) => {
    const image = images[index];
    let text = '';
    try {
      text = await _runNativeTesseract(pdf.toPng(prepFn(image)), TESSDATA);
    } catch (e) {}
    if (!text) {
      try { text = await _runNativeTesseract(pdf.toPng(image), TESSDATA); } catch (e) {}
    }
    output[index] = text || '';
    completed += 1;
    if (onPage) { try { onPage(completed, n); } catch (e) {} }
  };
  const workers = [];
  for (let worker = 0; worker < concurrency; worker++) {
    workers.push((async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= n) return;
        await workOne(index);
      }
    })());
  }
  await Promise.all(workers);
  return output.join('\n');
}

async function ocrTesseractSingle(image, preprocess = 'full') {
  return ocrTesseract([image], preprocess);
}

function hasKeyFields(text) {
  if (!text || text.trim().length < 200) return false;
  const hasNpu = /\d{7}[\s\-\.]\d{2}[\s\-\.]\d{4}/.test(text);
  const hasComarca = /CEP\s*\d|VSJE|VARA\s/i.test(text);
  const hasParte = /PARTE\(S\)/i.test(text);
  return hasNpu && hasComarca && hasParte;
}

function scoreText(text) {
  let score = text.trim().length;
  if (/\d{7}[\s\-\.]\d{2}[\s\-\.]\d{4}/.test(text)) score += 500;
  if (/PARTE\(S\)/i.test(text)) score += 300;
  if (/AUDI[ÊE]NCIA/i.test(text)) score += 300;
  if (/CEP/i.test(text)) score += 200;
  if (/YH\s*\d/i.test(text)) score += 400;
  return score;
}

async function ocrMultiEngine(images, onPage) {
  const results = [];
  const softText = await ocrTesseract(images, 'soft', onPage);
  if (softText.trim()) {
    if (hasKeyFields(softText)) return softText;
    results.push([softText, 'tesseract-soft']);
  }
  // The JS fallback is much slower than the native binary. Keep its first
  // useful pass instead of running two more full-page OCR passes.
  if (!_nativeCmd) return softText.trim() ? softText : '';
  const fullText = await ocrTesseract(images, 'full', onPage);
  if (fullText.trim()) {
    if (hasKeyFields(fullText)) return fullText;
    results.push([fullText, 'tesseract-full']);
  }
  if (!results.length) {
    const aggressiveText = await ocrTesseract(images, 'aggressive', onPage);
    if (aggressiveText.trim()) results.push([aggressiveText, 'tesseract-aggressive']);
  }
  if (!results.length) return '';
  let best = results[0];
  for (const result of results) if (scoreText(result[0]) > scoreText(best[0])) best = result;
  return best[0];
}

async function findArInImages(images) {
  let bestResult = null;
  for (const image of images) {
    try {
      const cropImage = pdf.cropImage(image, 0, Math.floor(image.height / 2), image.width, image.height);
      const cropText = await ocrTesseractSingle(img.preprocessSoft(cropImage), 'none');
      const cropResult = ex.findArInText(cropText);
      if (cropResult && cropResult.length === 13) return cropResult;
      if (cropResult && !bestResult) bestResult = cropResult;

      // Rotated AR labels are uncommon; pay for this pass only when the
      // cheaper bottom-half scan did not find a candidate.
      const rotatedText = await ocrTesseractSingle(pdf.rotate90(cropImage), 'soft');
      const rotatedResult = ex.findArInText(rotatedText);
      if (rotatedResult && rotatedResult.length === 13) return rotatedResult;
      if (rotatedResult && !bestResult) bestResult = rotatedResult;
    } catch (e) {}
  }
  return bestResult;
}

module.exports = {
  ocrTesseract,
  ocrTesseractSingle,
  ocrMultiEngine,
  hasKeyFields,
  scoreText,
  findArInImages,
};