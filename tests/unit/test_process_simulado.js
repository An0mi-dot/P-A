const path = require('path');
const proc = require('../../src/protocolos/process');

(async () => {
const fileToTest = process.argv[2] || 'simulado_6_paginas_scanned.pdf';
const pdfPath = path.join(__dirname, '..', 'fixtures', fileToTest);
  console.log('Iniciando processamento de teste:', pdfPath);
  const results = await proc.processPdfMulti(pdfPath, {
    modoAgencia: false,
    onLog: (level, msg) => {
      console.log(`[${level.toUpperCase()}] ${msg}`);
    }
  });
  console.log('\n--- RESULTADOS FINAIS ---');
  results.forEach((r, idx) => {
    console.log(`\nProtocolo #${idx + 1}:`);
    console.log(`  Parte: ${r.parte}`);
    console.log(`  NPU: ${r.npu}`);
    console.log(`  Comarca: ${r.comarca}`);
    console.log(`  Data: ${r.data}`);
    console.log(`  Hora: ${r.hora}`);
    console.log(`  AR: ${r.ar}`);
  });
})();
