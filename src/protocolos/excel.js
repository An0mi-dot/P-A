// FallbackConsultant (leitura da planilha de comarcas x escritórios) e
// export_to_excel (3 abas). Port fiel de espaider.py e app.py com exceljs.
'use strict';

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { removeAccents } = require('./extractor');
const config = require('./config_loader');

const EXPECTED_SPREADSHEET = 'Comarcas JEC CÍVEL E ADV RESPONSÁVEIS 2026.xlsx revisado Patricia Pellegrini.xlsx';

// Acha a planilha de fallback na pasta do app ou caminhos configurados.
function findSpreadsheet() {
  const dirs = [];
  try {
    const cfg = config.loadConfig() || {};
    if (cfg.fallback_spreadsheet && fs.existsSync(cfg.fallback_spreadsheet)) return cfg.fallback_spreadsheet;
    if (cfg.spreadsheet_path && fs.existsSync(cfg.spreadsheet_path)) return cfg.spreadsheet_path;
  } catch (e) {}

  try { dirs.push(config.projectRoot()); } catch (e) {}
  try { dirs.push(path.join(__dirname, '..', '..')); } catch (e) {}
  try { dirs.push(process.cwd()); } catch (e) {}
  try { dirs.push(path.join(__dirname, '..', '..', 'Externo', 'ProtocolosPostais')); } catch (e) {}
  try { if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'Externo', 'ProtocolosPostais')); } catch (e) {}
  const user = process.env.USERPROFILE || '';
  if (user) {
    dirs.push(path.join(user, 'Desktop', 'TRABALHO'));
    dirs.push(path.join(user, 'Desktop', 'TRABALHO', 'P-A'));
    dirs.push(path.join(user, 'Desktop'));
    dirs.push(path.join(user, 'Desktop', 'PROG', 'protocolos_postais'));
  }

  for (const d of dirs) {
    try {
      if (!fs.existsSync(d)) continue;
      const files = fs.readdirSync(d);
      const exact = files.find((f) => f.toLowerCase() === EXPECTED_SPREADSHEET.toLowerCase());
      if (exact) return path.join(d, exact);
      for (const f of files) {
        if (/Comarcas JEC.*\.xlsx$/i.test(f)) return path.join(d, f);
      }
    } catch (e) {}
  }
  return null;
}

class FallbackConsultant {
  constructor(spreadsheetPath) {
    this.dfComarcas = [];
    this.dfJuizados = [];
    this.loaded = false;
    this.error = null;
    this.ready = this._load(spreadsheetPath || findSpreadsheet());
  }

  async _load(p) {
    if (!p || !fs.existsSync(p)) {
      this.error = 'Planilha de comarcas não encontrada';
      return;
    }
    try {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(p);
      this.dfComarcas = await this._readSheet(wb, ['COMARCAS x ESCRITÓRIOS', 'COMARCAS X ESCRITORIOS'], 4);
      this.dfJuizados = await this._readSheet(wb, ['SALVADOR JUIZADOS X ESCRITORIOS', 'SALVADOR JUIZADOS X ESCRITÓRIOS'], 1);
      this.loaded = true;
    } catch (e) {
      this.error = e.message || String(e);
    }
  }

  async _readSheet(wb, names, skipRows) {
    const ws = names.map(name => wb.getWorksheet(name)).find(Boolean);
    if (!ws) return [];
    const rows = [];
    ws.eachRow((row, rowNumber) => {
      if (rowNumber <= skipRows + 1) return;
      const values = [];
      row.eachCell({ includeEmpty: true }, (cell) => { values.push(cell.value === null || cell.value === undefined ? '' : String(cell.value)); });
      rows.push(values.map(v => v.trim()));
    });
    // cabeçalho = primeira linha após skipRows
    const headerRow = [];
    ws.getRow(skipRows + 1).eachCell({ includeEmpty: true }, (cell) => { headerRow.push(String(cell.value || '').trim()); });
    const out = rows.map(r => {
      const obj = {};
      headerRow.forEach((h, i) => { if (h) obj[h] = (r[i] || ''); });
      return obj;
    });
    return out;
  }

