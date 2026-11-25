// Ishlatish: node export.js <nom> <o'lcham>  -> <nom>-<o'lcham>.png
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const [name, size] = [process.argv[2], Number(process.argv[3] || 2048)];
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 640, height: 640 }, deviceScaleFactor: size / 640 });
  await p.setContent(`<html><body style="margin:0">${fs.readFileSync(name + '.svg', 'utf8')}</body></html>`);
  await p.screenshot({ path: `${name}-${size}.png`, clip: { x: 0, y: 0, width: 640, height: 640 } });
  await b.close();
})();
