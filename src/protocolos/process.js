// Orquestrador: processamento de arquivos PDF (OCR + extração + Espaider + fallback)
// e consulta de NPUs. Port fiel do fluxo de app.py (_process_files_thread / _consultar_npus_thread)
// combinado com process_pdf_multi de extractor.py.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const ex = require('./extractor');
const pdf = require('./pdf');
const ocr = require('./ocr');
const { EspaiderAutomator } = require('./espaider');
const { FallbackConsultant, exportToExcel } = require('./excel');
const config = require('./config_loader');

function now() {
  return new Date();
}

function timestamp() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `[${hh}:${mm}:${ss}] `;
}

// Port de _apply_missing_value_labels
function applyMissingValueLabels(data, arquivoNome) {
  const missing = (label) => `${label} não identificado - ${arquivoNome}`;
  const issues = [];
  const tipo = data.tipo || 'postal';

  if (!(data.npu || '').trim()) { data.npu = missing('NPU'); issues.push('NPU não identificado'); }
  if (!(data.parte || '').trim()) { data.parte = missing('Nome'); issues.push('Nome não identificado'); }
  if (!(data.comarca || '').trim()) { data.comarca = missing('Comarca'); issues.push('Comarca não identificada'); }
  if (!(data.data || '').trim()) { data.data = tipo === 'agencia' ? 'N/A' : missing('Data'); issues.push('Data não identificada'); }
  if (!(data.hora || '').trim()) { data.hora = tipo === 'agencia' ? 'N/A' : missing('Hora'); issues.push('Hora não identificada'); }
  if (!(data.ar || '').trim()) { data.ar = ''; issues.push('AR vazio'); }

  for (const key of ['parte', 'npu', 'comarca', 'data', 'hora']) {
    if (typeof data[key] === 'string') data[key] = data[key].trim();
  }
  return issues;
}

// Port de _duplicate_key
function duplicateKey(data) {
  const keys = ['parte', 'npu', 'comarca', 'data', 'hora', 'ar'];
  const parts = keys.map(k => String(data[k] || '').trim().toLowerCase().replace(/\s+/g, ' '));
  const key = parts.join('|');
  return key && parts.some(p => p) ? key : null;
}

// Texto do PDF: nativo pymupdf-equivalente → OCR local (tesseract multi-engine) a 400dpi.
// Port fiel de process_pdf_multi (extractor.py:1474-1477): texto via _ocr_multi_engine nas
// imagens 400dpi, sem heurísticas de páginas
// (===PAGE=== / expectedByPages / pares de 2 páginas) — removidas do port fiel.
async function getOcrText(filePath, { onLog = () => {}, modoAgencia = false } = {}) {
  let text = '';
  try { text = await pdf.extractTextPdf(filePath); } catch (e) {}
  const scanned = !(text && text.trim().length >= 50);
  let images = null;
  if (scanned) {
    images = await pdf.renderPages(filePath, 400);
    let ocrText = '';
    try { ocrText = await ocr.ocrMultiEngine(images, (i, n) => onLog('dim', `  → Lendo via OCR... (página ${i + 1}/${n})`)); } catch (e) { onLog('error', `Erro na leitura do documento: ${e}`); }
    text = (text ? text + '\n' : '') + ocrText;
  }
  return { text, images };
}

