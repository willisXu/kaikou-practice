// 開口練習室的瀏覽器測試：用 mock.js 模擬 window.claude，跑過主要流程並截圖到 test/shots/。
// 執行：npm install、npx playwright install chromium、npm test。最後印出 "ERRORS: none" 表示沒有頁面錯誤。
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const dir = __dirname;
const out = path.join(dir, 'shots');
fs.mkdirSync(out, { recursive: true });
const app = fs.readFileSync(path.join(dir, '..', 'docs', 'index.html'), 'utf8');
const mock = fs.readFileSync(path.join(dir, 'mock.js'), 'utf8');
const skeleton = (body, withMock) => '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style></head><body>' + (withMock ? '<script>' + mock + '</script>' : '') + body + '</body></html>';
fs.writeFileSync(path.join(dir, 'harness.html'), skeleton(app, true));
fs.writeFileSync(path.join(dir, 'plain.html'), skeleton(app, false));

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  async function newPage(opts, tag) {
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    page.on('console', m => { if (m.type() === 'error' && !/ERR_FAILED|net::/.test(m.text())) errors.push('[' + tag + '] console: ' + m.text()); });
    page.on('pageerror', e => errors.push('[' + tag + '] pageerror: ' + e.message));
    return page;
  }
  const R = {};
  const shot = (p, name, full) => p.screenshot({ path: path.join(out, name), fullPage: !!full });

  // ---------- phone, light ----------
  const phone = await newPage({ viewport: { width: 400, height: 860 }, deviceScaleFactor: 2, colorScheme: 'light' }, 'phone');
  await phone.goto('file://' + path.join(dir, 'harness.html'));
  await phone.waitForFunction(() => document.querySelector('#sync').textContent === '已同步', null, { timeout: 8000 });
  await phone.waitForTimeout(300);
  R.horizToday = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  R.pure = await phone.evaluate(() => {
    const T = window.__kaikouTest;
    const p1 = T.parseCoach('Nice!\nHow are you?\n###\n{"you":"I go","better":"I went","why":"過去式"}\n{"none":true}');
    const p2 = T.parseCoach('Hello there. What do you do?\n```json\n{"none": true}\n```');
    const p3 = T.parseCoach('casual: Hey\nwork: Hello\nSay one.\n###\n{"none": true}');
    const p4 = T.parseCoach('Only text, no separator.');
    const p5 = T.parseCoach('Great job!\n{"you": "a", "better": "b", "why": "c"}');
    return {
      p1: [p1.reply, p1.fixes.length, p1.none], p2: [p2.reply, p2.fixes.length, p2.none], p3: p3.speakText,
      p4: [p4.reply, p4.fixes.length, p4.none], p5: [p5.reply, p5.fixes.length],
      stream: T.streamPart('Hi there\n##'),
      cjk: [T.cjkRatio('這個功能下週上線').toFixed(2), T.cjkRatio('I went hiking').toFixed(2), T.cjkRatio('我 went 爬山').toFixed(2)],
      streak: T.S.streak,
      st: [T.status({ plan: '20', items: { shadow: true, ai: true } }), T.status({ plan: '60', items: { shadow: true, ai: true } }), T.status({ plan: '20', items: { tutor: true } }), T.status(null)],
      mins: [T.minutesOf({ plan: '60', items: { shadow: true, ai: true, chunk: true, listen: true } }), T.minutesOf({ plan: '20', items: { shadow: true, chunk: true } })],
      anki: T.ankiText([{ en: 'A\tB', zh: '<x>', ex: 'ex' }]),
      turnsRoles: T.buildTurns(T.S.chat).map(t => t.role[0]).join(''),
    };
  });
  await shot(phone, '1-today-phone.png', true);
  await phone.click('.item:nth-child(2) .check');
  await phone.waitForTimeout(700);
  R.afterTick = await phone.evaluate(() => ({ chip: !!document.querySelector('.stamp-chip'), toast: document.querySelector('#toast').textContent, streak: window.__kaikouTest.S.streak }));
  await shot(phone, '2-today-stamped-phone.png');
  await phone.click('#t-coach');
  await phone.waitForTimeout(300);
  await shot(phone, '3-coach-chat-phone.png');
  await phone.fill('#msg-input', 'I eat a big lunch and it make me happy');
  await phone.click('#send-btn');
  await phone.waitForTimeout(600);
  await phone.click('#hint-btn');
  await phone.waitForTimeout(300);
  const tbtns = await phone.$$('.msg.c .msg-acts .btn');
  if (tbtns.length) await tbtns[tbtns.length - 1].click();
  await phone.waitForTimeout(300);
  await shot(phone, '4-coach-after-send-phone.png');
  R.chat = await phone.evaluate(() => {
    const S = window.__kaikouTest.S, c = S.chat;
    return { hintButtons: document.querySelectorAll('.hint').length, hintText: (document.querySelector('#hints') || {}).textContent.slice(0, 80), voiceOpts: document.querySelectorAll('#set-voice option').length, turns: c.turns.length, lastMeFx: (c.turns.filter(t => t.r === 'm').pop().fx || []).length, hints: Array.isArray(S.hints) ? S.hints.length : String(S.hints), lastZh: c.turns[c.turns.length - 1].zh || '', calls: window.__calls };
  });
  await phone.click('.chat-acts .btn.primary');
  await phone.waitForTimeout(900);
  await shot(phone, '5-review-phone.png', true);
  R.afterReview = await phone.evaluate(() => {
    const S = window.__kaikouTest.S;
    const st = {};
    for (const [k, v] of window.__store.entries()) { const n = k.split('/').pop(); if (n === 'chat') st.chat = JSON.stringify(v).slice(0, 120); if (n.startsWith('sessions')) st.sessions = (v.items || []).length + '+' + Object.values(v.map || {}).filter(Boolean).length; if (n === 'phrases') st.phrases = (v.items || []).length + '+' + Object.values(v.map || {}).filter(Boolean).length; }
    return { review: !!S.review, chat: !!S.chat, minutes: S.review && S.review.minutes, store: st };
  });
  await phone.click('#t-log');
  await phone.waitForTimeout(400);
  await shot(phone, '6-log-phone.png', true);
  await phone.click('#t-saved');
  await phone.waitForTimeout(300);
  await shot(phone, '7-saved-phone.png');
  R.todayStored = await phone.evaluate(() => {
    const t = new Date(), p = n => String(n).padStart(2, '0');
    const doc = window.__store.get('data/users/u_test/log-' + t.getFullYear() + '-' + p(t.getMonth() + 1));
    return doc.days[t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate())];
  });
  await phone.click('#t-today');
  await phone.waitForTimeout(200);
  await phone.click('.inbox-row .btn.small');
  await phone.waitForTimeout(700);
  await shot(phone, '8-zh-phone.png');
  R.horizCoach = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

  // ---------- desktop, dark ----------
  const desk = await newPage({ viewport: { width: 1200, height: 900 }, colorScheme: 'dark' }, 'desk');
  await desk.goto('file://' + path.join(dir, 'harness.html') + '#coach');
  await desk.waitForFunction(() => document.querySelector('#sync').textContent === '已同步', null, { timeout: 8000 });
  await desk.waitForTimeout(300);
  await shot(desk, '9-coach-chat-desk-dark.png');
  await desk.click('.chat-acts .btn:not(.primary)');
  await desk.click('.chat-acts .btn:not(.primary)');
  await desk.waitForTimeout(300);
  await desk.click('.mode:nth-child(2)');
  await desk.waitForTimeout(200);
  await shot(desk, '10-coach-start-desk-dark.png', true);
  await desk.click('#t-today');
  await desk.waitForTimeout(200);
  await shot(desk, '11-today-desk-dark.png', true);
  await desk.click('#btn-settings');
  await desk.waitForTimeout(200);
  await shot(desk, '12-settings-desk-dark.png');

  // ---------- no window.claude (opened as a plain file) ----------
  const plain = await newPage({ viewport: { width: 400, height: 860 }, colorScheme: 'light' }, 'plain');
  await plain.goto('file://' + path.join(dir, 'plain.html'));
  await plain.waitForTimeout(900);
  R.plain = await plain.evaluate(() => ({ sync: document.querySelector('#sync').textContent, horiz: document.documentElement.scrollWidth > window.innerWidth }));
  await plain.click('.item:nth-child(1) .check');
  await plain.waitForTimeout(700);
  R.plainSaved = await plain.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('kaikou:')));
  await plain.click('#t-coach');
  await plain.waitForTimeout(200);
  await shot(plain, '13-plain-coach-phone.png');

  console.log(JSON.stringify(R, null, 1));
  console.log('ERRORS:', errors.length ? '\n' + errors.join('\n') : 'none');
  await browser.close();
})().catch(e => { console.error('RUN FAILED', e); process.exit(1); });
