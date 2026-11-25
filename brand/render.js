const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 640, height: 640 }, deviceScaleFactor: 1 });
  for (const n of process.argv.slice(2)) {
    await p.setContent(`<html><body style="margin:0">${fs.readFileSync(n + '.svg', 'utf8')}</body></html>`);
    await p.screenshot({ path: n + '.png', clip: { x: 0, y: 0, width: 640, height: 640 } });
  }
  // doira ko'rinishidagi taqqoslash (Telegram avatar kabi)
  const imgs = process.argv.slice(2).map(n => `<div style="text-align:center;font:16px sans-serif;color:#333"><img src="data:image/png;base64,${fs.readFileSync(n + '.png').toString('base64')}" style="width:220px;height:220px;border-radius:50%;display:block;margin:0 auto 8px"/>${n}<br/><img src="data:image/png;base64,${fs.readFileSync(n + '.png').toString('base64')}" style="width:48px;height:48px;border-radius:50%;margin-top:8px"/></div>`).join('');
  await p.setViewportSize({ width: Math.max(560, 40 + 260 * (process.argv.length - 2)), height: 340 });
  await p.setContent(`<html><body style="margin:0;padding:24px;background:#eef1f5;display:flex;gap:40px;justify-content:center">${imgs}</body></html>`);
  await p.screenshot({ path: 'preview.png' });
  await b.close();
})();
