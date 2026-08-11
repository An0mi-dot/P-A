// Gera icon.ico a partir da fonte oficial (public/assets/icon_raw.png),
// com as resoluções exigidas pelo Windows (16/24/32/48/64/128/256).
const fs = require('fs');
const path = require('path');

(async () => {
  try {
    const pngToIco = (await import('png-to-ico')).default;
    const src = path.join('public', 'assets', 'icon_raw.png');
    const buf = await pngToIco(src, [16, 24, 32, 48, 64, 128, 256]);
    fs.writeFileSync('public/assets/icon.ico', buf);
    console.log('Icon generated at public/assets/icon.ico');
  } catch (err) {
    console.error('Error converting icon:', err);
    process.exit(1);
  }
})();