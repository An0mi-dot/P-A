const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SHAREPOINT_ROOT_URL = "https://iberdrola.sharepoint.com/sites/JUDCOELBA/Shared%20Documents/Forms/AllItems.aspx";
const SHAREPOINT_TARGET_URL = "https://iberdrola.sharepoint.com/sites/JUDCOELBA/Shared%20Documents/Forms/AllItems.aspx?id=%2Fsites%2FJUDCOELBA%2FShared%20Documents%2FCria%C3%A7%C3%A3o%20de%20Pastas&viewid=b0389131%2Db788%2D4354%2D8edd%2Dcfe27a229f93";
const CHECKPOINT_FILE = path.join(__dirname, '.criador_checkpoint.json');
const REFRESH_INTERVAL = 50;
const DIALOG_TIMEOUT = 30000;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(resolve => rl.question(q, resolve));

async function getFooterCount(page) {
  try {
    // Espera o rodapé aparecer (pode demorar após refresh)
    await page.waitForSelector('[data-automationid="FooterItemRowAggregateValue"]', { timeout: 10000 }).catch(() => {});
    return await page.evaluate(() => {
      const el = document.querySelector('[data-automationid="FooterItemRowAggregateValue"]');
      if (el) return parseInt(el.innerText.trim()) || 0;
      const all = Array.from(document.querySelectorAll('span, div'));
      for (const e of all) {
        if ((e.innerText || '').trim() === 'Contagem') {
          const next = e.parentElement?.querySelector('[data-automationid="FooterItemRowAggregateValue"]')
            || e.nextElementSibling;
          if (next) return parseInt(next.innerText.trim()) || 0;
        }
      }
      return 0;
    });
  } catch(e) { return 0; }
}

async function getMaxFolderNumber(page) {
  const items = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('div[role="row"]'));
    return rows.map(r => {
      const nameDiv = r.querySelector('.ms-List-cell[data-automation-key="name"] a')
        || r.querySelector('span.signalField_491295e4')
        || r.querySelector('[data-automation-key="name"] span, [data-automation-key="name"] a')
        || r.querySelector('a[href*="OFICIO"]');
      return nameDiv ? nameDiv.innerText.trim() : "";
    });
  });
  const numeros = [];
  items.forEach(it => {
    const m = it.match(/OFICIO\s+(\d+)/i);
    if (m) { numeros.push(parseInt(m[1])); }
  });
  numeros.sort((a, b) => a - b);
  return { max: numeros.length > 0 ? numeros[numeros.length - 1] : 0, total: numeros.length, todos: numeros };
}

async function waitForPageReady(page) {
  await page.waitForSelector('div[role="row"], .ms-List-cell', { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(2000);
}

async function refreshPage(page) {
  console.log(">> Recarregando página (reset DOM)...");
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForPageReady(page);
}

function loadCheckpoint() {
  try {
    if (fs.existsSync(CHECKPOINT_FILE)) return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
  } catch(e) {}
  return null;
}

function saveCheckpoint(data) {
  try { fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(data, null, 2), 'utf8'); } catch(e) {}
}

function clearCheckpoint() {
  try { if (fs.existsSync(CHECKPOINT_FILE)) fs.unlinkSync(CHECKPOINT_FILE); } catch(e) {}
}

async function createSingleFolder(page, folderName) {
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const btnNew = page.locator('button[name="Novo"], button[name="New"], button[data-automation-id="newItemCommand"]');
      await btnNew.waitFor({ timeout: 15000 });
      await btnNew.click();
      await page.waitForTimeout(500);

      const menuFolder = page.locator('button[name="Pasta"], button[name="Folder"], li[name="Pasta"]');
      await menuFolder.waitFor({ timeout: 10000 });
      await menuFolder.click();
      await page.waitForTimeout(500);

      const input = page.locator('input[id*="folderName"], input.ms-TextField-field');
      await input.waitFor({ timeout: 10000 });
      await input.fill(folderName);
      await page.waitForTimeout(300);

      const btnCreate = page.locator('button.ms-Button--primary, button:has-text("Criar")');
      await btnCreate.waitFor({ timeout: 5000 });
      await btnCreate.click();

      try {
        await btnCreate.waitFor({ state: 'hidden', timeout: DIALOG_TIMEOUT });
      } catch (e) {
        // Dialog might still be visible — try pressing Escape to dismiss
        await page.keyboard.press('Escape');
        await page.waitForTimeout(1000);
      }

      await page.waitForTimeout(800);
      return true;
    } catch (err) {
      if (attempt < maxRetries) {
        console.warn(`   Tentativa ${attempt}/${maxRetries} falhou: ${err.message}. Tentando novamente...`);
        await page.waitForTimeout(2000);
        try { await page.keyboard.press('Escape'); } catch(e) {}
        await page.waitForTimeout(1000);
      } else {
        throw err;
      }
    }
  }
  return false;
}

