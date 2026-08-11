// Render de PDF -> imagens (pdfjs-dist + @napi-rs/canvas) + extração de texto. Offline.
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

if (!process.getBuiltinModule) {
  process.getBuiltinModule = (n) => { try { return require(n); } catch (e) { return require('node:' + n); } };
}

let pdfjs = null;
async function getPdfjs() {
  if (pdfjs) return pdfjs;
  const mod = await import('pdfjs-dist/legacy/build/pdf.mjs');
  mod.GlobalWorkerOptions.workerSrc = pathToFileURL(
    path.join(require.resolve('pdfjs-dist/legacy/build/pdf.mjs'), '..', 'pdf.worker.mjs')
  ).href;
  pdfjs = mod;
  return pdfjs;
}

// --- Image helper type: { canvas, width, height } ---
let napi = null;
function getCanvas() { if (!napi) napi = require('@napi-rs/canvas'); return napi; }

function createImage(w, h) {
  const canvas = getCanvas().createCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
  return { canvas, width: canvas.width, height: canvas.height };
}
function toPng(img) { return img.canvas.toBuffer('image/png'); }
function toJpeg(img, quality = 85) { return img.canvas.toBuffer('image/jpeg', quality); }
function pixelsRGBA(img) { return img.canvas.getContext('2d').getImageData(0, 0, img.width, img.height); }

function imageFromRGBA(w, h, rgba) {
  const img = createImage(w, h);
  const ctx = img.canvas.getContext('2d');
  const imgData = ctx.createImageData(w, h);
  imgData.data.set(rgba.subarray(0, w * h * 4));
  ctx.putImageData(imgData, 0, 0);
  return img;
}

function cropImage(img, x0, y0, x1, y1) {
  const w = Math.max(1, Math.floor(x1 - x0));
  const h = Math.max(1, Math.floor(y1 - y0));
  const src = pixelsRGBA(img).data;
  const sw = img.width;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor(y0 + y));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(sw - 1, Math.floor(x0 + x));
      const si = (sy * sw + sx) * 4;
      const di = (y * w + x) * 4;
      out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2]; out[di + 3] = 255;
    }
  }
  return imageFromRGBA(w, h, out);
}

// Lanczos-like resize via canvas drawImage (napi usa interpolação de alta qualidade)
function resizeImage(img, w, h) {
  const dst = createImage(w, h);
  const ctx = dst.canvas.getContext('2d');
  ctx.drawImage(img.canvas, 0, 0, w, h);
  return dst;
}

function rotate90(img) {
  const dst = createImage(img.height, img.width);
  const ctx = dst.canvas.getContext('2d');
  ctx.save();
  ctx.translate(dst.width / 2, dst.height / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.drawImage(img.canvas, -img.width / 2, -img.height / 2);
  ctx.restore();
  return dst;
}

// --- PDF rendering ---
function buildCanvasFactory() {
  return class {
    constructor() {}
    create(w, h) {
      const canvas = getCanvas().createCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
      return { canvas, context: canvas.getContext('2d') };
    }
    reset(cw, w, h) { cw.canvas.width = Math.max(1, Math.round(w)); cw.canvas.height = Math.max(1, Math.round(h)); }
    destroy(cw) { cw.canvas.width = 0; cw.canvas.height = 0; }
  };
}

async function renderPages(pdfPath, dpi = 400) {
  const { getDocument } = await getPdfjs();
  const data = new Uint8Array(require('fs').readFileSync(pdfPath));
  const pdf = await getDocument({ data, CanvasFactory: buildCanvasFactory() }).promise;
  const images = [];
  const scale = dpi / 72;
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale });
    const { canvas, context } = new (buildCanvasFactory())().create(viewport.width, viewport.height);
    await page.render({ canvasContext: context, viewport }).promise;
    // Dimensões inteiras do canvas (canvas.width/height). O viewport do pdf.js dá
    // floats (ex.: 3306.67) — usar pixels inteiros como o fitz do Python, senão
    // getImageData/ImageData truncam e estouram o buffer nos preprocess nativos.
    images.push({ canvas, width: canvas.width, height: canvas.height });
    page.cleanup();
  }
  try { await pdf.destroy(); } catch (e) {}
  return images;
}

async function extractTextPdf(pdfPath) {
  const { getDocument } = await getPdfjs();
  const data = new Uint8Array(require('fs').readFileSync(pdfPath));
  const pdf = await getDocument({ data, CanvasFactory: buildCanvasFactory() }).promise;
  const texts = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    let out = '';
    let lastY = null;
    for (const item of content.items) {
      if (!item.str) continue;
      const y = Array.isArray(item.transform) ? item.transform[5] : 0;
      if (lastY !== null && y !== lastY) out += '\n';
      lastY = y;
      out += item.str;
    }
    texts.push(out);
    page.cleanup();
  }
  try { await pdf.destroy(); } catch (e) {}
  return texts.join('\n');
}

module.exports = {
  createImage, toPng, toJpeg, pixelsRGBA, imageFromRGBA,
  cropImage, resizeImage, rotate90,
  renderPages, extractTextPdf,
};