const fs = require('fs');
const path = require('path');
const canvas = require('@napi-rs/canvas');
global.Path2D = canvas.Path2D;
global.ImageData = canvas.ImageData;
global.DOMMatrix = canvas.DOMMatrix;
const pdf = require('../../src/protocolos/pdf');

(async () => {
  const inputPdf = path.join(__dirname, 'simulado_6_paginas.pdf');
  const outputPdf = path.join(__dirname, 'simulado_6_paginas_scanned.pdf');
  console.log('Convertendo PDF de texto para PDF 100% rasterizado (scanned)...');

  // Renderiza cada página como imagem pura
  const images = await pdf.renderPages(inputPdf, 300);
  console.log(`Renderizadas ${images.length} páginas como imagem.`);

  // Cria um PDF composto apenas pelas imagens rasterizadas (sem nenhuma camada de texto)
  const { chromium } = require('playwright-core');
  const edgePaths = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  const edgeExe = edgePaths.find(p => fs.existsSync(p));
  const browser = await chromium.launch({ executablePath: edgeExe });
  const page = await browser.newPage();

  let html = `<html><head><style>
    @page { size: A4; margin: 0; }
    body { margin: 0; padding: 0; }
    .page { page-break-after: always; width: 100vw; height: 100vh; display: flex; }
    .page:last-child { page-break-after: auto; }
    img { width: 100%; height: 100%; object-fit: contain; }
  </style></head><body>`;

  for (const img of images) {
    const b64 = pdf.toPng(img).toString('base64');
    html += `<div class="page"><img src="data:image/png;base64,${b64}" /></div>`;
  }
  html += `</body></html>`;

  await page.setContent(html);
  await page.pdf({ path: outputPdf, format: 'A4', printBackground: true });
  await browser.close();
  console.log('PDF 100% scanned gerado em:', outputPdf);
})();
