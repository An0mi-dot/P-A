// Pré-processamento de imagem portado de src/extractor.py (PIL + numpy).
// Opera em Uint8Array grayscale [0..255] e devolve novas imagens (canvia) PNG.
'use strict';

const pdf = require('./pdf');

// Máximo lado de trabalho p/ pré-processamento pesado (full/aggressive).
// Reduz o custo de boxBlur/median/sharpen (JS puro). O preprocessSoft NÃO usa
// downscale (vai a resolução nativa 400dpi) pois é a fonte da leitura de NPUs.
const WORK_MAX = 2400;

function toWorking(img) {
  const scale = Math.min(WORK_MAX / Math.max(img.width, img.height), 1.0);
  if (scale >= 1.0) return img;
  return pdf.resizeImage(img, Math.round(img.width * scale), Math.round(img.height * scale));
}

// Lança manualmente, pois é um pseudo-lib para grande edição de pixels.
function uint8LFromRGBA(rgba, len) {
  const L = new Uint8Array(len);
  for (let i = 0, j = 0; i < len; i++, j += 4) {
    L[i] = (rgba[j] * 299 + rgba[j + 1] * 587 + rgba[j + 2] * 114) / 1000;
  }
  return L;
}

function toRGBA(L, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, j = 0; i < L.length; i++, j += 4) {
    const v = L[i];
    out[j] = v; out[j + 1] = v; out[j + 2] = v; out[j + 3] = 255;
  }
  return out;
}

function grayscale(img) {
  return uint8LFromRGBA(getPixRgbaData(img), img.width * img.height);
}
function getPixRgbaData(img) { return pdf.pixelsRGBA(img).data; }

// Equalização de histograma (CDF) — port da parte 2 de _preprocess_image
function histEqualize(L, n) {
  const hist = new Float64Array(256);
  for (let i = 0; i < n; i++) hist[L[i]]++;
  const cdf = new Float64Array(256);
  let acc = 0;
  let cdfMin = Infinity;
  for (let i = 0; i < 256; i++) { acc += hist[i]; cdf[i] = acc; }
  for (let i = 0; i < 256; i++) if (cdf[i] > 0) { cdfMin = cdf[i]; break; }
  const total = acc;
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    lut[i] = Math.round(((cdf[i] - cdfMin) / (total - cdfMin)) * 255);
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = lut[L[i]];
  return out;
}

// BoxBlur sobre Uint8Array grayscale — passa horizontal+vertical, O(n)
function boxBlur(L, w, h, radius) {
  const r = radius;
  const n = w * h;
  const tmp = new Uint8Array(n);
  const out = new Uint8Array(n);
  // horizontal
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0, cnt = 0;
    for (let x = -r; x <= r; x++) { if (x >= 0 && x < w) { sum += L[row + x]; cnt++; } }
    for (let x = 0; x < w; x++) {
      const removeX = x - r - 1;
      const addX = x + r;
      if (removeX >= 0) { sum -= L[row + removeX]; cnt--; }
      if (addX < w) { sum += L[row + addX]; cnt++; }
      tmp[row + x] = Math.round(sum / cnt);
    }
  }
  // vertical
  for (let x = 0; x < w; x++) {
    let sum = 0, cnt = 0;
    for (let y = -r; y <= r; y++) { if (y >= 0 && y < h) { sum += tmp[y * w + x]; cnt++; } }
    for (let y = 0; y < h; y++) {
      const removeY = y - r - 1;
      const addY = y + r;
      if (removeY >= 0) { sum -= tmp[removeY * w + x]; cnt--; }
      if (addY < h) { sum += tmp[addY * w + x]; cnt++; }
      out[y * w + x] = Math.round(sum / cnt);
    }
  }
  return out;
}

// Nitidez (convolução / máscara do PIL ImageFilter.SHARPEN = [0,-1,0; -1,5,-1; 0,-1,0]).
// Crucial: só os 4 vizinhos ortogonais, com o centro *5. O laplaciano 3x3 antigo
// subtrabia os 8 vizinhos, o que era forte demais e destruía a imagem limpa
// (OCR nativo lia o RAW limpo e o pré-processado virava lixo).
function sharpen(L, w, h) {
  const out = new Uint8Array(L.length);
  const lastRow = h - 1, lastCol = w - 1;
  for (let y = 1; y < lastRow; y++) {
    const rowu = (y - 1) * w, rowm = y * w, rowd = (y + 1) * w;
    for (let x = 1; x < lastCol; x++) {
      const q = 5 * L[rowm + x]
              - L[rowu + x] - L[rowm + x - 1] - L[rowm + x + 1] - L[rowd + x];
      out[rowm + x] = q < 0 ? 0 : q > 255 ? 255 : q;
    }
  }
  for (let x = 0; x < w; x++) { out[x] = L[x]; out[lastRow * w + x] = L[lastRow * w + x]; }
  for (let y = 0; y < h; y++) { out[y * w] = L[y * w]; out[y * w + lastCol] = L[y * w + lastCol]; }
  return out;
}

