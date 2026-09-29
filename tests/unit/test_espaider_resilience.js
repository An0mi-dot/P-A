'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EspaiderAutomator } = require('../../src/protocolos/espaider');

test('EspaiderAutomator - Inicialização com timeouts generosos', () => {
  const defaultAuto = new EspaiderAutomator(true);
  assert.strictEqual(defaultAuto.timeoutMs, 45000, 'Timeout padrão deve ser 45 segundos (45000ms)');

  const customAuto = new EspaiderAutomator(true, { timeoutMs: 60000 });
  assert.strictEqual(customAuto.timeoutMs, 60000, 'Deve respeitar timeout customizado');
});

test('EspaiderAutomator - searchNpu sem página aberta não trava nem quebra', async () => {
  const auto = new EspaiderAutomator(true);
  
  // Deve retornar string vazia para manter compatibilidade
  const res = await auto.searchNpu('0001234-56.2025.8.05.0001');
  assert.strictEqual(res, '');
  assert.strictEqual(auto.lastSearch.ok, false);
  assert.strictEqual(auto.lastSearch.error, 'no_page');
  assert.strictEqual(auto.lastSearch.found, false);
});

test('EspaiderAutomator - NPU vazio retorna vazio com status ok', async () => {
  const auto = new EspaiderAutomator(true);
  auto.page = {}; // mock

  const res = await auto.searchNpuDetailed('');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.found, false);
  assert.strictEqual(res.escritorio, '');
});

test('EspaiderAutomator - recoverSession não lança erro quando página fechada', async () => {
  const auto = new EspaiderAutomator(true);
  auto.page = { isClosed: () => true };
  
  // Não deve estourar exceção
  await assert.doesNotReject(async () => {
    await auto.recoverSession();
  });
});

test('EspaiderAutomator - stop() não trava mesmo se browser.close() pendurar', async () => {
  const auto = new EspaiderAutomator(true);
  let killed = false;
  auto.browser = {
    close: () => new Promise(() => {}), // nunca resolve
    process: () => ({
      killed: false,
      kill: () => { killed = true; }
    })
  };
  
  const start = Date.now();
  await auto.stop();
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 4000, `stop() deve encerrar em menos de 4s (levou ${elapsed}ms)`);
  assert.strictEqual(killed, true, 'Deve matar o processo se o close pendurar');
});

test('Process - applyMissingValueLabels preenche AR não identificado com nome do arquivo', () => {
  const { applyMissingValueLabels } = require('../../src/protocolos/process');
  
  const data = { npu: '0001234-56.2025.8.05.0001', parte: 'Teste', comarca: 'Salvador', ar: '' };
  const issues = applyMissingValueLabels(data, 'arquivo_teste.pdf');
  
  assert.strictEqual(data.ar, 'AR não identificado - arquivo_teste.pdf');
  assert.ok(issues.includes('AR não identificado'));
});

test('EspaiderAutomator - _gridEmpty reconhece variações de grid vazio', async () => {
  const auto = new EspaiderAutomator(true);
  
  // Mock de frame com mensagem 'Sem registros para exibir'
  const mockFrame = {
    locator: (sel) => ({
      count: async () => sel.includes('div.x-paging-info') ? 1 : 0,
      nth: () => ({
        isVisible: async () => true,
        textContent: async () => 'Sem registros para exibir'
      })
    })
  };
  auto._frames = () => [mockFrame];

  const isEmpty = await auto._gridEmpty();
  assert.strictEqual(isEmpty, true, 'Deve reconhecer "Sem registros para exibir" como vazio');
});

test('EspaiderAutomator - _hasZeroRows reconhece grid body com 0 linhas', async () => {
  const auto = new EspaiderAutomator(true);
  
  const mockFrame = {
    locator: (sel) => {
      if (sel.includes('div.x-grid3-body')) {
        return {
          count: async () => 1,
          nth: () => ({
            isVisible: async () => true,
            locator: () => ({ count: async () => 0 })
          })
        };
      }
      return { count: async () => 0 };
    }
  };
  auto._frames = () => [mockFrame];

  const zeroRows = await auto._hasZeroRows();
  assert.strictEqual(zeroRows, true, 'Deve reconhecer grid com 0 linhas');
});

test('OCR - ocrTesseract aceita parâmetro psm com fallback gracioso', async () => {
  const ocr = require('../../src/protocolos/ocr');
  assert.strictEqual(typeof ocr.ocrTesseract, 'function');
  const res = await ocr.ocrTesseract([], 'none', null, { psm: '3' });
  assert.strictEqual(String(res), '');
});