  _normalize() {
    this.dfComarcas = this.dfComarcas.map(r => ({ ...r, COMARCA_NORM: removeAccents((r.COMARCAS || r.COMARCA || '').replace(/\s+/g, ' ').trim().toUpperCase()) }));
    this.dfJuizados = this.dfJuizados.map(r => ({ ...r, JUIZADO_NORM: removeAccents((r.JUIZADO || '').replace(/\s+/g, ' ').trim().toUpperCase()) }));
  }

  findEscritorio(comarca) {
    if (!this.loaded) {
      if (this.dfComarcas.length) this._normalize(); // sincroniza se já carregou async
      if (!this.dfComarcas.length && !this.dfJuizados.length) return '';
    } else if (!this.dfComarcas.length) {
      return '';
    }
    this._normalize();
    if (!comarca) return '';
    let normC = comarca.replace(/\s+/g, ' ').trim().toUpperCase();
    normC = removeAccents(normC);

    if (normC.includes('VSJE') && normC.includes('CONSUMIDOR')) {
      const normCmp = normC.replace(/[ªº°]/g, '');
      const dfJ = this.dfJuizados.filter(r => (r.JUIZADO_NORM || '').replace(/[ªº°]/g, '').replace(/\s+/g, ' ').trim() === normCmp);
      if (dfJ.length) {
        const col = 'ESCRITORIO RESPONSAVEL' in dfJ[0] ? 'ESCRITORIO RESPONSAVEL' : 'ESCRITÓRIO';
        return (dfJ[0][col] || '').trim();
      }
      return '';
    }

    const exact = this.dfComarcas.filter(r => r.COMARCA_NORM === normC);
    if (exact.length) {
      const col = this._officeColumn(exact[0]);
      const val = (exact[0][col] || '').trim();
      if (/OLHAR A ABA|DIVIDIDOS POR|SÃO DO ESCRITÓRIO|PROCESSOS CÍVEIS|PROCESSOS CIVEIS/i.test(val.toUpperCase())) return '';
      return val;
    }
    const partial = this.dfComarcas.filter(r => {
      const x = r.COMARCA_NORM;
      return normC.startsWith(x) || x.startsWith(normC) || normC.includes(x) || x.includes(normC);
    });
    if (partial.length) {
      const col = this._officeColumn(partial[0]);
      const val = (partial[0][col] || '').trim();
      if (/OLHAR A ABA|DIVIDIDOS POR|SÃO DO ESCRITÓRIO|PROCESSOS CÍVEIS|PROCESSOS CIVEIS/i.test(val.toUpperCase())) return '';
      return val;
    }
    return '';
  }

  _officeColumn(row) {
    const key = Object.keys(row).find((name) => /ESCRIT[ÓO]RIO|RESPONSAVEL|RESPONSÁVEL/i.test(name));
    return key || Object.keys(row)[1] || '';
  }
}

function sanitizeRow(v) {
  return String(v).replace(/\s+/g, ' ').trim();
}

