// Port fiel da lógica de extração em src/extractor.py (Protocolos Postais v1.11.0)
// Funções puras de texto/regex — sem I/O. Módulos de OCR/render em pdf.js/ocr.js.
'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Utilitários de acentos
// ---------------------------------------------------------------------------
function stripAccents(s) {
  if (typeof s !== 'string') return '';
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
const removeAccents = stripAccents;

// ---------------------------------------------------------------------------
// Comarca lookup table (NPU OOOO → comarca TJBA)
// ---------------------------------------------------------------------------
let comarcaByNpu = null;
function loadComarcas() {
  if (comarcaByNpu !== null) return comarcaByNpu;
  try {
    const p = path.join(__dirname, 'comarcas_tjba.json');
    if (fs.existsSync(p)) {
      comarcaByNpu = JSON.parse(fs.readFileSync(p, 'utf-8'));
    } else {
      comarcaByNpu = {};
    }
  } catch (e) {
    comarcaByNpu = {};
  }
  return comarcaByNpu;
}

function fixComarcaByNpu(npu, comarcaOcr) {
  if (!npu || !comarcaOcr) return comarcaOcr;
  const m = /8\.05\.(\d{4})$/.exec(npu);
  if (!m) return comarcaOcr;
  const codigo = m[1];
  const table = loadComarcas();
  const nomeOficial = table[codigo];
  if (!nomeOficial) return comarcaOcr;
  const norm = s => s.replace(/\s+/g, ' ').trim().toUpperCase();
  if (nomeOficial.toUpperCase() === 'SALVADOR') return comarcaOcr;
  if (norm(nomeOficial) === norm(comarcaOcr)) return comarcaOcr;
  return nomeOficial;
}

// ---------------------------------------------------------------------------
// NPU normalization (forced 8.05)
// ---------------------------------------------------------------------------
function currentYear() { return new Date().getFullYear(); }

function normalizeNpu(npu) {
  let digits = (npu || '').replace(/\D/g, '');
  if (digits.length !== 20 && digits.length !== 21) return npu;
  if (digits.length === 21) {
    const maxYear = currentYear();
    let best = null;
    for (let i = 0; i < 21; i++) {
      const cand = digits.slice(0, i) + digits.slice(i + 1);
      if (cand.length !== 20) continue;
      const d = cand.split('');
      d[13] = '8'; d[14] = '0'; d[15] = '5';
      const yearInt = parseInt(d.slice(9, 13).join(''), 10);
      if (2000 <= yearInt && yearInt <= maxYear) { best = d.join(''); break; }
    }
    if (best === null) {
      const cand = digits.slice(0, 20).split('');
      cand[13] = '8'; cand[14] = '0'; cand[15] = '5';
      best = cand.join('');
    }
    digits = best;
  }
  const d = digits.split('');
  d[13] = '8'; d[14] = '0'; d[15] = '5';
  let yearStr = d.slice(9, 13).join('');
  const yearInt = parseInt(yearStr, 10);
  if (!Number.isNaN(yearInt) && yearInt > currentYear()) {
    yearStr = String(currentYear());
    d[9] = yearStr[0]; d[10] = yearStr[1]; d[11] = yearStr[2]; d[12] = yearStr[3];
  }
  const fixed = d.join('');
  return `${fixed.slice(0, 7)}-${fixed.slice(7, 9)}.${fixed.slice(9, 13)}.${fixed[13]}.${fixed.slice(14, 16)}.${fixed.slice(16)}`;
}

function isValidNpuCandidate(digits) {
  if (digits.length !== 20) return false;
  const year = parseInt(digits.slice(9, 13), 10);
  if (Number.isNaN(year) || year < 2000 || year > currentYear()) return false;
  if (digits[13] !== '8') return false;
  if (digits.slice(14, 16) !== '05') return false;
  const comarcaCode = digits.slice(16, 20);
  const table = loadComarcas();
  if (table && Object.keys(table).length && !table[comarcaCode]) return false;
  return true;
}

function findNpu(text) {
  // Full 20-digit NPU with separators
  const m2 = /(\d{7})[\s\-\.,]*(\d{2})[\s\.,]*(\d{4})[\s\.,]*(\d)[\s\.,]*(\d{2})[\s\.,]*(\d{4})/.exec(text);
  if (m2) {
    const digits = m2[1] + m2[2] + m2[3] + m2[4] + m2[5] + m2[6];
    if (digits.length === 20 && isValidNpuCandidate(digits)) {
      return normalizeNpu(`${digits.slice(0, 7)}-${digits.slice(7, 9)}.${digits.slice(9, 13)}.${digits[13]}.${digits.slice(14, 16)}.${digits.slice(16)}`);
    }
  }

  // Near PROCESSO keyword
  const m = text.match(/PROCESSO(?:\s+ELETRONICO|ELETRÔNICO|ELETRONICO)?\s*[:\-–]?\s*([0-9\.\-, ]{10,})/i);
  if (m) {
    let val = m[1].trim().replace(/,/g, '.');
    val = val.replace(/\s+/g, '').replace(/^[.\-]+|[.\-]+$/g, '');
    const digitsOnly = val.replace(/\D/g, '');
    if (digitsOnly.length >= 16) {
      const digits = digitsOnly.slice(0, 20).padStart(20, '0');
      if (isValidNpuCandidate(digits)) return normalizeNpu(digits);
    }
  }

  // Partial NPU: allows missing leading digits
  const mPartial = text.match(/(\d{5,7})[\s\-\.,]*(\d{2})[\s\-\.,]*(\d{4})[\s\-\.,]*(\d)[\s\-\.,]*(\d{2})[\s\-\.,]*(\d{4})/);
  if (mPartial) {
    const digits = mPartial[1] + mPartial[2] + mPartial[3] + mPartial[4] + mPartial[5] + mPartial[6];
    if (digits.length >= 16) {
      const padded = digits.padStart(20, '0');
      if (isValidNpuCandidate(padded)) {
        return normalizeNpu(`${padded.slice(0, 7)}-${padded.slice(7, 9)}.${padded.slice(9, 13)}.${padded[13]}.${padded.slice(14, 16)}.${padded.slice(16)}`);
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Partes
// ---------------------------------------------------------------------------
function applyOcrFixes(v) {
  v = v.replace(/\bPB\b/g, 'PE');
  v = v.replace(/\bPR\b/g, 'DR');
  v = v.replace(/\bQ\b/g, 'O');
  v = v.replace(/(?<=[A-ZÀ-Ý])0(?=[A-ZÀ-Ý])/g, 'O');
  v = v.replace(/(?<=[A-ZÀ-Ý])1(?=[A-ZÀ-Ý])/g, 'I');
  v = v.replace(/(?<=[A-ZÀ-Ý])5(?=[A-ZÀ-Ý])/g, 'S');
  v = v.replace(/(?<=[A-ZÀ-Ý])8(?=[A-ZÀ-Ý])/g, 'B');
  v = v.replace(/(?<=[A-ZÀ-Ý])6(?=[A-ZÀ-Ý])/g, 'G');
  return v;
}

function cleanParteName(v) {
  v = v.replace(/^([A-ZÀ-Ý])\1{2,}\s*/, '');
  v = v.replace(/[\.]+$/, '');
  v = v.replace(/[,]\s*$/, '');
  v = v.replace(/\s*[,\.]?\s*[\d\-\–\—\s]*$/, '');
  v = v.replace(/^AUTORA\s+S?\s*[:]?\s*/i, '');
  v = v.replace(/^AUTOR\s+A?\s*[:]?\s*/i, '');
  v = v.replace(/^REQUERENTE\s*[:]?\s*/i, '');
  v = v.replace(/^PARTE\(S\)\s*[:]?\s*/i, '');
  v = v.replace(/[!@#$%^&*()_+=\[\]{}<>|\\/:;"'`~]+/g, ' ');
  v = applyOcrFixes(v);
  v = v.replace(/(?<=[a-zà-ÿ])(?=[A-ZÀ-Ý])(?=.{8,})/g, ' ');
  v = v.replace(/[^a-zA-ZÀ-ÿ\s,\-]/g, '');
  v = v.replace(/\s+/g, ' ').trim();
  for (;;) {
    const old = v;
    v = v.replace(/\s+[a-z]{1,3}$/, '');
    v = v.replace(/\s+[a-z][A-Z][a-z]?\s*$/, '');
    v = v.replace(/\s+[A-Z][a-z]+\s*$/, '');
    v = v.replace(/\s+[bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ]\s*$/, '');
    v = v.replace(/\s*[a-z]+\s*$/, '');
    v = v.replace(/(?:\s+[b-df-hj-np-tv-zB-DF-HJ-NP-TV-Z]{2,})+$/, '');
    v = v.replace(/(?<=[a-zà-ÿ])(?=[A-ZÀ-Ý])(?=.{8,})/g, ' ');
    v = v.trim();
    if (v === old) break;
  }
  const words = v.split(' ');
  if (words.length > 8 && words.slice(8).some(w => /[a-z]/.test(w))) {
    v = words.slice(0, 8).join(' ');
  }
  return v;
}

function findPartes(text) {
  const patterns = [
    /PARTE\(S\)\s+AUTORA\(S\)\s*[:\-–]?\s*(.+?)(?=PARTE\(S\)\s+R[EÉ]U|PARTE\(S\)\s+R[EÉ]\(S\)|PROCESSO|REQUERID[OA]|\bR[EÉ]U\b|RÉU|ADVOGADO|OAB|$)/is,
    /PARTE\(S\)\s*(?:AUTORA\(S\))?\s*[:\-–]?\s*(.+?)(?=PARTE\(S\)\s+R[EÉÉ]U|PARTE\(S\)\s+R[ÉE]\(S\)|PROCESSO|REQUERID[OA]|\bR[EÉ]U\b|RÉU|ADVOGADO|OAB|$)/is,
    /AUTORA\(S\)\s*[:\-–]?\s*(.+?)(?=PARTE\(S\)|RÉU|REQUERID[OA]|PROCESSO|ADVOGADO|\bR[EÉ]U\b|$)/is,
    /REQUERENTE\s*[:\-–]?\s*(.+?)(?=REQUERID[OA]|RÉU|PROCESSO|PARTE\(S\)|ADVOGADO|$)/is,
    /PARTE\(S\)[:\-–]?\s*(.+?)(?=PROCESSO|REQUERID[OA]|\bR[EÉ]U\b|RÉU|ADVOGADO|OAB|$)/is,
  ];
  for (const pat of patterns) {
    const m = pat.exec(text);
    if (m) {
      const v = m[1].trim();
      if (v.length > 2) return cleanParteName(v);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Comarca
// ---------------------------------------------------------------------------
const KNOWN_COMARCAS = {
  'ILHEUS': 'ILHÉUS', 'ILHÉUS': 'ILHÉUS', 'ILEUS': 'ILHÉUS', 'LHEUS': 'ILHÉUS',
  'VALENGA': 'VALENÇA', 'VALENCA': 'VALENÇA', 'VALENÇA': 'VALENÇA',
  'FEIRA DE SANTANA': 'FEIRA DE SANTANA',
  'ITAMARAJU': 'ITAMARAJU', 'TAMARAJU': 'ITAMARAJU',
  'PORTO SEGURO': 'PORTO SEGURO',
  'CAMAGAR': 'CAMAÇARI', 'CAMARARI': 'CAMAÇARI', 'CAMACAAI': 'CAMAÇARI',
  'CAMAÇARI': 'CAMAÇARI',
  'SALVADOR': 'SALVADOR', 'BALVADOR': 'SALVADOR', 'SALVADOA': 'SALVADOR',
  'VITORIA DA CONQUISTA': 'VITÓRIA DA CONQUISTA',
  'VIT OA CONQUISTA': 'VITÓRIA DA CONQUISTA',
  'VIT, DA CONQUISTA': 'VITÓRIA DA CONQUISTA',
  '1PIRA': 'IPIRA', 'IPIRA': 'IPIRA',
  'ITABUNA': 'ITABUNA', '1TABUNA': 'ITABUNA', 'TABUNA': 'ITABUNA',
  'VITÓRIA DA CONQUISTA': 'VITÓRIA DA CONQUISTA',
  'CONCEICAO DO COITE': 'CONCEIÇÃO DO COITÉ',
  'CONCEIGAO DO COITE': 'CONCEIÇÃO DO COITÉ',
  'CONCEIÇÃO DO COITÉ': 'CONCEIÇÃO DO COITÉ',
  'TEIXEIRA DE FREITAS': 'TEIXEIRA DE FREITAS',
  'TELXELRA DE FRELLAS': 'TEIXEIRA DE FREITAS',
  'LAURO DE FREITAS': 'LAURO DE FREITAS',
  'LAUAO DE FREITAS': 'LAURO DE FREITAS',
  'CANAVIEIRAS': 'CANAVIEIRAS',
  'SERRINHA': 'SERRINHA',
  'IRECE': 'IRECÊ', 'IAECE': 'IRECÊ',
  'JACOBINA': 'JACOBINA', 'JACOSINA': 'JACOBINA',
  'BARREIRAS': 'BARREIRAS', 'BARREIAAS': 'BARREIRAS', 'BARFEIRAS': 'BARREIRAS',
  'BOM JESUS DA LAPA': 'BOM JESUS DA LAPA',
  'BOM JESUS DALAPA': 'BOM JESUS DA LAPA',
  'RIACHAO DO JACUIPE': 'RIACHÃO DO JACUÍPE',
  'RIACHÃO DO JACUÍPE': 'RIACHÃO DO JACUÍPE',
  'JACUIPE': 'RIACHÃO DO JACUÍPE',
  'JACUÍPE': 'RIACHÃO DO JACUÍPE',
  'PAULO AFONSO': 'PAULO AFONSO', 'AFONSO': 'PAULO AFONSO',
  'SANTO ANTONIO DE JESUS': 'SANTO ANTÔNIO DE JESUS',
  'SANTO ANTÔNIO DE JESUS': 'SANTO ANTÔNIO DE JESUS',
  'SANTO ESTEVAO': 'SANTO ESTEVÃO',
  'SANTO ESTEVÃO': 'SANTO ESTEVÃO',
  'BRUMADO': 'BRUMADO', 'BRUMADO-': 'BRUMADO',
  'GANDU': 'GANDU',
  'ALAGOINHAS': 'ALAGOINHAS',
  'EUNAPOLIS': 'EUNAPOLIS',
  'GUANAMBI': 'GUANAMBI',
  'ITABERABA': 'ITABERABA',
  'JUAZEIRO': 'JUAZEIRO',
  'SANTA MARIA DA VITORIA': 'SANTA MARIA DA VITÓRIA',
  'SANTA MARIA DA VITÓRIA': 'SANTA MARIA DA VITÓRIA',
  'EUCLIDES DA CUNHA': 'EUCLIDES DA CUNHA',
};

function cleanComarca(v) {
  v = v.replace(/\b00\b(?=\s+CONSUMIDOR)/i, 'DO');
  const m = v.match(/(\d+.*|[A-Z]{3,}.*)/);
  if (m) v = m[1];
  v = v.replace(/^[§º°\s\-]+/, '');
  v = v.replace(/(\d+)\s*a\b(?=\s+(?:VSJE|VARA|JUIZADO))/gi, '$1ª');
  v = v.replace(/(\d+)\s*o\b(?=\s+(?:VSJE|VARA|JUIZADO))/gi, '$1º');
  v = v.replace(/^\d+\s+([º°ª]?\d+[º°ª])/, '$1');
  v = v.replace(/\b(\d)\s*[º°ª]?\s+(\d)\s*[º°ª]?\s+(?=(?:VSJE|VARA|JUIZADO))/gi, '$1$2ª ');
  v = v.replace(/(\d+)\s*["º°ª*]+\s*(?=(?:VSJE|VARA|JUIZADO))/gi, '$1ª ');
  v = v.replace(/\b(\d{2})8[º°ª]?\s+(?=(?:VSJE|VARA|JUIZADO))/gi, '$1ª ');
  v = v.replace(/\b(\d+)\s+(?=(?:VSJE|VARA|JUIZADO))/gi, '$1ª ');
  v = v.replace(/\s*\([^)]*(?:\)|$)/g, '');
  v = v.replace(/\s*[{(][^)}]*(?:[)}]|$)/g, '');
  v = v.replace(/'/g, '');
  v = v.replace(/\s*-\s*$/, '');
  v = v.replace(/^\d+,\s+/, '');
  v = v.replace(/^\d+\s+(?=\d+[º°ª]\s)/, '');
  v = v.replace(/^(\d+[º°ª]?)\s+\1\s+/, '$1 ');
  v = v.replace(/\bSTO\b/gi, 'SANTO');
  v = v.replace(/\bSTA\b/gi, 'SANTA');
  v = v.replace(/[.;]+$/, '').trim();

  const addrKw = '(?:RUA|AVENIDA|AV\\.|PRACA|PRAÇA|TRAVESSA|BECO|ALAMEDA|RODOVIA|ESTRADA|LARGO|PÇA|ROD)';
  const mAddr = v.match(new RegExp(`^(.+?)\\s+${addrKw}\\b`, 'i'));
  if (mAddr) v = mAddr[1].trim();

  v = v.split(/\s+(?:CEP|EMAIL|TELEFONE|FAX|\d{2}\s*\d{4})/i)[0];
  v = v.split(/\s*[/|]\s*(?:\d|EMAIL|CEP|Funclon|FAX)/i)[0];
  v = v.split(/\s*[-–]\s*BA\b/i)[0];
  v = v.split(/\s+(?:PODER|JuDICIAR|FUNCIONAL|AUA|ANDAR)/i)[0];
  v = v.replace(/[\s"'`:;ªº°]+$/, '').trim();
  v = v.replace(/\s+[oO]\s*$/, '').trim();
  v = v.replace(/[.;]+$/, '').trim();
  v = v.replace(/(\s+[a-zà-ÿ]+)+$/, '').trim();

  if (['COELBA', 'BAHIA'].includes(v.toUpperCase().trim())) return '';

  const vUp = v.toUpperCase().trim();
  const vNorm = removeAccents(vUp);
  for (const key of Object.keys(KNOWN_COMARCAS)) {
    const kNorm = removeAccents(key.toUpperCase());
    if (vNorm === kNorm || vUp === key.toUpperCase()) return KNOWN_COMARCAS[key];
  }
  const sorted = Object.keys(KNOWN_COMARCAS).sort((a, b) => b.length - a.length);
  for (const key of sorted) {
    const kNorm = removeAccents(key.toUpperCase());
    if (vNorm.startsWith(kNorm)) {
      const rest = removeAccents(vUp.slice(key.length)).trim();
      if (rest) { v = v.slice(0, key.length).trim(); return KNOWN_COMARCAS[key]; }
    }
  }

  const replacements = {
    'CAMAGAR!': 'CAMAÇARI', 'CAMAGAR': 'CAMAÇARI',
    'CAMARARI': 'CAMAÇARI', 'CAMACAAI': 'CAMAÇARI',
    '1PIRA': 'IPIRA', '1TABUNA': 'ITABUNA',
    'VIT OA CONQUISTA': 'VITÓRIA DA CONQUISTA',
    'VITORIA DA CONQUISTA': 'VITÓRIA DA CONQUISTA',
    'ITABUNA': 'ITABUNA', 'ILHEUS': 'ILHÉUS', 'ILEUS': 'ILHÉUS',
    'LHEUS': 'ILHÉUS',
    'CONCEIGAO DO COITE': 'CONCEIÇÃO DO COITÉ',
    'CONCEICAO DO COITE': 'CONCEIÇÃO DO COITÉ',
    'TELXELRA DE FRELLAS': 'TEIXEIRA DE FREITAS',
    'LAUAO DE FREITAS': 'LAURO DE FREITAS',
    'BALVADOR': 'SALVADOR', 'SALVADOA': 'SALVADOR',
    'IAECE': 'IRECÊ', 'JACOSINA': 'JACOBINA',
    'BARREIAAS': 'BARREIRAS',
    'TABUNA': 'ITABUNA', 'TAMARAJU': 'ITAMARAJU',
  };
  for (const src of Object.keys(replacements)) {
    v = v.replace(new RegExp(src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), replacements[src]);
  }
  return v.trim();
}

function findComarca(text) {
  const txtUpper = text.toUpperCase();

  // CEP-based
  let cepComarca = null;
  const cepRe = /CEP\s*[:\-–]?\s*\d[\d\.\-,]+\s*[/|]?\s*([A-ZÀ-Ý][A-ZÀ-Ý \(\)]+?)\s*(?:[-–]\s*)?(?:BA|Bahia)\b/i;
  let mCep = cepRe.exec(text);
  if (mCep) cepComarca = cleanComarca(mCep[1].trim());

  const vsjeRe = /(\d{1,2})\s*[ªº°�]?\s*VSJE\s+(?:DO|CO|DE|00)\s+CONSUMIDOR/i;
  let vsjeMatch = null;
  const mVsje = vsjeRe.exec(text.slice(0, 800));
  if (mVsje) {
    const num = parseInt(mVsje[1], 10);
    if (num >= 1 && num <= 20) vsjeMatch = `${num}ª VSJE DO CONSUMIDOR`;
  }

  if (vsjeMatch) {
    if (!cepComarca || cepComarca === 'SALVADOR') return vsjeMatch;
    return cepComarca;
  }
  if (cepComarca) return cepComarca;

  if (txtUpper.includes('SALVADOR')) {
    for (const line of text.split('\n')) {
      const h = line.toUpperCase();
      if (h.includes('VSJE') && h.includes('CONSUMIDOR')) return cleanComarca(line.trim());
    }
  }
  const lines50 = text.split('\n').slice(0, 50);
  for (const line of lines50) {
    const mVer = line.match(/VARA.*?SISTEM.*?JUIZAD[\w]*[\s\-–\/]+(.+)/i);
    if (mVer) {
      const val = mVer[1].trim().replace(/^[\/\-\s]+/, '');
      if (val) return cleanComarca(val);
    }
  }

  const m = cepRe.exec(text);
  if (m) {
    let val = m[1].trim().replace(/^[\/\-\s]+/, '');
    const addrKw = '(?:RUA|AVENIDA|AV\\.|PRACA|PRAÇA|TRAVESSA|BECO|ALAMEDA|RODOVIA|ESTRADA|LARGO|PÇA|ROD|VILA)';
    val = val.split(new RegExp(addrKw, 'i'))[0];
    if (val.length > 2) return cleanComarca(val);
  }

  const mcep = text.match(/CEP\s*[:\-–]?\s*\d[\d\.\-,]+\s*([A-ZÀ-Ý0-9 \(\)\/\.-]+?)\s*[-–]\s*[A-Z]{2}\b/i);
  if (mcep) {
    let val = mcep[1].trim().replace(/^[\/\-\s]+/, '');
    const addrKw = '(?:RUA|AVENIDA|AV\\.|PRACA|PRAÇA|TRAVESSA|BECO|ALAMEDA|RODOVIA|ESTRADA|LARGO|PÇA|ROD|VILA)';
    val = val.split(new RegExp(addrKw, 'i'))[0];
    if (val.length > 2) return cleanComarca(val);
  }

  const m2 = text.match(/([A-ZÀ-Ý ]{3,25})\s*[-–/]\s*(?:BA|B bahia)\b/i);
  if (m2) {
    let val = m2[1].trim().replace(/^[\/\-\s]+/, '');
    if (val.length > 2) return cleanComarca(val);
  }

  const addrKw2 = '(?:RUA|AVENIDA|AV\\.|PRACA|PRAÇA|TRAVESSA|BECO|ALAMEDA|RODOVIA|ESTRADA|LARGO|PÇA|ROD)';
  const mAddr = text.match(new RegExp(`\\b([A-ZÀ-Ý]{3,20}(?:\\s+DE\\s+[A-ZÀ-Ý]{3,20})*)\\s+${addrKw2}\\b`, 'i'));
  if (mAddr) return cleanComarca(mAddr[1].trim());

  const mStandalone = text.match(/\b([A-ZÀ-Ý]{3,20}(?:\s+(?:DE|DO|DA|DOS|DAS)\s+[A-ZÀ-Ý]{3,20})*(?:\s+[A-ZÀ-Ý]{3,20})*)\b/);
  if (mStandalone) {
    const val = mStandalone[1].trim();
    if (val.includes(' ')) {
      const skip = { 'PODER': 1, 'JUDICIARIO': 1, 'JUDICIÁRIO': 1, 'EMAIL': 1, 'TELEFONE': 1, 'FUNCIONAMENTO': 1, 'CEP': 1, 'AUTORA': 1, 'REU': 1, 'REQUERIDO': 1, 'PARTE': 1, 'PROCESSO': 1, 'ELETRONICO': 1, 'ELETRÔNICO': 1, 'ANDAR': 1, 'BLOCO': 1, 'JARDIM': 1, 'CENTRO': 1, 'SIN': 1 };
      if (!skip[val.toUpperCase()]) return cleanComarca(val);
    }
  }

  const mSingle = text.match(/\b(\d?[A-ZÀ-Ý]{4,20})\b/);
  if (mSingle) {
    let val = mSingle[1].trim();
    val = val.replace(/^1(?=[A-Z])/, 'I');
    val = val.replace(/^\d+/, '');
    const skip = { 'PODER': 1, 'JUDICIARIO': 1, 'JUDICIÁRIO': 1, 'EMAIL': 1, 'TELEFONE': 1, 'FUNCIONAMENTO': 1, 'CEP': 1, 'AUTORA': 1, 'REU': 1, 'REQUERIDO': 1, 'PARTE': 1, 'PROCESSO': 1, 'ELETRONICO': 1, 'ELETRÔNICO': 1, 'ANDAR': 1, 'BLOCO': 1, 'JARDIM': 1, 'CENTRO': 1, 'SIN': 1 };
    if (!skip[val.toUpperCase()]) return cleanComarca(val);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Datas / Audiência
// ---------------------------------------------------------------------------
const MONTH_MAP = {
  janeiro: '01', fevereiro: '02', marco: '03', 'março': '03',
  abril: '04', maio: '05', junho: '06', julho: '07',
  agosto: '08', setembro: '09', outubro: '10', novembro: '11', dezembro: '12',
  margo: '03', fanho: '06', fungo: '06', 'fanh0': '06', 'durtho': '06', 'durtHo': '06',
  dunho: '06', 'duatho': '06', durho: '06', duno: '06',
  jutho: '06', junto: '06', funtio: '06', funho: '06', fimho: '06',
  fango: '06', furaho: '06',
  malo: '05', mato: '05', meio: '05',
  setenbro: '09', setenbto: '09', setembto: '09',
  outubto: '10', 'outubro': '10',
  dutho: '06', duriho: '06', denho: '06', dunhe: '06', aurho: '06',
  junhe: '06', dulho: '07', agoato: '08',
  'qutubro': '10', 'qutubto': '10',
  gqutubro: '10', gqutubto: '10',
  julio: '07', junio: '06',
};

function normalizeDateStr(dateText) {
  let cleaned = (dateText || '').toLowerCase().replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  cleaned = cleaned.replace(/º/g, '').replace(/ª/g, '');
  const m = /^(\d{1,2})\s+de\s+([a-zãáéíóúãâêôç]+)\s+de\s+(\d{4})/.exec(cleaned);
  if (!m) return null;
  const day = m[1];
  let monthWord = m[2];
  const year = m[3];
  let month = MONTH_MAP[monthWord];
  if (!month) month = MONTH_MAP[stripAccents(monthWord)];
  if (!month) return null;
  const dayInt = parseInt(day, 10);
  if (dayInt > 31) return null;
  let yr = year;
  const yearInt = parseInt(year, 10);
  if (!Number.isNaN(yearInt)) {
    const cy = currentYear();
    if (yearInt > cy + 1 || yearInt < 2020) yr = String(cy);
  }
  return `${String(dayInt).padStart(2, '0')}/${month}/${yr}`;
}

function findAudienciaDatetime(text) {
  const m = /AUDI[ÊE]NCIA[\s\S]{0,180}?dia\s+(\d{1,2}\s+de\s+[A-Za-zãáéíóúçâêô]+\s+de\s+\d{4})[\s\S]{0,50}?às\s*([0-2]?\d[:]\d{2})/i.exec(text);
  if (m) {
    const dataNorm = normalizeDateStr(m[1].trim());
    return [dataNorm || m[1].trim(), m[2].trim()];
  }
  if (/NAO AGENDADA|NÃO AGENDADA/i.test(text)) return ['N/A', 'N/A'];
  const dates = [];
  for (const mm of text.matchAll(/(\d{1,2}\s+de\s+[A-Za-zãáéíóúçâêô]+\s+de\s+\d{4})/gi)) {
    dates.push([mm.index, mm[1].trim()]);
  }
  const times = [];
  for (const m2 of text.matchAll(/([0-2]?\d[:]\d{2})/g)) {
    times.push([m2.index, m2[1].trim()]);
  }
  if (dates.length && times.length) {
    let best = null, bestDist = 999999;
    for (const [dpos, dval] of dates) {
      for (const [tpos, tval] of times) {
        const dist = Math.abs(tpos - dpos);
        if (dist < bestDist) { bestDist = dist; best = [dval, tval]; }
      }
    }
    if (best) {
      const dNorm = normalizeDateStr(best[0]);
      return [dNorm || best[0], best[1]];
    }
  }
  if (dates.length && times.length) {
    const dNorm = normalizeDateStr(dates[0][1]);
    return [dNorm || dates[0][1], times[0][1]];
  }
  return [null, null];
}

// ---------------------------------------------------------------------------
// AR
// ---------------------------------------------------------------------------
function findArInText(text) {
  const m = /\bY\s*[H]?\s*([0-9O\s]{5,11})\s*[B]?[R]?\b/i.exec(text);
  if (m) {
    let middle = m[1].toUpperCase().replace(/O/g, '0').replace(/o/g, '0');
    middle = middle.replace(/\s+/g, '');
    if (middle.startsWith('20') && middle.length === 8) middle = '0' + middle;
    else if (middle.startsWith('87') && middle.length === 8) middle = '0' + middle;
    if (middle.startsWith('20') && middle.length === 7) middle = '0' + middle;
    else if (middle.startsWith('87') && middle.length === 7) middle = '0' + middle;
    if (middle.length >= 6) return `YH${middle}BR`;
  }
  return null;
}

function findAllArPositions(text) {
  const positions = [];
  for (const m of text.matchAll(/\bY\s*[H]?\s*[0-9O\s]{5,11}\s*[B]?[R]?\b/gi)) {
    const raw = m[0];
    const middle = raw.replace(/O/g, '0').replace(/o/g, '0').replace(/\D/g, '');
    if (middle.length >= 6) positions.push(m.index + m[0].length);
  }
  return [...new Set(positions)].sort((a, b) => a - b);
}

function findAllNpuPositions(text) {
  const candidates = [];
  for (const m of text.matchAll(/(\d{7})[\s\-\.,]*(\d{2})[\s\.,]*(\d{4})[\s\.,]*(\d)[\s\.,]*(\d{2})[\s\.,]*(\d{4})/g)) {
    const digits = m[1] + m[2] + m[3] + m[4] + m[5] + m[6];
    if (digits.length >= 16) candidates.push([m.index, digits.padStart(20, '0')]);
  }
  for (const m of text.matchAll(/(\d{5,7})[\s\-.,]*(\d{2})[\s\.,]*(\d{4})[\s\.,]*(\d)[\s\.,]*(\d{2})[\s\.,]*(\d{4})/g)) {
    const digits = m[1] + m[2] + m[3] + m[4] + m[5] + m[6];
    if (digits.length >= 16) candidates.push([m.index, digits.padStart(20, '0')]);
  }
  for (const m of text.matchAll(/PROCESSO(?:\s+ELETRONICO|ELETRÔNICO)?\s*[:\- –]?\s*([\d\s\-\.]{10,})/gi)) {
    const digits = m[1].replace(/\D/g, '');
    if (digits.length >= 16) candidates.push([m.index, digits.slice(0, 20).padStart(20, '0')]);
  }
  const seen = new Set();
  const validated = [];
  for (const [pos, digits] of candidates) {
    if (digits.length !== 20) continue;
    if (!isValidNpuCandidate(digits)) continue;
    if (seen.has(digits)) continue;
    seen.add(digits);
    validated.push(pos);
  }
  validated.sort((a, b) => a - b);
  if (validated.length >= 2) {
    const filtered = [validated[0]];
    for (const p of validated.slice(1)) {
      if (p - filtered[filtered.length - 1] > 200) filtered.push(p);
    }
    if (filtered.length >= 2) return filtered;
  }
  return validated;
}

function splitTextByProtocol(text, minSectionLen = 30) {
  const npuStarts = findAllNpuPositions(text);
  const arEnds = findAllArPositions(text);
  const audienciaCount = countAudiencias(text);
  const expectedMin = Math.max(1, audienciaCount);

  const splitAt = (positions, mode) => {
    if (positions.length < 2) return null;
    const sections = [];
    if (mode === 'start') {
      let prev = 0;
      for (const pos of positions.slice(1)) {
        const section = text.slice(prev, pos);
        if (section.length >= minSectionLen) sections.push(section);
        else if (sections.length && section.length > 10) sections[sections.length - 1] += section;
        prev = pos;
      }
      const remaining = text.slice(prev);
      if (remaining.length >= minSectionLen) sections.push(remaining);
      else if (sections.length && remaining.length > 10) sections[sections.length - 1] += remaining;
    } else {
      let prev = 0;
      for (const pos of positions) {
        const section = text.slice(prev, pos);
        if (section.length >= minSectionLen) sections.push(section);
        else if (sections.length && section.length > 10) sections[sections.length - 1] += section;
        prev = pos;
      }
    }
    return sections.length ? sections : null;
  };

  const npuSections = splitAt(npuStarts, 'start');
  const arSections = splitAt(arEnds, 'end');
  if (npuStarts && npuSections && npuSections.length >= expectedMin) return npuSections;
  if (arSections && arSections.length >= expectedMin) return arSections;
  let best = null;
  if (npuSections && arSections) best = npuSections.length >= arSections.length ? npuSections : arSections;
  else if (npuSections) best = npuSections;
  else if (arSections) best = arSections;
  if (best) return best;
  return [text];
}

function countAudiencias(text) {
  return (text.match(/\bAUDI[ÊE]NCIA\b/gi) || []).length;
}

function tryFixNpuYear(npu, data) {
  if (!npu || !data) return npu;
  const mNpu = /\.(\d{4})\.8\.05\./.exec(npu);
  const mData = /(\d{4})/.exec(data);
  if (!mNpu || !mData) return npu;
  const npuYear = parseInt(mNpu[1], 10);
  const dataYear = parseInt(mData[1], 10);
  const cy = currentYear();
  if (npuYear < cy - 5 && cy - 3 <= dataYear && dataYear <= cy) {
    return npu.replace(`.${npuYear}.8.05.`, `.${dataYear}.8.05.`);
  }
  return npu;
}

// Deterministic comarca fix exposed for the process orchestrator
const vsjeFixSalvador = (text, comarca) => {
  if (String(comarca).toUpperCase() !== 'SALVADOR' || !text) return comarca;
  const m = /(\d{1,2})\s*[ªº°�]?\s*VSJE\s+(?:DO|CO|DE|00)\s+CONSUMIDOR/i.exec(text.slice(0, 800));
  if (m) {
    const num = parseInt(m[1], 10);
    if (num >= 1 && num <= 20) return `${num}ª VSJE DO CONSUMIDOR`;
  }
  return comarca;
};

module.exports = {
  stripAccents, removeAccents,
  loadComarcas, fixComarcaByNpu,
  normalizeNpu, isValidNpuCandidate, findNpu,
  applyOcrFixes, cleanParteName, findPartes,
  KNOWN_COMARCAS, cleanComarca, findComarca, vsjeFixSalvador,
  normalizeDateStr, findAudienciaDatetime,
  findArInText, findAllArPositions, findAllNpuPositions, countAudiencias,
  splitTextByProtocol, tryFixNpuYear,
};