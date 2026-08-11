// Gera os bitmaps do instalador (NSIS) na linguagem visual atual: fundo
// branco + azul do tema (light primary #2563eb / dark primary #3b82f6),
// usando public/assets/icon_raw.png como fonte do ícone.
const fs = require('fs');
const path = require('path');
const { Jimp } = require('jimp');

const WHITE = 0xffffffff;
const PRIMARY = 0x2563ebff;     // azul light do tema
const PRIMARY_DARK = 0x3b82f6ff; // azul dark do tema
const BORDER = 0x1d4ed8ff;       // azul mais fechado para contraste (focus)

async function loadLogo() {
  const p = path.join('public', 'assets', 'icon_raw.png');
  if (!fs.existsSync(p)) {
    console.error('fonte não encontrada: ' + p);
    process.exit(1);
  }
  return Jimp.read(p);
}

async function generateAssets() {
  const logo = await loadLogo();

  // Sidebar 164x314 — fundo azul (primário do tema) com o ícone centralizado
  // e o nome EXTRATJUD abaixo em branco.
  const W = 164, H = 314;
  const sidebar = new Jimp({ width: W, height: H, color: PRIMARY });
  const iconSidebar = logo.clone();
  iconSidebar.resize({ w: 100 });
  sidebar.composite(iconSidebar, (W - iconSidebar.width) / 2, 60);

  // Texto "EXTRATJUD" branco desenhado em canvas napi para o BMP
  const { createCanvas } = require('@napi-rs/canvas');
  const canvas = createCanvas(W, 48);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 26px Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('EXTRATJUD', W / 2, 24);
  const textPng = canvas.toBuffer('image/png');
  const textImg = await Jimp.read(textPng);
  sidebar.composite(textImg, 0, 185);
  await sidebar.write('public/assets/installerSidebar.bmp');
  console.log('Sidebar (164x314) saved.');

  // Header 150x57 — fundo branco, ícone à direita.
  const header = new Jimp({ width: 150, height: 57, color: WHITE });
  const iconHeader = logo.clone();
  iconHeader.resize({ h: 46 });
  header.composite(iconHeader, 150 - iconHeader.width - 6, (57 - iconHeader.height) / 2);
  await header.write('public/assets/installerHeader.bmp');
  console.log('Header (150x57) saved.');
}

generateAssets();