async function exportToExcel(results, filename, dataIntimacao = '') {
  const wb = new ExcelJS.Workbook();
  const hoje = new Date();
  const dd = String(hoje.getDate()).padStart(2, '0');
  const mm = String(hoje.getMonth() + 1).padStart(2, '0');
  const yyyy = hoje.getFullYear();
  const hojeStr = `${dd}/${mm}/${yyyy}`;
  const prazo = new Date(hoje.getTime() + 3 * 86400000);
  const prazoStr = `${String(prazo.getDate()).padStart(2, '0')}/${String(prazo.getMonth() + 1).padStart(2, '0')}/${prazo.getFullYear()}`;

  const colsPostal = ['NOME', 'NPU', 'COMARCA', 'AUDIÊNCIA', 'HORA', ' DATA DA INTIMAÇÃO', 'ESCRITÓRIO', 'MEIO DE PUBLICAÇÃO', 'DATA DE INCLUSÃO NA PLANILHA', 'DATA DE ENVIO PARA CADASTRO', 'PRAZO D+3', 'AR'];
  const colsOutros = ['NOME', 'NPU', 'COMARCA', 'AUDIÊNCIA', 'HORA', ' DATA DA INTIMAÇÃO', 'ESCRITÓRIO', 'MEIO DE PUBLICAÇÃO', 'DATA DE INCLUSÃO NA PLANILHA', 'DATA DE ENVIO PARA CADASTRO', 'PRAZO D+3'];

  const rowsPostal = [];
  const rowsAgencia = [];
  for (const r of results) {
    const parte = String(r.parte || '');
    const npu = String(r.npu || '');
    const comarca = String(r.comarca || '');
    const dataVal = String(r.data || '');
    const hora = String(r.hora || '');
    let ar = String(r.ar || '');
    const arquivoNome = String(r.arquivo || r.source_file || 'arquivo');
    const tipo = r.tipo === 'agencia' ? 'agencia' : 'postal';

    let p = parte.trim() || `Nome não identificado - ${arquivoNome}`;
    let n = npu.trim() || `NPU não identificado - ${arquivoNome}`;
    let c = comarca.trim() || `Comarca não identificada - ${arquivoNome}`;
    let d = dataVal.trim();
    if (!d) d = tipo === 'agencia' ? 'N/A' : `Data não identificada - ${arquivoNome}`;
    let h = hora.trim();
    if (!h) h = tipo === 'agencia' ? 'N/A' : `Hora não identificada - ${arquivoNome}`;
    if (!ar.trim() || ar.trim() === 'YH BR') ar = tipo === 'postal' ? 'YH BR' : '';

    const meioPub = tipo === 'agencia' ? 'AGÊNCIA' : 'PROTOCOLO POSTAL';
    const row = [sanitizeRow(p), sanitizeRow(n), sanitizeRow(c), sanitizeRow(d), sanitizeRow(h), sanitizeRow(dataIntimacao), sanitizeRow(r.escritorio || ''), meioPub, hojeStr, hojeStr, prazoStr];
    if (tipo === 'postal') row.push(sanitizeRow(ar));
    if (tipo === 'agencia') rowsAgencia.push(row); else rowsPostal.push(row);
  }

  const headerFill = {
    'CITAÇÕES E INTIMAÇÕES - POSTAL': 'B8CCE4',
    'CITAÇÕES E INTIMAÇÕES - OFICIAL': 'A9D08E',
    'CITAÇÕES E INTIMAÇÕES - AGÊNCIA': 'F4B084',
  };
  const sheetsConfig = [
    ['CITAÇÕES E INTIMAÇÕES - POSTAL', colsPostal, rowsPostal, [45, 30, 25, 15, 12, 15, 25, 25, 20, 20, 15, 20]],
    ['CITAÇÕES E INTIMAÇÕES - OFICIAL', colsOutros, [], [45, 30, 25, 15, 12, 15, 25, 25, 20, 20, 15]],
    ['CITAÇÕES E INTIMAÇÕES - AGÊNCIA', colsOutros, rowsAgencia, [45, 30, 25, 15, 12, 15, 25, 25, 20, 20, 15]],
  ];

  for (const [sheetName, cols, dataRows, widths] of sheetsConfig) {
    const ws = wb.addWorksheet(sheetName);
    const header = ws.getRow(1);
    cols.forEach((name, i) => {
      const cell = header.getCell(i + 1);
      cell.value = name;
      cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF000000' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${headerFill[sheetName]}` } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
    });
    widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    dataRows.forEach((rowData, ri) => {
      const row = ws.getRow(ri + 2);
      row.height = 15;
      rowData.forEach((val, ci) => {
        const cell = row.getCell(ci + 1);
        cell.value = val;
        cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
        const boldRed = ci === 3 || ci === 4;
        cell.font = { name: 'Arial', size: 10, color: { argb: boldRed ? 'FFFF0000' : 'FF000000' }, bold: boldRed };
      });
    });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }

  await wb.xlsx.writeFile(filename);
}

module.exports = { FallbackConsultant, findSpreadsheet, exportToExcel };