async function main() {
  console.log("==========================================");
  console.log("   CRIADOR DE PASTAS SEQUENCIAIS - PJE    ");
  console.log("   (com checkpoint e recuperação)         ");
  console.log("==========================================");

  const edgePaths = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
  ];
  const edgeExe = edgePaths.find(p => fs.existsSync(p));
  if (!edgeExe) {
    console.error("ERRO: Microsoft Edge não encontrado.");
    process.exit(1);
  }

  console.log("> Iniciando navegador (Faça login se solicitado)...");
  const browser = await chromium.launch({
    executablePath: edgeExe,
    headless: false,
    args: ["--start-maximized", "--disable-blink-features=AutomationControlled"]
  });
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  console.log(`> Acessando: ${SHAREPOINT_ROOT_URL}`);
  try {
    await page.goto(SHAREPOINT_TARGET_URL, { timeout: 120000, waitUntil: 'domcontentloaded' });
  } catch(e) {
    console.error("Aviso: timeout na navegação inicial:", e.message);
  }

  console.log(">> Aguardando carregamento da lista de arquivos...");
  await waitForPageReady(page);

  console.log("\n[!] Página carregada.");

  // Pequena pausa para o rodapé renderizar
  await page.waitForTimeout(2000);

  // Verificar checkpoint
  const ck = loadCheckpoint();
  if (ck && ck.lastCreated) {
    const resume = await ask(`Checkpoint encontrado: última pasta criada foi OFICIO ${ck.lastCreated}. Deseja continuar? (s/N): `);
    if (resume.toLowerCase() === 's') {
      console.log(`> Retomando da pasta OFICIO ${ck.lastCreated + 1}...`);
    } else {
      clearCheckpoint();
    }
  }

  // Ler contagem do rodapé (mais confiável — mostra total de itens)
  let startFrom = 0;
  try {
    const footerCount = await getFooterCount(page);
    if (footerCount > 0) {
      console.log(`> Rodapé SharePoint: ${footerCount} itens no total`);
      startFrom = footerCount;
    } else {
      console.log("> Rodapé não disponível, lendo lista visual...");
    }
  } catch(e) {
    console.log("> Não foi possível ler o rodapé, lendo lista visual...");
  }

  // Fallback: escanear linhas visíveis do DOM para achar o maior OFICIO
  try {
    const dirInfo = await getMaxFolderNumber(page);
    if (dirInfo.max > startFrom) {
      console.log(`> Lista detectou OFICIO ${dirInfo.max} — maior que contagem do rodapé, usando ${dirInfo.max}`);
      startFrom = dirInfo.max;
    }
    if (dirInfo.total > 0) {
      const gaps = [];
      for (let g = 1; g <= dirInfo.max; g++) {
        if (!dirInfo.todos.includes(g)) gaps.push(g);
      }
      console.log(`> Pastas OFICIO encontradas na lista: ${dirInfo.total}`);
      if (gaps.length > 0) console.log(`> Lacunas: ${gaps.length} números faltando entre 1 e ${dirInfo.max}`);
    }
  } catch(e) {
    console.error("Erro ao escanear lista:", e.message);
  }

  // Se checkpoint tem um número maior, usar ele
  if (ck && ck.lastCreated && ck.lastCreated > startFrom) {
    startFrom = ck.lastCreated;
  }

  const countStr = await ask(`\nQuantas pastas deseja criar? (começando de OFICIO ${startFrom + 1}): `);
  const count = parseInt(countStr);
  if (isNaN(count) || count <= 0) {
    console.log("Quantidade inválida. Encerrando.");
    await browser.close();
    process.exit(0);
  }

  console.log(`\n> Iniciando criação de ${count} pastas (OFICIO ${startFrom + 1} a OFICIO ${startFrom + count})...`);
  console.log(`> A página será recarregada a cada ${REFRESH_INTERVAL} pastas para evitar acúmulo de memória.\n`);

  let created = 0;
  let current = startFrom + 1;
  const target = startFrom + count;

  while (current <= target) {
    try {
      const folderName = `OFICIO ${current}`;

      // Refresh periódico
      if (created > 0 && created % REFRESH_INTERVAL === 0) {
        await refreshPage(page);
        // Re-ler do SharePoint pra garantir que não pulamos nenhuma
        const dirInfo = await getMaxFolderNumber(page);
        if (dirInfo.max >= current) {
          current = dirInfo.max + 1;
          if (current > target) break;
        }
      }

      process.stdout.write(`Creating ${folderName}... `);
      await createSingleFolder(page, folderName);
      console.log("OK");

      created++;
      saveCheckpoint({ lastCreated: current, totalCreated: created, startedAt: new Date().toISOString() });

      if (created % 10 === 0) {
        console.log(`   → ${created} pastas criadas (última: ${folderName})`);
      }

      current++;
    } catch (err) {
      console.error(`\n❌ ERRO em OFICIO ${current}: ${err.message}`);

      const action = await ask("[R] Tentar novamente, [P] Recarregar e tentar, [S] Sair: ");
      const cmd = action.toLowerCase();

      if (cmd === 'r') {
        continue; // retry same folder
      } else if (cmd === 'p') {
        try {
          await refreshPage(page);
          // Re-sync current number
          try {
            const dirInfo = await getMaxFolderNumber(page);
            if (dirInfo.max >= current) current = dirInfo.max + 1;
          } catch(e) {}
          continue;
        } catch(e) {
          console.error("Falha ao recarregar:", e.message);
        }
      } else {
        console.log("Saindo...");
        break;
      }
    }
  }

  clearCheckpoint();
  console.log(`\n✅ Processo finalizado. ${created} pastas criadas com sucesso.`);
  await ask("Pressione ENTER para sair...");
  await browser.close();
  process.exit(0);
}

main();