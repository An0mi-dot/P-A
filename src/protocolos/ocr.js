// OCR local com Tesseract nativo.
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile, execSync } = require('child_process');
const pdf = require('./pdf');
const img = require('./image');
const ex = require('./extractor');

const BUNDLED_TESSDATA = path.join(__dirname, 'tessdata');

function _cpus() {
  return typeof os.availableParallelism === 'function' ? os.availableParallelism() : 4;
}

let _nativeCmd = null;
let _tessdataDir = null;
let _jsWorkerPromise = null;
let _engineWarningShown = false;

// Localização universal do executável tesseract.exe
function _findNativeTesseract() {
  if (_nativeCmd && fs.existsSync(_nativeCmd)) return _nativeCmd;

  // 1. Configuração explícita (config.json)
  let cfg = {};
  try { cfg = require('./config_loader').loadConfig() || {}; } catch (e) {}
  if (cfg) {
    const configured = cfg.tesseract_cmd || cfg.tesseract_path || (cfg.tesseract && cfg.tesseract.exe);
    if (configured && fs.existsSync(configured)) {
      _nativeCmd = configured;
      return configured;
    }
  }

  // 2. Variáveis de ambiente
  const envCandidates = [
    process.env.TESSERACT_CMD,
    process.env.TESSERACT_PATH,
    process.env.TESSERACT_EXE,
  ];
  for (const envPath of envCandidates) {
    if (envPath && fs.existsSync(envPath)) {
      _nativeCmd = envPath;
      return envPath;
    }
  }

  // 3. System PATH via where.exe
  try {
    const whereOut = execSync('where.exe tesseract', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 2000 });
    const firstLine = (whereOut || '').split(/\r?\n/)[0].trim();
    if (firstLine && fs.existsSync(firstLine)) {
      _nativeCmd = firstLine;
      return firstLine;
    }
  } catch (e) {}

  // 4. Pastas relativas ao projeto (modo portátil / repositório)
  const root = path.join(__dirname, '..', '..');
  const projectCandidates = [
    path.join(root, 'bin', 'tesseract', 'tesseract.exe'),
    path.join(root, 'bin', 'Tesseract-OCR', 'tesseract.exe'),
    path.join(root, 'tesseract', 'tesseract.exe'),
    path.join(root, 'Externo', 'tesseract', 'tesseract.exe'),
    path.join(root, 'Externo', 'ProtocolosPostais', 'tesseract.exe'),
    path.join(root, 'Externo', 'ProtocolosPostais', 'bin', 'tesseract', 'tesseract.exe'),
  ];
  try {
    if (process.resourcesPath) {
      projectCandidates.push(
        path.join(process.resourcesPath, 'bin', 'tesseract', 'tesseract.exe'),
        path.join(process.resourcesPath, 'Externo', 'ProtocolosPostais', 'bin', 'tesseract', 'tesseract.exe')
      );
    }
  } catch (e) {}

  // 5. Instalações padrão do Windows (por usuário e por máquina, em todas as unidades comuns)
  const user = process.env.USERPROFILE || '';
  const localAppData = process.env.LOCALAPPDATA || '';
  const appData = process.env.APPDATA || '';
  const standardCandidates = [
    path.join(localAppData, 'Programs', 'Tesseract-OCR', 'tesseract.exe'),
    path.join(localAppData, 'Tesseract-OCR', 'tesseract.exe'),
    path.join(appData, 'Tesseract-OCR', 'tesseract.exe'),
    'C:\\Program Files\\Tesseract-OCR\\tesseract.exe',
    'C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe',
    'C:\\ProgramData\\chocolatey\\bin\\tesseract.exe',
    path.join(user, 'scoop', 'shims', 'tesseract.exe'),
    path.join(user, 'scoop', 'apps', 'tesseract', 'current', 'tesseract.exe'),
    // Pastas corporativas / legadas
    path.join(user, 'Desktop', 'PROG', 'protocolos_postais', 'bin', 'tesseract', 'tesseract.exe'),
    path.join(user, 'Desktop', 'PROG', 'protocolos_postais', 'dist', 'ProtocolosPostais', '_internal', 'bin', 'tesseract', 'tesseract.exe'),
    path.join(user, 'Desktop', 'TRABALHO', 'P-A', 'bin', 'tesseract', 'tesseract.exe'),
  ];

  // Outras unidades (D:, E:, F:)
  for (const drive of ['D:', 'E:', 'F:']) {
    standardCandidates.push(
      path.join(drive, '\\Program Files', 'Tesseract-OCR', 'tesseract.exe'),
      path.join(drive, '\\Program Files (x86)', 'Tesseract-OCR', 'tesseract.exe'),
      path.join(drive, '\\Tesseract-OCR', 'tesseract.exe')
    );
  }

  const allCandidates = [
    ...projectCandidates,
    ...standardCandidates,
  ];

  for (const candidate of allCandidates) {
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

// Localiza o diretório tessdata com suporte aos idiomas por+eng
function _getTessdataDir(exe) {
  if (_tessdataDir && fs.existsSync(path.join(_tessdataDir, 'por.traineddata'))) return _tessdataDir;

  const candidates = [];
  // 1. Tessdata do próprio projeto
  candidates.push(BUNDLED_TESSDATA);

  // 2. Tessdata adjacente ao executável
  if (exe) {
    candidates.push(path.join(path.dirname(exe), 'tessdata'));
  }

  // 3. Tessdata configurado
  try {
    const cfg = require('./config_loader').loadConfig() || {};
    if (cfg.tessdata_dir) candidates.unshift(cfg.tessdata_dir);
  } catch (e) {}

  for (const d of candidates) {
    if (d && fs.existsSync(d)) {
      const hasPor = fs.existsSync(path.join(d, 'por.traineddata'));
      const hasEng = fs.existsSync(path.join(d, 'eng.traineddata'));
      if (hasPor && hasEng) {
        _tessdataDir = d;
        return d;
      }
    }
  }

  // Fallback para o bundled
  _tessdataDir = BUNDLED_TESSDATA;
  return BUNDLED_TESSDATA;
}

function getTesseractInfo() {
  const exe = _findNativeTesseract();
  const tessdata = _getTessdataDir(exe);
  return {
    available: !!exe,
    path: exe || null,
    tessdata,
  };
}

async function _getJsWorker() {
  if (!_jsWorkerPromise) {
    _jsWorkerPromise = (async () => {
      const { createWorker } = require('tesseract.js');
      return createWorker('por+eng', 1, {
        langPath: BUNDLED_TESSDATA,
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
      console.warn('[OCR] tesseract.exe não encontrado nas pastas padrão; usando tesseract.js local.');
    }
    return _runJsTesseract(pngBuffer).catch((error) => {
      console.error('[OCR] Falha no tesseract.js local:', error && error.message ? error.message : error);
      return '';
    });
  }
  const effectiveTessdata = _getTessdataDir(exe) || tessdataDir || BUNDLED_TESSDATA;
  const base = path.join(os.tmpdir(), 'tess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
  const pngPath = base + '.png';
  return new Promise((resolve) => {
    fs.writeFile(pngPath, pngBuffer, (writeError) => {
      if (writeError) { resolve(''); return; }
      const args = [pngPath, 'stdout', '--tessdata-dir', effectiveTessdata, '--oem', '1', '--psm', '6', '-l', 'por+eng'];
      execFile(exe, args, { cwd: path.dirname(exe), maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
        try { fs.unlinkSync(pngPath); } catch (e) {}
        try { fs.unlinkSync(base + '.txt'); } catch (e) {}
        if (error) { resolve(''); return; }
        resolve(stdout || '');
      });
    });
  });
}

function _wrapOcrResult(pages) {
  const fullText = (pages || []).join('\n');
  const res = new String(fullText);
  res.text = fullText;
  res.pages = pages || [];
  return res;
}

async function ocrTesseract(images, preprocess = 'full', onPage) {
  const n = images.length;
  if (n === 0) return _wrapOcrResult([]);
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
      text = await _runNativeTesseract(pdf.toPng(prepFn(image)), BUNDLED_TESSDATA);
    } catch (e) {}
    if (!text) {
      try { text = await _runNativeTesseract(pdf.toPng(image), BUNDLED_TESSDATA); } catch (e) {}
    }
    output[index] = text || '';
    completed += 1;
    if (onPage) {
      try { onPage(Math.min(completed, n), n); } catch (e) {}
    }
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
  return _wrapOcrResult(output);
}

async function ocrTesseractSingle(image, preprocess = 'full') {
  return ocrTesseract([image], preprocess);
}

function hasKeyFields(text) {
  if (!text || text.trim().length < 50) return false;
  const hasNpu = ex.findAllNpuPositions(text).length > 0 || /\d{7}[\s\-\.]\d{2}[\s\-\.]\d{4}|\b\d{20}\b/.test(text);
  const hasComarca = /COMARCA|CEP\s*\d|VSJE|VARA|JUIZADO|TRIBUNAL|ESTADO\s+DA\s+BAHIA|SALVADOR|ILHEUS|ILHÉUS|ITABUNA|FEIRA/i.test(text);
  const hasParte = /PARTE\(S\)|AUTOR|REU|RÉU|PROMOVENTE|PROMOVIDO|REQUERENTE/i.test(text);
  return hasNpu && (hasComarca || hasParte);
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
  // Pass 1: soft
  const softResult = await ocrTesseract(images, 'soft', onPage ? (c, n) => onPage(c, n, 'soft') : null);
  const softText = String(softResult || '');
  if (softText.trim()) {
    if (hasKeyFields(softText) || ex.findAllNpuPositions(softText).length > 0) {
      return softResult;
    }
  }

  if (!_findNativeTesseract()) {
    return softText.trim() ? softResult : _wrapOcrResult([]);
  }

  // Pass 2: full
  const fullResult = await ocrTesseract(images, 'full', onPage ? (c, n) => onPage(c, n, 'full') : null);
  const fullText = String(fullResult || '');
  if (fullText.trim()) {
    if (hasKeyFields(fullText) || ex.findAllNpuPositions(fullText).length > 0) {
      return fullResult;
    }
  }

  // Pass 3: aggressive (apenas se nenhum NPU foi encontrado nas anteriores)
  const aggressiveResult = await ocrTesseract(images, 'aggressive', onPage ? (c, n) => onPage(c, n, 'aggressive') : null);
  const aggressiveText = String(aggressiveResult || '');

  const candidates = [
    { result: softResult, text: softText },
    { result: fullResult, text: fullText },
    { result: aggressiveResult, text: aggressiveText }
  ].filter(c => c.text.trim());

  if (!candidates.length) return _wrapOcrResult([]);
  let best = candidates[0];
  for (const c of candidates) {
    if (scoreText(c.text) > scoreText(best.text)) best = c;
  }
  return best.result;
}

async function findArInImages(images) {
  let bestResult = null;
  const imgList = Array.isArray(images) ? images : [images];
  for (const image of imgList) {
    if (!image) continue;
    try {
      const cropImage = pdf.cropImage(image, 0, Math.floor(image.height / 2), image.width, image.height);
      const cropText = String(await ocrTesseractSingle(img.preprocessSoft(cropImage), 'none'));
      const cropResult = ex.findArInText(cropText);
      if (cropResult && cropResult.length === 13) return cropResult;
      if (cropResult && !bestResult) bestResult = cropResult;

      // Scan rotacionado em 90 graus
      const rotatedText = String(await ocrTesseractSingle(pdf.rotate90(cropImage), 'soft'));
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
  getTesseractInfo,
  _findNativeTesseract,
};