// Port de process_pdf_multi (sem EasyOCR)
async function processPdfMulti(filePath, { modoAgencia = false, onLog = () => {} } = {}) {  const { text, images: cachedImages } = await getOcrText(filePath, { onLog, modoAgencia });
  let images = cachedImages;
  let npuCount = 0;

  const npuPositions = text ? ex.findAllNpuPositions(text) : [];
  npuCount = npuPositions.length;
  let secTexts = text ? ex.splitTextByProtocol(text) : [];

  const results = [];

  // Modo agência: usa a extração local do Tesseract.
  if (modoAgencia && text) {
    onLog('info', 'Modo agência: extraindo dados localmente via Tesseract');
    let npu = ex.findNpu(text) || '';
    if (npu) npu = ex.normalizeNpu(npu);
    let parte = ex.findPartes(text) || '';
    if (parte && /COELBA|COMPANHIA\s+DE\s+ELETRICIDADE/i.test(parte)) { parte = ''; }
    let comarca = ex.findComarca(text) || '';
    comarca = ex.vsjeFixSalvador(text, comarca);
    if (npu) {
      comarca = ex.fixComarcaByNpu(npu, comarca);
      results.push({ parte, npu, comarca, data: '', hora: '', ar: '', tipo: 'agencia' });
      onLog('info', 'Fallback Tesseract: 1 protocolo agência extraído');
    }
    return results;
  }

  if (npuCount > 0) {
    onLog('info', `OCR concluído: usando OCR direto para ${npuCount} protocolo(s)`);
  }

  for (let idx = 0; idx < secTexts.length; idx++) {
    const secText = secTexts[idx] || '';
    let parte = ex.findPartes(secText) || '';
    let npu = '', comarca = '', data = '', hora = '', ar = '';

    npu = ex.findNpu(secText) || '';
      if (npu) npu = ex.normalizeNpu(npu);
      parte = ex.findPartes(secText) || '';
      const prevTail = idx > 0 ? secTexts[idx - 1].slice(-800) : '';
      const comarcaText = prevTail + secText;
      comarca = ex.findComarca(comarcaText) || '';
      const [d, h] = ex.findAudienciaDatetime(secText);
      data = d || '';
      hora = h || '';
      ar = ex.findArInText(secText) || '';

      const missingCore = !npu || !parte || !comarca;
      const missingExtra = modoAgencia ? false : (!data || !hora);
      if (missingCore || missingExtra) {
        if (!images) images = await pdf.renderPages(filePath, 400);
        const img = require('./image');
        const processed = images.map((im) => img.preprocessFull(im));
        let textProc = '';
        try { textProc = await ocr.ocrTesseract(processed, 'none'); } catch (e) {}
        if (!data || !hora) {
          const [d2, h2] = ex.findAudienciaDatetime(textProc);
          if (d2) data = d2;
          if (h2) hora = h2;
        }
        if (!npu) { npu = ex.findNpu(textProc) || ''; if (npu) npu = ex.normalizeNpu(npu); }
        if (!comarca) {
          const comarcaText2 = prevTail ? prevTail + textProc : textProc;
          comarca = ex.findComarca(comarcaText2) || '';
        }
        if (!modoAgencia && !ar) ar = ex.findArInText(textProc) || '';
      }

    // AR final via OCR local (pula em modo agência)
    if (!modoAgencia && (!ar || ar.length !== 13)) {
      if (!images) images = await pdf.renderPages(filePath, 400);
      onLog('dim', '  → Buscando AR via OCR local...');
      const arLocal = await ocr.findArInImages(images);
      if (arLocal) ar = arLocal;
    }

    data = data || '';
    hora = hora || '';
    npu = ex.tryFixNpuYear(npu, data);
    comarca = ex.fixComarcaByNpu(npu, comarca);

    results.push({ parte, npu, comarca, data, hora, ar: ar || '', tipo: modoAgencia ? 'agencia' : 'postal' });
  }

  onLog('info', `Extraidos ${results.length} protocolos: ${results.map(r => `${String(r.npu).slice(0, 15)} / ${String(r.comarca).slice(0, 20)}`).join(', ')}`);
  return results;
}

// --- Nome do PDF de destino (cópia única por arquivo de origem) ---
function buildDestPdfName(filePath, validNpus, outputFolder) {
  const stem = path.basename(filePath, path.extname(filePath));
  let npuPart;
  if (validNpus && validNpus.length) {
    const unique = [...new Set(validNpus)].sort();
    npuPart = unique.join('_');
  } else {
    npuPart = stem;
  }
  npuPart = npuPart.replace(/[^0-9A-Za-z.\-]/g, '_');
  const baseDir = path.resolve(outputFolder || os.tmpdir());
  let maxNpuLen = 245 - baseDir.length - 1 - 4;
  if (maxNpuLen < 50) maxNpuLen = 50;
  if (npuPart.length > maxNpuLen && validNpus.length) {
    const suffix = '_e_outros';
    const kept = [];
    for (const npu of [...new Set(validNpus)].sort()) {
      const candidate = kept.concat([npu]).join('_');
      if (candidate.length + suffix.length > maxNpuLen) break;
      kept.push(npu);
    }
    npuPart = kept.length < validNpus.length ? kept.join('_') + suffix : kept.join('_');
  }
  return { destPdf: path.join(baseDir, `${npuPart}.pdf`), npuPart };
}

