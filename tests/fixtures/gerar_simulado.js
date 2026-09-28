const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

(async () => {
  const edgePaths = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  const edgeExe = edgePaths.find(p => fs.existsSync(p));
  if (!edgeExe) {
    console.error('Edge não encontrado');
    return;
  }
  const browser = await chromium.launch({ executablePath: edgeExe });
  const page = await browser.newPage();

  const html = `
  <!DOCTYPE html>
  <html>
  <head>
  <style>
    @page { size: A4; margin: 0; }
    body { font-family: Arial, sans-serif; font-size: 14px; margin: 0; padding: 0; background: white; }
    .page { page-break-after: always; height: 1100px; padding: 60px; box-sizing: border-box; display: flex; flex-direction: column; }
    .page:last-child { page-break-after: auto; }
    .ar-box { margin-top: 600px; border: 2px solid #000; padding: 25px; font-weight: bold; font-size: 22px; text-align: center; }
    h2 { color: #111; margin-bottom: 20px; }
    p { margin: 12px 0; font-size: 16px; line-height: 1.5; }
  </style>
  </head>
  <body>
    <!-- Protocolo 1 Frente -->
    <div class="page">
      <h2>PODER JUDICIÁRIO DO ESTADO DA BAHIA</h2>
      <p><b>COMARCA DE ILHÉUS - BA</b></p>
      <p><b>PROCESSO ELETRÔNICO:</b> 0019976-86.2025.8.05.0103</p>
      <p><b>PARTE(S) AUTORA(S):</b> JOAO DA SILVA ALMEIDA</p>
      <p>PARTE(S) RÉU(S): COMPANHIA DE ELETRICIDADE DO ESTADO DA BAHIA COELBA</p>
      <p>Fica intimada a parte para comparecer à AUDIÊNCIA designada para o dia 21 de janeiro de 2026 às 14:30.</p>
    </div>
    <!-- Protocolo 1 Verso (AR) -->
    <div class="page">
      <h2>CORREIOS - AVISO DE RECEBIMENTO (AR)</h2>
      <p>OBJETO POSTAL REGISTRADO</p>
      <div class="ar-box">
        YH123456789BR
      </div>
    </div>
    <!-- Protocolo 2 Frente -->
    <div class="page">
      <h2>PODER JUDICIÁRIO DO ESTADO DA BAHIA</h2>
      <p><b>COMARCA DE FEIRA DE SANTANA - BA</b></p>
      <p><b>PROCESSO ELETRÔNICO:</b> 0020006-24.2025.8.05.0103</p>
      <p><b>PARTE(S) AUTORA(S):</b> MARIA SANTOS SOUZA</p>
      <p>PARTE(S) RÉU(S): COMPANHIA DE ELETRICIDADE DO ESTADO DA BAHIA COELBA</p>
      <p>Fica intimada a parte para comparecer à AUDIÊNCIA designada para o dia 25 de fevereiro de 2026 às 09:15.</p>
    </div>
    <!-- Protocolo 2 Verso (AR) -->
    <div class="page">
      <h2>CORREIOS - AVISO DE RECEBIMENTO (AR)</h2>
      <p>OBJETO POSTAL REGISTRADO</p>
      <div class="ar-box">
        YH987654321BR
      </div>
    </div>
    <!-- Protocolo 3 Frente -->
    <div class="page">
      <h2>PODER JUDICIÁRIO DO ESTADO DA BAHIA</h2>
      <p><b>COMARCA DE ITABUNA - BA</b></p>
      <p><b>PROCESSO ELETRÔNICO:</b> 0000069-32.2026.8.05.0088</p>
      <p><b>PARTE(S) AUTORA(S):</b> CARLOS EDUARDO LIMA</p>
      <p>PARTE(S) RÉU(S): COMPANHIA DE ELETRICIDADE DO ESTADO DA BAHIA COELBA</p>
      <p>Fica intimada a parte para comparecer à AUDIÊNCIA designada para o dia 15 de março de 2026 às 11:00.</p>
    </div>
    <!-- Protocolo 3 Verso (AR) -->
    <div class="page">
      <h2>CORREIOS - AVISO DE RECEBIMENTO (AR)</h2>
      <p>OBJETO POSTAL REGISTRADO</p>
      <div class="ar-box">
        YH555666778BR
      </div>
    </div>
  </body>
  </html>
  `;

  await page.setContent(html);
  const fixtureDir = path.join(__dirname, '..', 'fixtures');
  if (!fs.existsSync(fixtureDir)) fs.mkdirSync(fixtureDir, { recursive: true });
  const pdfPath = path.join(fixtureDir, 'simulado_6_paginas.pdf');
  await page.pdf({ path: pdfPath, format: 'A4', printBackground: true });
  await browser.close();
  console.log('PDF gerado com sucesso em:', pdfPath);
})();
