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

async function _runJsTesseract(pngBuffer, { psm = '6' } = {}) {
  const worker = await _getJsWorker();
  const result = await worker.recognize(pngBuffer, {}, { tessedit_pageseg_mode: String(psm) });
  return result && result.data ? result.data.text || '' : '';
}

function _runNativeTesseract(pngBuffer, tessdataDir, { psm = '6' } = {}) {
  const exe = _findNativeTesseract();
  if (!exe) {
    if (!_engineWarningShown) {
      _engineWarningShown = true;
      console.warn('[OCR] tesseract.exe não encontrado nas pastas padrão; usando tesseract.js local.');
    }
    return _runJsTesseract(pngBuffer, { psm }).catch((error) => {
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
      const args = [pngPath, 'stdout', '--tessdata-dir', effectiveTessdata, '--oem', '1', '--psm', String(psm), '-l', 'por+eng'];
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

async function ocrTesseract(images, preprocess = 'full', onPage, { psm = '6' } = {}) {
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
      text = await _runNativeTesseract(pdf.toPng(prepFn(image)), BUNDLED_TESSDATA, { psm });
    } catch (e) {}
    if (!text) {
      try { text = await _runNativeTesseract(pdf.toPng(image), BUNDLED_TESSDATA, { psm }); } catch (e) {}
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

async function ocrTesseractSingle(image, preprocess = 'full', opts = {}) {
  return ocrTesseract([image], preprocess, null, opts);
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
  // Pass 1: soft (com PSM 6 para blocos de texto uniformes)
  const softResult = await ocrTesseract(images, 'soft', onPage ? (c, n) => onPage(c, n, 'soft') : null, { psm: '6' });
  const softText = String(softResult || '');
  if (softText.trim()) {
    if (hasKeyFields(softText) || ex.findAllNpuPositions(softText).length > 0) {
      return softResult;
    }
  }

  // Pass 1b: tolerância a inclinação / páginas rotacionadas com PSM 3 (auto-segmentação)
  const tiltResult = await ocrTesseract(images, 'soft', onPage ? (c, n) => onPage(c, n, 'tilt') : null, { psm: '3' });
  const tiltText = String(tiltResult || '');
  if (tiltText.trim()) {
    if (hasKeyFields(tiltText) || ex.findAllNpuPositions(tiltText).length > 0) {
      return tiltResult;
    }
  }

  if (!_findNativeTesseract()) {
    return softText.trim() ? softResult : (tiltText.trim() ? tiltResult : _wrapOcrResult([]));
  }

  // Pass 2: full
  const fullResult = await ocrTesseract(images, 'full', onPage ? (c, n) => onPage(c, n, 'full') : null, { psm: '6' });
  const fullText = String(fullResult || '');
  if (fullText.trim()) {
    if (hasKeyFields(fullText) || ex.findAllNpuPositions(fullText).length > 0) {
      return fullResult;
    }
  }

  // Pass 3: aggressive (apenas se nenhum NPU foi encontrado nas anteriores)
  const aggressiveResult = await ocrTesseract(images, 'aggressive', onPage ? (c, n) => onPage(c, n, 'aggressive') : null, { psm: '3' });
  const aggressiveText = String(aggressiveResult || '');

  const candidates = [
    { result: softResult, text: softText },
    { result: tiltResult, text: tiltText },
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
      // 1. OCR direto na página inteira sem pré-processamento ('none') - preserva códigos de barra limpos
      const directText = String(await ocrTesseractSingle(image, 'none'));
      const directResult = ex.findArInText(directText);
      if (directResult && directResult.length === 13) return directResult;
      if (directResult && !bestResult) bestResult = directResult;

      // 1b. OCR direto com PSM 3 (caso a página ou AR estejam inclinados)
      const directTextTilt = String(await ocrTesseractSingle(image, 'none', { psm: '3' }));
      const directResultTilt = ex.findArInText(directTextTilt);
      if (directResultTilt && directResultTilt.length === 13) return directResultTilt;
      if (directResultTilt && !bestResult) bestResult = directResultTilt;

      // 1c. Página invertida em 180 graus (muito comum em alimentadores duplex de scanners de mesa)
      const img180 = pdf.rotate180(image);
      const text180 = String(await ocrTesseractSingle(img180, 'none'));
      const res180 = ex.findArInText(text180);
      if (res180 && res180.length === 13) return res180;
      if (res180 && !bestResult) bestResult = res180;

      // 2. Metade inferior sem pré-processamento ('none')
      const cropImage = pdf.cropImage(image, 0, Math.floor(image.height / 2), image.width, image.height);
      const cropTextNone = String(await ocrTesseractSingle(cropImage, 'none'));
      const cropResultNone = ex.findArInText(cropTextNone);
      if (cropResultNone && cropResultNone.length === 13) return cropResultNone;
      if (cropResultNone && !bestResult) bestResult = cropResultNone;

      // 3. Metade inferior com pré-processamento soft (para documentos com baixa resolução/contraste)
      const cropTextSoft = String(await ocrTesseractSingle(img.preprocessSoft(cropImage), 'none'));
      const cropResultSoft = ex.findArInText(cropTextSoft);
      if (cropResultSoft && cropResultSoft.length === 13) return cropResultSoft;
      if (cropResultSoft && !bestResult) bestResult = cropResultSoft;

      // 4. Scan rotacionado em 90 graus e 270 graus
      const rot90Text = String(await ocrTesseractSingle(pdf.rotate90(cropImage), 'soft'));
      const rot90Result = ex.findArInText(rot90Text);
      if (rot90Result && rot90Result.length === 13) return rot90Result;
      if (rot90Result && !bestResult) bestResult = rot90Result;

      const rot270Text = String(await ocrTesseractSingle(pdf.rotate270(cropImage), 'soft'));
      const rot270Result = ex.findArInText(rot270Text);
      if (rot270Result && rot270Result.length === 13) return rot270Result;
      if (rot270Result && !bestResult) bestResult = rot270Result;

      // 5. Micro-rotações (+3° e -3°) para comprovantes colados levemente tortos
      for (const angle of [3, -3]) {
        const microRot = pdf.rotateAngle(cropImage, angle);
        const microText = String(await ocrTesseractSingle(microRot, 'none', { psm: '3' }));
        const microRes = ex.findArInText(microText);
        if (microRes && microRes.length === 13) return microRes;
        if (microRes && !bestResult) bestResult = microRes;
      }
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