// --- Processamento completo de arquivos ---
async function processFiles(ctx, opts) {
  const { files = [], outputFolder = '', user = '', pwd = '', headless = true, modoAgencia = false } = opts;
  const log = ctx.log || (() => {});
  const shouldCancel = ctx.shouldCancel || (() => false);
  const progress = ctx.progress || (() => {});

  const startTime = Date.now();
  const results = [];
  const errorRows = [];
  const seenNpus = new Set();
  const seenProcesses = new Set();
  let logBuffer = [];

  const clog = (level, msg) => { logBuffer.push(`${timestamp()}${msg}`); log(level, msg); };
  const addError = (arquivo, problema, status) => errorRows.push({ arquivo, problema, status });

  const totalFiles = files.length;
  clog('highlight', `Iniciando processamento de ${totalFiles} arquivo(s)`);

  // Salva credenciais no config.json
  const cfg = config.loadConfig();
  if (cfg.user !== user || cfg.pwd !== pwd) {
    cfg.user = user;
    cfg.pwd = pwd;
    cfg.output_folder = outputFolder;
    config.saveConfig(cfg);
  }

  // Espaider
  clog('dim', 'Inicializando consulta ao Espaider...');
  const espaider = new EspaiderAutomator(headless);
  let espaiderOk = false;
  try {
    await espaider.start();
    if (user && pwd) {
      clog('dim', 'Realizando login automático no Espaider...');
      await espaider.login(user, pwd);
    }
    espaiderOk = true;
  } catch (e) {
    clog('error', `Falha ao iniciar Selenium/Espaider: ${e}`);
    clog('warning', 'Continuando sem consulta ao Espaider.');
  }

  const forceEspaiderRestart = async () => {
    try {
      await espaider.stop();
      await espaider.start();
      if (user && pwd) await espaider.login(user, pwd);
      espaider._filterLocator = null;
    } catch (e) {
      clog('error', `Falha ao reiniciar o Espaider: ${e}`);
    }
  };

  const fb = new FallbackConsultant();
  await fb.ready;
  fb._normalize();

  let consecutiveErrors = 0;
  let totalEspaiderCalls = 0;

  for (let idx = 0; idx < files.length; idx++) {
    if (shouldCancel()) {
      clog('error', 'Processamento cancelado pelo usuário.');
      break;
    }
    const p = files[idx];
    const arquivoNome = path.basename(p);
    clog('info', `${idx + 1}º Processando ${arquivoNome}`);
    try {
      clog('dim', '  → Lendo via OCR...');
      const datas = await processPdfMulti(p, { modoAgencia, onLog: clog });
      const validNpus = [];

      for (const data of datas) {
        if (shouldCancel()) break;
        const issues = applyMissingValueLabels(data, arquivoNome);
        const npu = (data.npu || '').trim();
        const comarca = (data.comarca || '').trim();
        const dupKey = duplicateKey(data);

        if (npu && !npu.toLowerCase().includes('não identificado') && !npu.toLowerCase().includes('nao identificado')) {
          if (seenNpus.has(npu)) {
            clog('warning', `  - NPU duplicado ignorado: ${npu}`);
            addError(arquivoNome, 'NPU duplicado', 'Ignorado');
            continue;
          }
          seenNpus.add(npu);
        }
        if (dupKey && seenProcesses.has(dupKey)) {
          clog('warning', '  - Duplicado ignorado');
          addError(arquivoNome, 'Duplicado', 'Ignorado');
          continue;
        }
        if (dupKey) seenProcesses.add(dupKey);

        if (issues.length) addError(arquivoNome, issues.join('; '), 'Ajustado');
        if (npu && !npu.toLowerCase().includes('não identificado') && !npu.toLowerCase().includes('nao identificado')) validNpus.push(npu);

        let escritorio = '';
        if (espaiderOk && npu) {
          if (totalEspaiderCalls > 0 && totalEspaiderCalls % 35 === 0) {
            clog('dim', `  - Reiniciando Espaider (lote de ${totalEspaiderCalls} consultas)`);
            await forceEspaiderRestart();
          }
          totalEspaiderCalls += 1;
          escritorio = await espaider.searchNpu(npu);
          if (escritorio) {
            clog('success', `  - Escritório encontrado no Espaider: ${escritorio}`);
            consecutiveErrors = 0;
          } else {
            consecutiveErrors += 1;
            if (consecutiveErrors >= 5) { await forceEspaiderRestart(); consecutiveErrors = 0; }
          }
        }

        if (!escritorio && comarca && fb) {
          const fbEsc = fb.findEscritorio(comarca);
          if (fbEsc) {
            escritorio = fbEsc;
            clog('success', `  - Escritório encontrado no Fallback (${comarca}): ${escritorio}`);
          }
        }

        data.escritorio = escritorio;
        data.arquivo = arquivoNome;
        data.source_file = arquivoNome;
        results.push(data);
        clog('success', `  - OK: Parte=${data.parte || ''} | NPU=${data.npu || '(sem NPU)'} | Comarca=${data.comarca || ''} | Data/Hora=${data.data || ''} ${data.hora || ''} | AR=${data.ar || '(sem AR)'} | Escritório=${data.escritorio || '(vazio)'}`);
      }

      // Cópia do PDF com nome dos NPUs
      if (validNpus.length) {
        const { destPdf, npuPart } = buildDestPdfName(p, validNpus, outputFolder);
        const srcAbs = path.resolve(p);
        const dstAbs = path.resolve(destPdf);
        if (path.normalize(srcAbs).toLowerCase() !== path.normalize(dstAbs).toLowerCase()) {
          fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
          fs.copyFileSync(srcAbs, dstAbs);
          clog('dim', `  - PDF copiado para ${path.basename(destPdf)}`);
        } else {
          clog('dim', '  - PDF mantido na mesma pasta de origem');
        }
      }
    } catch (e) {
      clog('error', `  - Erro em ${arquivoNome}: ${e}`);
    }

    progress(((idx + 1) / totalFiles) * 100);
  }

  try { await espaider.stop(); clog('dim', 'Fechando conexão do Espaider.'); } catch (e) {}

  // Salva log
  if (outputFolder) {
    try {
      const d = new Date();
      const ts = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
      fs.writeFileSync(path.join(outputFolder, `log_${ts}.txt`), logBuffer.join('\n'), 'utf-8');
    } catch (e) {}
  }

  const totalSec = Math.round((Date.now() - startTime) / 1000);
  return { results, errorRows, totalSec };
}

