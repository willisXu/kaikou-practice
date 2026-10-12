// 產生「加到主畫面」用的圖示（docs/icons/）：和頁面左上角一樣的「開口」印章。
// 需要 Playwright 與系統裡的 Noto Serif CJK TC 字型。用法：node tools/make-icons.js
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, '..', 'docs', 'icons');
fs.mkdirSync(out, { recursive: true });

// full: 滿版底色（給會自己裁切圓角的系統：Android maskable、iPhone）；否則是圓角方形、四角透明。
// inset: 內框離邊緣的距離（佔邊長的比例），maskable 要把內容留在中間的安全範圍。
function page(size, full, inset) {
  const r = full ? 0 : Math.round(size * 0.2);
  const pad = Math.round(size * inset);
  const line = Math.max(2, Math.round(size * 0.018));
  const box = size - pad * 2;
  const font = Math.round(box * 0.36);
  return '<!doctype html><html><head><meta charset="utf-8"><style>'
    + 'html,body{margin:0;background:transparent}'
    + '.icon{position:relative;width:' + size + 'px;height:' + size + 'px;border-radius:' + r + 'px;background:#1E5C48}'
    + '.frame{position:absolute;left:' + pad + 'px;top:' + pad + 'px;width:' + box + 'px;height:' + box + 'px;box-sizing:border-box;border:' + line + 'px solid #FFFFFF;border-radius:' + Math.round(box * 0.1) + 'px;'
    + 'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:' + Math.round(font * 0.02) + 'px}'
    + '.frame span{display:block;color:#FFFFFF;font-family:"Noto Serif CJK TC","Noto Serif TC",serif;font-weight:900;font-size:' + font + 'px;line-height:1.08}'
    + '</style></head><body><div class="icon"><div class="frame"><span>開</span><span>口</span></div></div></body></html>';
}

(async () => {
  const browser = await chromium.launch();
  const jobs = [
    ['icon-192.png', 192, false, 0.14],
    ['icon-512.png', 512, false, 0.14],
    ['icon-maskable-512.png', 512, true, 0.22],
    ['apple-touch-icon.png', 180, true, 0.16],
  ];
  for (const [name, size, full, inset] of jobs) {
    const p = await browser.newPage({ viewport: { width: size, height: size } });
    await p.setContent(page(size, full, inset));
    await p.evaluate(() => document.fonts.ready);
    await p.screenshot({ path: path.join(out, name), omitBackground: !full, clip: { x: 0, y: 0, width: size, height: size } });
    await p.close();
    console.log('已寫入 docs/icons/' + name);
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
