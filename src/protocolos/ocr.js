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

function _runNativeTesseract(pngBuffer, tessdataDir) {
  const exe = _findNativeTesseract();
  if (!exe) return Promise.resolve('');
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
    if (onPage) { try { onPage(index + 1, n); } catch (e) {} }
  };
  const workers = [];
  for (let worker = 0; worker < concurrency; worker++) {
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
      const processed = img.preprocessSoft(image);
      const processedText = await ocrTesseractSingle(processed);
      const processedResult = ex.findArInText(processedText);
      if (processedResult && processedResult.length === 13) return processedResult;

      const rotatedText = await ocrTesseractSingle(pdf.rotate90(image), 'full');
      const rotatedResult = ex.findArInText(rotatedText);
      if (rotatedResult && rotatedResult.length === 13) return rotatedResult;

      const cropText = await ocrTesseractSingle(cropImage, 'full');
      const cropResult = ex.findArInText(cropText);
      if (cropResult && cropResult.length === 13) return cropResult;

      if (processedResult && !bestResult) bestResult = processedResult;
      if (rotatedResult && !bestResult) bestResult = rotatedResult;
      if (cropResult && !bestResult) bestResult = cropResult;
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