// --- Consulta de NPUs (modo consulta) ---
async function consultarNpus(ctx, opts) {
  const { npus = [], comarcas = [], outputFolder = '', user = '', pwd = '', headless = true } = opts;
  const log = ctx.log || (() => {});
  const shouldCancel = ctx.shouldCancel || (() => false);
  const progress = ctx.progress || (() => {});

  const startTime = Date.now();
  const results = [];
  let logBuffer = [];
  const clog = (level, msg) => { logBuffer.push(`${timestamp()}${msg}`); log(level, msg); };

  const total = npus.length;
  clog('highlight', `Consultando ${total} NPU(s) no Espaider...`);

  const espaider = new EspaiderAutomator(headless);
  let espaiderOk = false;
  if (user && pwd) {
    try {
      await espaider.start();
      clog('dim', 'Realizando login no Espaider...');
      await espaider.login(user, pwd);
      espaiderOk = true;
    } catch (e) {
      clog('error', `Falha ao iniciar Espaider: ${e}`);
    }
  }

  let consecutiveErrors = 0;
  const fb = new FallbackConsultant();
  await fb.ready;
  fb._normalize();

  for (let idx = 0; idx < npus.length; idx++) {
    if (shouldCancel()) { clog('error', 'Consulta cancelada.'); break; }
    const npu = npus[idx];
    const comarca = comarcas[idx] || '';
    clog('info', `${idx + 1}/${total} Consultando ${npu}`);

    let escritorio = '';
    if (espaiderOk) {
      try {
        escritorio = await espaider.searchNpu(npu);
      } catch (e) {
        const msg = String(e).toLowerCase();
        if (msg.includes('no such window') || msg.includes('target window already closed')) {
          clog('warning', '  - Janela do Edge fechada. Reiniciando...');
          try { await espaider.stop(); } catch (e2) {}
          try {
            await espaider.start();
            if (user && pwd) await espaider.login(user, pwd);
            escritorio = await espaider.searchNpu(npu);
          } catch (e3) {
            clog('error', '  - Falha ao reiniciar Edge.');
            escritorio = '';
          }
        } else {
          clog('error', `  - Erro na consulta: ${e}`);
          escritorio = '';
        }
      }
      if (escritorio) {
        clog('success', `  - Escritório: ${escritorio}`);
        consecutiveErrors = 0;
      } else {
        consecutiveErrors += 1;
        if (consecutiveErrors >= 5) {
          clog('warning', '  - Reiniciando Espaider (limite de erros)...');
          try {
            await espaider.stop();
            await espaider.start();
            if (user && pwd) await espaider.login(user, pwd);
          } catch (e) {}
          consecutiveErrors = 0;
        }
      }
    }

    if (!escritorio && comarca) {
      try {
        const fbEsc = fb.findEscritorio(comarca);
        if (fbEsc) {
          escritorio = fbEsc;
          clog('success', `  - Escritório encontrado no Fallback (${comarca}): ${escritorio}`);
        }
      } catch (e) {
        clog('dim', `  - Fallback indisponível: ${e}`);
      }
    }

    if (!escritorio) clog('warning', '  - Escritório não encontrado no Espaider');

    results.push({ parte: '', npu, comarca, data: '', hora: '', ar: '', escritorio: escritorio || '' });
    progress(((idx + 1) / total) * 100);
  }

  try { await espaider.stop(); } catch (e) {}

  if (outputFolder) {
    try {
      const d = new Date();
      const ts = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
      fs.writeFileSync(path.join(outputFolder, `log_${ts}.txt`), logBuffer.join('\n'), 'utf-8');
    } catch (e) {}
  }

  const totalSec = Math.round((Date.now() - startTime) / 1000);
  return { results, totalSec };
}

module.exports = {
  applyMissingValueLabels, duplicateKey, processPdfMulti, processFiles, consultarNpus, buildDestPdfName, exportToExcel,
};