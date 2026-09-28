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
