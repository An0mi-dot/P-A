const path = require('path');
const fs = require('fs');
const os = require('os');
const proc = require('../../src/protocolos/process');

(async () => {
  const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), 'test_proc_out_'));
  const pdfFixture = path.join(__dirname, '..', 'fixtures', 'simulado_6_paginas_scanned.pdf');

  console.log('Testando processFiles...');
  console.log('Origem:', pdfFixture);
  console.log('Destino temporário:', tmpOut);

  const logs = [];
  const ctx = {
    shouldCancel: () => false,
    log: (level, msg) => {
      logs.push({ level, msg });
      console.log(`[${level.toUpperCase()}] ${msg}`);
    },
    progress: (pct) => console.log(`Progresso: ${Math.round(pct)}%`),
  };

  const out = await proc.processFiles(ctx, {
    files: [pdfFixture],
    outputFolder: tmpOut,
    modoAgencia: false,
    headless: true,
  });

  console.log('\n--- RESULTADO PROCESSAMENTO ---');
  console.log('Total de resultados:', out.results.length);
  console.log('Tempo total (s):', out.totalSec);

  // Verifica cópia do PDF
  const copiedFiles = fs.readdirSync(tmpOut);
  console.log('Arquivos na pasta de destino:', copiedFiles);

  const pdfCopied = copiedFiles.some(f => f.endsWith('.pdf'));
  if (!pdfCopied) throw new Error('PDF não foi copiado para a pasta de destino');

  // Testa exportação para Excel
  const xlsxPath = path.join(tmpOut, 'teste_export.xlsx');
  await proc.exportToExcel(out.results, xlsxPath, '25/09/2026');
  if (!fs.existsSync(xlsxPath)) throw new Error('Planilha Excel não foi gerada');
  console.log('Planilha Excel exportada com sucesso:', xlsxPath);

  console.log('\n✔ TESTE DE INTEGRAÇÃO PASSOU COM SUCESSO!');
})();