// Port de _preprocess_image (full): equalize -> sauvola threshold -> median -> sharpen
function preprocessFull(img) {
  const src = toWorking(img);
  const w = src.width, h = src.height, n = w * h;
  const L = grayscale(src);
  const eq = histEqualize(L, n);
  const localMean = boxBlur(eq, w, h, 15);
  const mean = eq.reduce((a, b) => a + b, 0) / n;
  const vari = eq.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
  const std = Math.sqrt(vari);
  const k = 0.15, R = 128;
  const binary = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const t = localMean[i] * (1.0 + k * (std / R - 1.0));
    binary[i] = eq[i] > t ? 255 : 0;
  }
  const med = medianFilter(binary, w, h, 1);
  const out = sharpen(med, w, h);
  return pdf.imageFromRGBA(w, h, toRGBA(out, w, h));
}

// Mediana (size=3 ou 5) em Uint8Array — por histograma (rápido p/ janelas pequenas)
function medianFilter(L, w, h, radius) {
  const r = radius;
  const out = new Uint8Array(L.length);
  const winSize = (2 * r + 1) * (2 * r + 1);
  const half = Math.floor(winSize / 2) + 1;
  const hist = new Int32Array(256);
  const b = L; // aliás
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      hist.fill(0);
      let count = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        const base = yy * w;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          hist[b[base + xx]]++;
          count++;
        }
      }
      let acc = 0;
      const target = Math.floor(count / 2) + 1;
      for (let v = 0; v < 256; v++) {
        acc += hist[v];
        if (acc >= target) { out[y * w + x] = v; break; }
      }
    }
  }
  return out;
}

// Nitidez (convolução laplaciana / sharpen do PIL)
function sharpenPil(L, w, h) { return sharpen(L, w, h); }

// preprocess_soft: grayscale -> contraste 2.0 -> sharpen.
// Sem toWorking: roda na resolução nativa (400dpi) como em _preprocess_image_soft
// (extractor.py:181-187) — tesseract precisa dos pixels cheios p/ ler os NPUs.
function preprocessSoft(img) {
  const w = img.width, h = img.height, n = w * h;
  const L = grayscale(img);
  // ImageEnhance.Contrast(2.0): novo = 128 + (v-128)*factor (arredondado p/ PIL)
  const cont = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = 128 + (L[i] - 128) * 2.0;
    cont[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return pdf.imageFromRGBA(w, h, toRGBA(sharpen(cont, w, h), w, h));
}

// preprocessAgressive
function preprocessAggressive(img) {
  const src = toWorking(img);
  const w = src.width, h = src.height, n = w * h;
  const L = grayscale(src);
  // autocontrast cutoff=2
  let min = 255, max = 0;
  const sorted = new Uint8Array(L).slice().sort();
  const cutoff2 = sorted.sort((a, b) => a - b);
  min = percentile(cutoff2, 2);
  max = percentile(cutoff2, 98);
  const ac = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = Math.round(((L[i] - min) / Math.max(1, max - min)) * 255);
    ac[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  // otsu
  const thresh = otsu(ac, n);
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = ac[i] > thresh ? 255 : 0;
  const med = medianFilter(b, w, h, 2);
  return pdf.imageFromRGBA(w, h, toRGBA(sharpen(med, w, h), w, h));
}

function percentile(sortedArr, pct) {
  const idx = Math.round((pct / 100) * (sortedArr.length - 1));
  return sortedArr[idx];
}

function otsu(L, n) {
  const hist = new Float64Array(256);
  for (let i = 0; i < n; i++) hist[L[i]]++;
  let total = n;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, maxVar = 0, threshold = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const bet = wB * wF * (mB - mF) * (mB - mF);
    if (bet > maxVar) { maxVar = bet; threshold = t; }
  }
  return threshold;
}

module.exports = { preprocessFull, preprocessSoft, preprocessAggressive, grayscale, histEqualize, boxBlur, medianFilter, sharpen, warmup };

// Força a otimização JIT das funções pesadas (boxBlur/median/sharpen) chamando-as
// algumas vezes com arrays pequenos no load. Sem isso, o V8 às vezes executa a
// primeira chamada grande em modo interpretado (~150x mais lento).
function warmup() {
  const s = 128;
  const a = new Uint8Array(s * s);
  for (let i = 0; i < a.length; i++) a[i] = (i * 7) % 256;
  for (let i = 0; i < 6; i++) {
    boxBlur(a, s, s, 3);
    medianFilter(a, s, s, 1);
    medianFilter(a, s, s, 2);
    sharpen(a, s, s);
  }
  return true;
}
warmup();