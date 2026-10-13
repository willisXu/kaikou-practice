// 開口練習室的瀏覽器測試。
// - 「在 Claude 裡」的情境：把 docs/index.html 轉成 Artifact 片段（tools/artifact.js），包上和 Claude 一樣的外框，
//   再用 test/mock.js 模擬 window.claude（雲端資料庫與 AI 教練）。
// - 「直接開檔」的情境：原封不動打開 docs/index.html（file://，用手機模擬；這時不能存 API 金鑰）。
// - 「GitHub Pages」的情境：用本機 http 伺服器，像 GitHub Pages 一樣放在 /kaikou-practice/ 底下（金鑰、備份檔、加到主畫面）。
// - 麥克風與朗讀用 test/speech.js 的替身（無頭瀏覽器沒有真的語音辨識和聲音）；Claude API 用 page.route 模擬，金鑰是假的。
// 每一項檢查失敗都會印出 FAIL，最後以非 0 結束碼結束；全部通過時印出 "ERRORS: none" 和通過的項數。
// 執行：npm install、npx playwright install chromium、npm test。截圖存到 test/shots/。
// 只跑其中幾段：ONLY=3b,6 npm test（段落編號見下面每段的標題）。
'use strict';
const { chromium } = require('playwright');
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { toArtifact } = require('../tools/artifact');

const dir = __dirname;
const out = path.join(dir, 'shots');
fs.mkdirSync(out, { recursive: true });
const full = fs.readFileSync(path.join(dir, '..', 'docs', 'index.html'), 'utf8');
const mock = fs.readFileSync(path.join(dir, 'mock.js'), 'utf8');
const speech = fs.readFileSync(path.join(dir, 'speech.js'), 'utf8');
// Claude publishes the page inside a skeleton like this one; the mock stands in for window.claude.
const skeleton = body => '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style></head><body>' + body + '</body></html>';
const ARTIFACT = path.join(dir, 'harness.html');
fs.writeFileSync(ARTIFACT, skeleton('<script>' + mock + '</script>' + toArtifact(full)));
// The same, with the speech stand-ins (voices and recognition) loaded first.
const ARTIFACT_SPEECH = path.join(dir, 'harness-speech.html');
fs.writeFileSync(ARTIFACT_SPEECH, skeleton('<script>' + speech + '</script><script>' + mock + '</script>' + toArtifact(full)));
const PAGES = path.join(dir, '..', 'docs', 'index.html');

const failures = [];
const errors = [];
let checks = 0;
function check(name, fn) {
  checks++;
  try { fn(); console.log('ok   ' + name); }
  catch (e) { failures.push(name); console.log('FAIL ' + name + '\n     ' + String(e.message).split('\n').join('\n     ')); }
}
const eq = (actual, expected) => assert.deepStrictEqual(actual, expected);
// ONLY=3b,6 runs just those sections (each section's blocks are wrapped in want()).
const SECTIONS = ['1', '2', '3', '3b', '4', '5', '6', '6b', '6c', '7', '8', '9'];
const ONLY = String(process.env.ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
if (ONLY.some(s => !SECTIONS.includes(s))) {
  console.error('ONLY: unknown section ' + ONLY.filter(s => !SECTIONS.includes(s)).join(', ') + ' (sections: ' + SECTIONS.join(', ') + ')');
  process.exit(2);
}
const want = s => !ONLY.length || ONLY.includes(s);
// A Claude API streaming answer (server-sent events) carrying the given text.
function sse(text) {
  const ev = (type, data) => 'event: ' + type + '\ndata: ' + JSON.stringify(Object.assign({ type }, data)) + '\n\n';
  return ev('message_start', { message: { id: 'msg_test', type: 'message', role: 'assistant', content: [], stop_reason: null } })
    + ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    + ev('ping', {})
    + (text.match(/[\s\S]{1,9}/g) || []).map(t => ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: t } })).join('')
    + ev('content_block_stop', { index: 0 })
    + ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } })
    + ev('message_stop', {});
}
const CORS = { 'access-control-allow-origin': '*' };
const sseReply = (route, text) => route.fulfill({ status: 200, headers: Object.assign({ 'content-type': 'text/event-stream; charset=utf-8' }, CORS), body: sse(text) });
// A small static server for docs/, under /kaikou-practice/ like GitHub Pages (service workers need http).
// srv.down = true: every request is dropped, as if the network were gone (Playwright's setOffline does not stop
// a service worker's own fetches, so it cannot show that the stored page is used).
// srv.page = '<html…>': the page is served with this content instead (a new version of the site).
// srv.moved = '/new-home/': the page answers with a redirect there (the site moved); /new-home/ is a small page.
function serve(root) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.json': 'application/json' };
  return new Promise(res => {
    const srv = http.createServer((req, resp) => {
      if (srv.down) { req.socket.destroy(); return; }
      const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (u === '/new-home/') { resp.writeHead(200, { 'content-type': types['.html'] }); resp.end('<!doctype html><meta charset="utf-8"><title>新家</title><p>The site moved here.</p>'); return; }
      if (!u.startsWith('/kaikou-practice/')) { resp.writeHead(404); resp.end(); return; }
      const isPage = u === '/kaikou-practice/' || u === '/kaikou-practice/index.html';
      if (isPage && srv.moved) { resp.writeHead(301, { location: srv.moved }); resp.end(); return; }
      if (isPage && srv.page) { resp.writeHead(200, { 'content-type': types['.html'] }); resp.end(srv.page); return; }
      let f = path.join(root, u.slice('/kaikou-practice/'.length));
      if (u.endsWith('/')) f = path.join(f, 'index.html');
      if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { resp.writeHead(404); resp.end(); return; }
      resp.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(resp);
    }).listen(0, '127.0.0.1', () => res(srv));
  });
}

(async () => {
  // Fake microphone and camera, granted without a prompt (for the 4/3/2 recording).
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  // GitHub Pages over http: a web address like the real one (an API key is only kept there, the backup download
  // name and the home-screen install need it too). Contexts that route the Claude API block the service worker,
  // which would otherwise answer the page's requests out of Playwright's sight.
  const srv = await serve(path.resolve(dir, '..', 'docs'));
  const base = 'http://127.0.0.1:' + srv.address().port + '/kaikou-practice/';
  const now = new Date();
  const NOON = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
  // The date n days from today, as the page writes it (YYYY-MM-DD).
  const dayKey = n => { const d = new Date(NOON); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  async function open(file, opts, tag, init, extra) {
    const ctx = await browser.newContext(opts);
    await ctx.clock.install({ time: NOON }); // time keeps flowing from noon, so no check runs across midnight
    const page = await addPage(ctx, file, tag, init, extra);
    return { ctx, page };
  }
  // extra: script text run before the page's own scripts (the speech stand-ins, a stored key…).
  async function addPage(ctx, file, tag, init, extra) {
    const page = await ctx.newPage();
    await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    // The browser logs the deliberate 401 of the API key scenario as an error; anything else counts.
    const expected = t => /ERR_FAILED|net::/.test(t) || (/^apikey/.test(tag) && /status of 401/.test(t));
    page.on('console', m => { if (m.type() === 'error' && !expected(m.text())) errors.push('[' + tag + '] console: ' + m.text()); });
    page.on('pageerror', e => errors.push('[' + tag + '] pageerror: ' + e.message));
    await page.addInitScript(c => { window.__kaikouTest = true; if (c) window.__mockCfg = c; }, init || null);
    if (extra) await page.addInitScript({ content: extra });
    await page.goto(/^https?:/.test(file) ? file : 'file://' + file);
    await page.waitForFunction(() => window.__kaikouTest && window.__kaikouTest.S && window.__kaikouTest.S.ready, null, { timeout: 10000 });
    return page;
  }
  const until = (page, fn, arg, timeout) => page.waitForFunction(fn, arg, { timeout: timeout || 8000 });
  // Moves a page's clock forward to a time, or by some milliseconds. While time flows, Playwright's clock can lose a
  // jump when its own real-time update finishes just after it (the time goes back), so each jump is checked a moment
  // later and made again if needed.
  async function clockTo(page, target) {
    for (let i = 0; i < 8; i++) {
      const now = await page.evaluate(() => Date.now());
      if (now < target) await page.clock.fastForward(target - now);
      await page.waitForTimeout(120);
      if (await page.evaluate(() => Date.now()) >= target) return;
    }
    throw new Error('the page clock did not move forward');
  }
  const ff = async (page, ms) => clockTo(page, (await page.evaluate(() => Date.now())) + ms);
  // Reloads a file:// page that has just written to its storage. Chromium may load the page again in a new process
  // whose copy of the storage misses writes still on their way, so they get a moment first (the same before another
  // page of the same browser opens and reads them).
  const settle = page => page.waitForTimeout(500);
  async function reloadAfterWrites(page) {
    await settle(page);
    await page.reload();
    await page.waitForFunction(() => window.__kaikouTest && window.__kaikouTest.S && window.__kaikouTest.S.ready, null, { timeout: 10000 });
  }
  // A page that opens while another page of the same browser has just written may not see those writes yet (another
  // process passes them on): it waits until its storage shows them (fn), then opens again so that it starts with them.
  async function seeWrites(page, fn, arg) {
    if (await page.evaluate(fn, arg)) return;
    await until(page, fn, arg, 8000);
    await reloadAfterWrites(page);
  }
  // Stores a made-up API key the way the page itself does, then reloads. (In Chromium, a file:// page whose first
  // localStorage access comes from an init script sometimes loses its later writes on reload, so no init script
  // touches storage.)
  // Under heavy load a write can still be lost now and then, so the key is checked after the reload and stored again.
  async function giveKey(page, key) {
    for (let i = 0; i < 3; i++) {
      await page.evaluate(k => localStorage.setItem('kaikou:api-key', k), key);
      await page.reload();
      await page.waitForFunction(() => window.__kaikouTest && window.__kaikouTest.S && window.__kaikouTest.S.ready, null, { timeout: 10000 });
      if (await page.evaluate(k => localStorage.getItem('kaikou:api-key') === k && window.__kaikouTest.S.sampleState === 'ok', key)) return;
    }
    throw new Error('the API key was not kept after a reload');
  }
  // The page reads everything again when its window gets the focus (at most every 15 seconds). A test that must know
  // when a document is read again keeps that out (an init script stops the focus event before the page sees it).
  const noFocusRefresh = "window.addEventListener('focus', e => e.stopImmediatePropagation(), true);";
  const sync = page => page.evaluate(() => document.querySelector('#sync').textContent);
  const shot = (p, name, fullPage) => p.screenshot({ path: path.join(out, name), fullPage: !!fullPage });
  const horiz = p => p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  const notBusy = p => until(p, () => !window.__kaikouTest.S.busy && !window.__kaikouTest.S.reviewing, null, 10000);

  // ---------- 1. In Claude, on a phone: the whole daily flow ----------
  if (want('1')) {
    const { page } = await open(ARTIFACT, { viewport: { width: 400, height: 860 }, deviceScaleFactor: 2, colorScheme: 'light' }, 'phone');
    await until(page, () => document.querySelector('#sync').textContent === '已同步');
    const pure = await page.evaluate(() => {
      const T = window.__kaikouTest;
      const pc = s => { const p = T.parseCoach(s); return [p.reply, p.fixes.length, p.none]; };
      return {
        sep: pc('Nice!\nHow are you?\n###\n{"you":"I go","better":"I went","why":"過去式"}\n{"none":true}'),
        fence: pc('Hello there. What do you do?\n```json\n{"none": true}\n```'),
        opts: T.parseCoach('casual: Hey\nwork: Hello\nSay one.\n###\n{"none": true}').speakText,
        plain: pc('Only text, no separator.'),
        inline: pc('Great job!\n{"you": "a", "better": "b", "why": "c"}'),
        cut: pc('Sounds great! Where did you go hiking?\n{"you": "I go hiking yesterday", "better": "I w'),
        twoHash: pc('Nice!\n##\n{"none": true}'),
        bracket: pc('[laughs] That is funny!\nWhat else happened?'),
        // A label after the separator is not part of the reply ("None" means no corrections); a real sentence is.
        labels: [pc('Nice!\n###\nNone'), pc('Nice!\n###\nCorrections:\n{"you": "a", "better": "b", "why": "c"}'), pc('Nice!\n###\n{"none": true}\nWhat did you eat?'),
          ...['No corrections needed.', '(no corrections)', 'none: true', 'Corrections: none'].map(t => pc('Great! What is next?\n###\n' + t)),
          pc('###\n{"you": "I go to park", "better": "I went to the park", "why": "過去式"}\nFix it next time!'), pc('###\n{"none": true}\nNotes help a lot.')],
        // A saved phrase keeps 300 characters, so a longer one is recognised by the same cut text.
        longId: (s => [T.phraseId(s) === T.phraseId(s.trim().slice(0, 300)), T.phraseId(s) === T.phraseId(s.trim().slice(0, 290))])('  I ' + 'really '.repeat(60) + 'like it.'),
        streams: ['Hi there\n##', 'Hi there\n#', 'Hi\n{"you', 'Hi ### {'].map(T.streamPart),
        cjk: [T.cjkRatio('這個功能下週上線').toFixed(2), T.cjkRatio('I went hiking').toFixed(2), T.cjkRatio('我 went 爬山').toFixed(2)],
        status: [T.status({ plan: '20', items: { shadow: true, ai: true } }), T.status({ plan: '60', items: { shadow: true, ai: true } }), T.status({ plan: '20', items: { tutor: true } }), T.status(null)],
        mins: [T.minutesOf({ plan: '60', items: { shadow: true, ai: true, chunk: true, listen: true } }), T.minutesOf({ plan: '20', items: { shadow: true, chunk: true } })],
        anki: T.ankiText([{ en: 'A\t<b>', zh: '<x>', ex: 'ex' }]),
        plans: [T.resolvePlan({ 0: '20', 1791780000000: '60' }, ''), T.resolvePlan({ 0: '60' }, '20'), T.resolvePlan({}, ''), T.resolvePlan({ 0: '20', 5: '60' }, '20')],
        review: (r => [r.summary.length, r.phrases.length])(T.normReview({ summary: 'x'.repeat(900), phrases: Array(9).fill({ en: 'a' }) })),
        turns: T.buildTurns(T.S.chat).map(t => t.role[0]).join(''),
        streak: T.S.streak,
      };
    });
    check('教練回覆解析（分隔線、程式碼區塊、截斷的 JSON）', () => {
      eq(pure.sep, ['Nice!\nHow are you?', 1, true]);
      eq(pure.fence, ['Hello there. What do you do?', 0, true]);
      eq(pure.opts, 'Hey\nHello\nSay one.');
      eq(pure.plain, ['Only text, no separator.', 0, false]);
      eq(pure.inline, ['Great job!', 1, false]);
      eq(pure.cut, ['Sounds great! Where did you go hiking?', 0, false]);
      eq(pure.twoHash, ['Nice!', 0, true]);
      eq(pure.bracket, ['[laughs] That is funny!\nWhat else happened?', 0, false]);
      eq(pure.streams, ['Hi there', 'Hi there', 'Hi', 'Hi']);
    });
    check('分隔線後的標籤（None、Corrections:）不算進回覆；很長的句子用存下的長度辨認', () => {
      eq(pure.labels, [['Nice!', 0, true], ['Nice!', 1, false], ['Nice!\nWhat did you eat?', 0, true], ...Array(4).fill(['Great! What is next?', 0, true]), ['Fix it next time!', 1, false], ['Notes help a lot.', 0, true]]);
      eq(pure.longId, [true, false]);
    });
    check('計算：中文比例、達標、分鐘、練習量、連續天數', () => {
      eq(pure.cjk, ['1.00', '0.00', '0.43']);
      eq(pure.status, [2, 1, 1, 0]);
      eq(pure.mins, [60, 10]);
      eq(pure.plans, ['60', '20', '20', '60']);
      eq(pure.streak, 5);
    });
    check('Anki 匯出：標頭與跳脫', () => eq(pure.anki, '#separator:tab\n#html:true\nA &lt;b&gt;\t&lt;x&gt;<br><i>ex</i>'));
    check('複習內容限制長度與數量', () => eq(pure.review, [400, 5]));
    check('送給教練的對話以使用者開頭與結尾', () => eq(pure.turns, 'uuauau'));
    const wideToday = await horiz(page);
    check('今日頁沒有左右捲動', () => eq(wideToday, false));
    await shot(page, '1-today-phone.png', true);

    await page.click('#today-dyn .list .item:nth-child(2) .check');
    await until(page, () => !!document.querySelector('.stamp-chip'));
    const tick = await page.evaluate(() => ({ toast: document.querySelector('#toast').textContent, streak: window.__kaikouTest.S.streak }));
    check('打勾達標會蓋章並延續連續天數', () => eq(tick, { toast: '今日達標，蓋章！', streak: 5 }));

    await page.click('#t-coach');
    await page.fill('#msg-input', 'I eat a big lunch and it make me happy');
    await page.click('#send-btn');
    await notBusy(page);
    await page.click('#hint-btn');
    await until(page, () => Array.isArray(window.__kaikouTest.S.hints));
    const zhBtns = await page.$$('.msg.c .msg-acts .btn');
    await zhBtns[zhBtns.length - 1].click();
    await until(page, () => { const c = window.__kaikouTest.S.chat; return !!c.turns[c.turns.length - 1].zh; });
    await shot(page, '2-coach-phone.png');
    const chat = await page.evaluate(() => {
      const S = window.__kaikouTest.S, c = S.chat;
      const sent = window.__calls.filter(x => x.kind === 'sample');
      return {
        hintButtons: document.querySelectorAll('.hint').length, turns: c.turns.length,
        fixes: (c.turns.filter(t => t.r === 'm').pop().fx || []).length, zh: c.turns[c.turns.length - 1].zh,
        chatCall: sent.filter(x => x.roles !== 's').map(x => [x.roles, x.cache]), hintCall: sent.filter(x => /stuck/.test(x.head || '')).map(x => x.cache),
        // The buttons under each better way to say it have Chinese names: they are not marked as English text.
        fixLang: [...new Set([...document.querySelectorAll('#msgs .fix-acts button')].map(b => b.closest('[lang]').getAttribute('lang')))],
      };
    });
    check('送出一句：教練回覆並附上 2 個更自然的說法', () => { eq(chat.turns, 7); eq(chat.fixes, 2); eq(chat.chatCall, [['uuauauau', false]]); });
    check('提示與翻譯', () => { eq(chat.hintButtons, 3); eq(chat.hintCall, [false]); eq(chat.zh, '我很好，謝謝！你這個週末過得怎麼樣？'); });

    // The keyboard focus follows the review: to 停止 while the coach works on it, then to the review's heading.
    await page.evaluate(() => { window.__mockCfg.jsonDelay = 900; });
    await page.click('[data-fk="review"]');
    await until(page, () => window.__kaikouTest.S.reviewing);
    const focusWhile = await page.evaluate(() => document.activeElement && document.activeElement.dataset.fk);
    await until(page, () => !!window.__kaikouTest.S.review && !window.__kaikouTest.S.reviewing, null, 10000);
    const focusAfter = await page.evaluate(() => { const a = document.activeElement; return a === document.querySelector('#coach-dyn h2') && a.textContent === window.__kaikouTest.S.review.label; });
    await page.evaluate(() => { window.__mockCfg.jsonDelay = 30; });
    await until(page, () => window.__store.get('data/users/u_test/chat').active === false, null, 6000);
    const rv = await page.evaluate(() => {
      const S = window.__kaikouTest.S;
      const get = n => window.__store.get('data/users/u_test/' + n);
      const all = [...window.__store.entries()].filter(([k]) => /\/sessions-/.test(k)).map(([, v]) => v);
      const sessions = [all.reduce((n, d) => n + (d.items || []).length, 0), all.reduce((n, d) => n + Object.values(d.map || {}).filter(Boolean).length, 0)];
      const day = S.review.date;
      return { minutes: S.review.minutes, chat: get('chat'), sessions, day: get('log-' + day.slice(0, 7)).days[day] };
    });
    check('結束並複習：存下複習、標記對話結束、打勾並記錄分鐘', () => {
      eq(rv.minutes, 6);
      eq([rv.chat.active, rv.chat.endedId], [false, 'c1']);
      eq(rv.sessions, [1, 1]);
      eq(rv.day.items, { shadow: true, ai: true });
      eq(rv.day.coach, { c1: 6 });
    });
    check('結束並複習時鍵盤焦點跟著走：整理中在「停止」，完成後到複習的標題；更自然的說法旁的按鈕標成中文', () => {
      eq([focusWhile, focusAfter], ['stop-review', true]);
      eq(chat.fixLang, ['zh-Hant-TW']);
    });
    await shot(page, '3-review-phone.png', true);
    await page.click('#t-log');
    await until(page, () => document.querySelectorAll('#log-dyn .sess').length === 2);
    await shot(page, '4-log-phone.png', true);
    await page.click('#t-saved');
    await until(page, () => document.querySelectorAll('#saved-list .phrase').length === 3);
    await shot(page, '5-saved-phone.png');

    await page.click('#t-today');
    await page.click('.inbox-row .btn.small');
    await notBusy(page);
    await until(page, () => document.querySelectorAll('#msgs .opt').length === 3);
    const zh = await page.evaluate(() => ({ inbox: window.__kaikouTest.S.inbox.length, mode: window.__kaikouTest.S.chat.mode }));
    check('問教練：句子送出後才從隨手記移除，中翻英給 3 種說法', () => eq(zh, { inbox: 1, mode: 'zh' }));
    await shot(page, '6-zh-phone.png');
    const wideCoach = await horiz(page);
    check('教練頁沒有左右捲動', () => eq(wideCoach, false));
    // On a phone the buttons of each way to say it sit under the sentence (not under its label), also 360 px wide.
    const optRows = () => page.evaluate(() => [...document.querySelectorAll('#msgs .opt')].map(o => {
      const r = s => o.querySelector(s).getBoundingClientRect(), k = r('.opt-k'), en = r('.opt-en'), acts = r('.opt-acts'), box = o.getBoundingClientRect();
      return acts.top >= en.bottom - 1 && acts.left >= k.right - 1 && en.right <= box.right + 1 && acts.right <= box.right + 1;
    }));
    const opt400 = await optRows();
    await page.setViewportSize({ width: 360, height: 800 });
    const opt360 = await optRows();
    const wide360 = await horiz(page);
    const optLang = await page.evaluate(() => [...new Set([...document.querySelectorAll('#msgs .opt-acts button')].map(b => b.closest('[lang]').getAttribute('lang')))]);
    check('中翻英的說法：手機上按鈕排在句子下面，360 寬也不超出畫面；按鈕標成中文', () => eq([opt400, opt360, wide360, optLang], [[true, true, true], [true, true, true], false, ['zh-Hant-TW']]));

    // 設定 → 教練說話程度 during a chat: the chat follows from the next reply on, and says so.
    await page.click('#btn-settings');
    await page.click('[data-fk="slvl-A2"]');
    const lvl = await page.evaluate(() => {
      const X = window.__kaikouTest;
      return { chat: X.S.chat.level, rules: X.rulesFor(X.S.chat).includes('Level to speak at: A2.'), toast: document.querySelector('#toast').textContent, bar: [...document.querySelectorAll('#coach-dyn small')].map(n => n.textContent).find(t => t.startsWith('教練程度')) };
    });
    await page.click('[data-fk="slvl-B1"]');
    await page.click('#set-done');
    check('對話中在設定改教練說話程度：這次對話接下來就照新的程度，並告訴你', () => {
      eq([lvl.chat, lvl.rules, lvl.toast], ['A2', true, '這次對話接下來用 A2 入門的程度回覆']);
      assert.ok(lvl.bar.startsWith('教練程度 A2'), lvl.bar);
    });

    // Claude reloads a page without its #tab: the open tab and the words not sent yet are kept (this tab only).
    await page.fill('#msg-input', 'I want to say that');
    await page.goto('file://' + ARTIFACT);
    await page.waitForFunction(() => window.__kaikouTest && window.__kaikouTest.S && window.__kaikouTest.S.ready, null, { timeout: 10000 });
    const view = await page.evaluate(() => ({ tab: window.__kaikouTest.S.tab, shown: !document.querySelector('#tab-coach').hidden, draft: document.querySelector('#msg-input').value }));
    check('重新整理（網址沒有分頁標記）後仍在同一個分頁，還沒送出的字也還在', () => eq(view, { tab: 'coach', shown: true, draft: 'I want to say that' }));
  }

  // ---------- 2. In Claude, on a desktop in dark mode ----------
  if (want('2')) {
    const { page } = await open(ARTIFACT + '#coach', { viewport: { width: 1200, height: 900 }, colorScheme: 'dark' }, 'desk');
    await until(page, () => document.querySelector('#sync').textContent === '已同步');
    await shot(page, '7-coach-desk-dark.png');
    // Words typed but not sent belong to the chat: discarding it clears them (a new chat must not start with them).
    await page.fill('#msg-input', 'Also my boss was angry at me');
    await page.click('[data-fk="discard"]');
    await page.click('[data-fk="discard"]');
    await until(page, () => !!document.querySelector('#start-btn'));
    const gone = await page.evaluate(() => ({ text: document.querySelector('#msg-input').value, kept: JSON.parse(sessionStorage.getItem('kaikou:view') || '{}').draft, focus: document.activeElement === document.querySelector('#coach-dyn h2') }));
    await page.click('.mode:nth-child(2)');
    await shot(page, '8-coach-start-desk-dark.png', true);
    await page.click('#btn-settings');
    const dlg = await page.evaluate(() => ({ open: document.querySelector('#settings').open, clear: document.querySelector('#set-clear').hidden, key: document.querySelector('#set-api-field').hidden }));
    check('放棄對話回到選單（還沒送出的字一起清掉，焦點到選單的標題）；設定可開啟，雲端模式不顯示清除按鈕，也不顯示 API 金鑰欄位', () => {
      eq(gone, { text: '', kept: '', focus: true });
      eq(dlg, { open: true, clear: true, key: true });
    });
    await shot(page, '9-settings-desk-dark.png');
  }

  // ---------- 3. GitHub Pages / a local file, on a phone ----------
  if (want('3')) {
    const { ctx, page } = await open(PAGES, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'light' }, 'pages');
    const env = await page.evaluate(() => ({ mode: document.compatMode, width: window.innerWidth, sync: document.querySelector('#sync').textContent }));
    check('網頁版：標準模式、手機寬度、存在這個瀏覽器', () => eq(env, { mode: 'CSS1Compat', width: 390, sync: '只存在這個瀏覽器' }));
    const shown = {};
    for (const t of ['coach', 'log', 'saved', 'today']) {
      await page.click('#t-' + t);
      shown[t] = await page.evaluate(() => [...document.querySelectorAll('section.tab')].filter(s => getComputedStyle(s).display !== 'none').map(s => s.id));
      shown[t + '-wide'] = await horiz(page);
    }
    check('網頁版：一次只顯示一個分頁，沒有左右捲動', () => eq(shown, { coach: ['tab-coach'], 'coach-wide': false, log: ['tab-log'], 'log-wide': false, saved: ['tab-saved'], 'saved-wide': false, today: ['tab-today'], 'today-wide': false }));

    // Two tabs of the same browser, both ticking at about the same time (each before it has heard of the other's
    // change): what is stored keeps both ticks.
    const page2 = await addPage(ctx, PAGES, 'pages-2');
    const busyLog = p => p.evaluate(() => window.__kaikouTest.Store.busyDoc('log-' + window.__kaikouTest.S.lastToday.slice(0, 7)));
    await page2.tap('#today-dyn .list .item:nth-child(2) .check');
    await page.waitForTimeout(200);
    await page.tap('#today-dyn .list .item:nth-child(4) .check');
    for (const p of [page2, page]) await until(p, () => !window.__kaikouTest.Store.busyDoc('log-' + window.__kaikouTest.S.lastToday.slice(0, 7)));
    await settle(page);
    const stored = await page.evaluate(() => { const k = window.__kaikouTest.S.lastToday; return JSON.parse(localStorage.getItem('kaikou:log-' + k.slice(0, 7))).days[k].items; });
    const twoBusy = [await busyLog(page), await busyLog(page2)];
    check('網頁版：同一個瀏覽器開兩個分頁、差不多同時打勾，存下來的兩邊都在', () => eq([stored, twoBusy], [{ ai: true, listen: true }, [false, false]]));
    await page2.close();

    // A page opened as a file keeps no API key (any other HTML file opened from this computer could read it): the
    // field explains, a key stored there by an earlier version is not used and can be removed, and the coach says
    // where it can be used.
    await page.click('#btn-settings');
    await page.locator('#set-api-field').scrollIntoViewIfNeeded();
    const sett = await page.evaluate(() => {
      const d = document.querySelector('#settings'), f = document.querySelector('#set-api-field');
      return { clear: !document.querySelector('#set-clear').hidden, field: !f.hidden, note: !document.querySelector('#set-api-file').hidden, row: !document.querySelector('#set-api-row').hidden,
        state: document.querySelector('#set-api-state').textContent, remove: !document.querySelector('#set-api-clear').hidden, wide: d.scrollWidth > d.clientWidth || f.getBoundingClientRect().right > window.innerWidth };
    });
    await shot(page, '10b-pages-settings-phone.png');
    await page.click('#set-done');
    // A key stored here by an earlier version is removed when the page opens, and the 今日 tab says so (and how to
    // replace it) until the learner has read it.
    const KEY = 'sk-ant-api03-' + 'TESTONLY'.repeat(6) + '-AA';
    for (let i = 0; i < 3; i++) {
      await page.evaluate(k => localStorage.setItem('kaikou:api-key', k), KEY);
      await reloadAfterWrites(page);
      if (await page.evaluate(() => !!document.querySelector('[data-fk="key-gone-ok"]'))) break;
    }
    const oldKey = await page.evaluate(() => ({ stored: localStorage.getItem('kaikou:api-key'), state: window.__kaikouTest.S.sampleState, notice: document.querySelector('[data-fk="key-gone-ok"]') ? 'shown' : 'none',
      title: (document.querySelector('#coach-dyn .card-title') || {}).textContent, help: (document.querySelector('#coach-dyn .help') || {}).textContent || '', openKey: !!document.querySelector('[data-fk="open-key"]') }));
    const goneText = await page.evaluate(() => (document.querySelector('[data-fk="key-gone-ok"]').closest('.notice') || {}).textContent || '');
    await page.click('#btn-settings');
    const oldKeySet = await page.evaluate(() => ({ state: document.querySelector('#set-api-state').textContent, remove: !document.querySelector('#set-api-clear').hidden, row: !document.querySelector('#set-api-row').hidden }));
    // Clearing this browser's practice data keeps the reminder (it is about the key, not the practice).
    await page.click('#set-clear');
    await Promise.all([page.waitForEvent('load'), page.click('#set-clear')]);
    await page.waitForFunction(() => window.__kaikouTest && window.__kaikouTest.S && window.__kaikouTest.S.ready, null, { timeout: 10000 });
    const afterClear = await page.evaluate(() => !!document.querySelector('[data-fk="key-gone-ok"]'));
    await page.click('[data-fk="key-gone-ok"]');
    const gone = await page.evaluate(() => ({ notice: !!document.querySelector('[data-fk="key-gone-ok"]'), flag: localStorage.getItem('kaikou:key-removed'), focus: document.activeElement && document.activeElement.classList.contains('date-big') }));
    check('直接開檔：設定裡有清除資料的按鈕；不能存 API 金鑰（說明原因，手機上不超出畫面）；之前存的金鑰打開時就移除，今日頁說明並提醒到 Console 停用，教練說明要從哪裡開', () => {
      eq(sett, { clear: true, field: true, note: true, row: false, state: '', remove: false, wide: false });
      eq([oldKey.stored, oldKey.state, oldKey.notice, oldKey.title, oldKey.openKey], [null, 'none', 'shown', 'AI 教練需要 Claude', false]);
      assert.ok(/已經移除/.test(goneText) && /Console/.test(goneText), goneText);
      assert.ok(/GitHub Pages/.test(oldKey.help) && /直接打開檔案/.test(oldKey.help), oldKey.help);
      eq(oldKeySet, { state: '', remove: false, row: false });
      eq([afterClear, gone], [true, { notice: false, flag: null, focus: true }]);
    });

    // 隨手記 holds at most 100 notes: a full list says so, and no older note is dropped to make room.
    await page.evaluate(() => { const S = window.__kaikouTest.S; for (let i = S.inbox.length; i < 100; i++) S.inbox.push({ id: 'fill' + i, text: 'note ' + i, at: 1 }); });
    await page.fill('#inbox-input', '第 101 則');
    await page.click('#inbox-form .btn');
    const capped = await page.evaluate(() => { const S = window.__kaikouTest.S; return { n: S.inbox.length, oldest: S.inbox.some(x => x.id === 'fill0'), toast: document.querySelector('#toast').textContent, kept: document.querySelector('#inbox-input').value }; });
    await page.evaluate(() => { const S = window.__kaikouTest.S; S.inbox = S.inbox.filter(x => !x.id.startsWith('fill')); });
    await page.fill('#inbox-input', '');
    check('網頁版：隨手記滿 100 則就不再加並說明，舊的不會被自動刪掉', () => eq(capped, { n: 100, oldest: true, toast: '隨手記最多 100 則，先把用不到的刪掉再記。', kept: '第 101 則' }));

    // The browser's storage is full (here: while a long note is stored, nothing more fits in the saved phrases): the
    // change waits (shown in the status), and is stored once the deletion of the note has freed the space.
    await page.fill('#inbox-input', '這是一則很長的筆記 FILLS-THE-STORAGE');
    await page.click('#inbox-form .btn');
    await until(page, () => (localStorage.getItem('kaikou:inbox') || '').includes('FILLS-THE-STORAGE'), null, 4000);
    await page.evaluate(() => {
      const real = Storage.prototype.setItem, get = Storage.prototype.getItem;
      window.__realSetItem = real;
      Storage.prototype.setItem = function (k, v) {
        if (k === 'kaikou:phrases' && (get.call(this, 'kaikou:inbox') || '').includes('FILLS-THE-STORAGE')) throw new DOMException('full', 'QuotaExceededError');
        return real.call(this, k, v);
      };
    });
    await page.click('#t-saved');
    const starKey = await page.getAttribute('#starters .icon-btn[aria-pressed="false"][aria-label="收藏"]', 'data-fk');
    await page.click('[data-fk="' + starKey + '"]');
    await until(page, () => document.querySelector('#sync').textContent === '有資料存不進這個瀏覽器', null, 6000);
    const fullToast = await page.evaluate(() => document.querySelector('#toast').textContent);
    await page.click('#t-today');
    const delNote = await page.evaluate(() => '[data-fk="del-' + window.__kaikouTest.S.inbox.find(x => /FILLS-THE-STORAGE/.test(x.text)).id + '"]');
    await page.click(delNote);
    await page.click(delNote);
    const noteFocus = await page.evaluate(() => document.activeElement && document.activeElement.id); // the last note: on to the list's heading (a phone: no keyboard)
    await until(page, () => document.querySelector('#sync').textContent === '只存在這個瀏覽器', null, 6000);
    const starStored = await page.evaluate(id => !!((JSON.parse(localStorage.getItem('kaikou:phrases') || '{}').map || {})[id]), starKey.split(':').pop());
    await page.evaluate(() => { Storage.prototype.setItem = window.__realSetItem; });
    check('網頁版：瀏覽器的儲存空間滿了會顯示存不進去，刪掉東西、空間空出來之後自動再存；手機上刪掉最後一則隨手記後焦點到標題（不叫出鍵盤）', () => {
      assert.ok(fullToast.startsWith('這個瀏覽器的儲存空間滿了'), fullToast);
      eq([starStored, noteFocus], [true, 'inbox-title']);
    });
    // Last: a full-page screenshot turns Playwright's touch emulation off for the rest of the page's life.
    await shot(page, '10-pages-phone.png', true);
    await ctx.close();
  }

  // ---------- 3b. GitHub Pages with the viewer's own Claude API key ----------
  if (want('3b')) {
    // A made-up key: api.anthropic.com is answered by the route below, nothing leaves the test.
    const KEY = 'sk-ant-api03-' + 'TESTONLY'.repeat(6) + '-AA';
    const REVIEW = { summary: '今天說得很順。', strengths: ['敢開口'], patterns: [{ issue: '過去式', example: 'I go to park yesterday', fix: 'I went to the park yesterday' }], phrases: [{ en: 'We had a picnic', zh: '我們去野餐', example: 'We had a picnic by the river.' }], next: '再聊一次週末' };
    const api = { calls: [], fail: null };
    const { ctx, page } = await open(base + '#coach', { viewport: { width: 1000, height: 800 }, colorScheme: 'light', serviceWorkers: 'block' }, 'apikey');
    await page.route('https://api.anthropic.com/v1/messages', route => {
      const req = route.request(), h = req.headers();
      let body = {};
      try { body = JSON.parse(req.postData() || '{}'); } catch (_) { body = {}; }
      const msgs = body.messages || [];
      const last = String((msgs[msgs.length - 1] || {}).content || '');
      api.calls.push({ key: h['x-api-key'], direct: h['anthropic-dangerous-direct-browser-access'], version: h['anthropic-version'], model: body.model, max: body.max_tokens, stream: body.stream, roles: msgs.map(m => m.role[0]).join('') });
      const cors = { 'access-control-allow-origin': '*' };
      if (api.fail) return route.fulfill({ status: api.fail.status, headers: cors, contentType: 'application/json', body: JSON.stringify({ type: 'error', error: api.fail.error }) });
      const text = /^Review this English speaking practice session/.test(last) ? JSON.stringify(REVIEW)
        : msgs.length === 1 ? 'Hi! What did you do last weekend?\n###\n{"none": true}'
        : last === 'I go to park yesterday' ? 'Nice! Which park did you go to?\n###\n{"you": "I go to park yesterday", "better": "I went to the park yesterday", "why": "過去式"}'
        : 'That sounds lovely. Tell me more!\n###\n{"none": true}';
      return route.fulfill({ status: 200, headers: Object.assign({ 'content-type': 'text/event-stream; charset=utf-8' }, cors), body: sse(text) });
    });
    const toastText = () => page.evaluate(() => document.querySelector('#toast').textContent);
    const say = async t => { await page.fill('#msg-input', t); await page.click('#send-btn'); await notBusy(page); };

    // No key yet: the coach explains and leads to 設定.
    const before = await page.evaluate(() => ({ title: (document.querySelector('#coach-dyn .card-title') || {}).textContent, btn: !!document.querySelector('[data-fk="open-key"]') }));
    await shot(page, '11-pages-no-key.png');
    await page.click('[data-fk="open-key"]');
    await until(page, () => document.activeElement && document.activeElement.id === 'set-api-key', null, 3000);
    const empty = await page.evaluate(() => ({ field: !document.querySelector('#set-api-field').hidden, state: document.querySelector('#set-api-state').textContent, remove: !document.querySelector('#set-api-clear').hidden }));
    await page.fill('#set-api-key', 'sk-ant-usr-not-an-api-key-1234567890');
    await page.click('#set-api-save');
    const wrong = { toast: await toastText(), stored: await page.evaluate(() => localStorage.getItem('kaikou:api-key')) };
    await page.fill('#set-api-key', KEY);
    await page.press('#set-api-key', 'Enter');
    await until(page, () => !!localStorage.getItem('kaikou:api-key'), null, 3000);
    const saved = await page.evaluate(() => ({ input: document.querySelector('#set-api-key').value, state: document.querySelector('#set-api-state').textContent, remove: !document.querySelector('#set-api-clear').hidden, toast: document.querySelector('#toast').textContent }));
    await shot(page, '12-pages-api-key.png');
    check('網頁版金鑰：沒有金鑰時引導到設定，格式不對的不存，存好後只顯示結尾', () => {
      eq(before, { title: 'AI 教練需要 Claude', btn: true });
      eq(empty, { field: true, state: '還沒有儲存金鑰。', remove: false });
      eq([/不是 Claude API 金鑰/.test(wrong.toast), wrong.stored], [true, null]);
      eq(saved, { input: '', state: '已儲存一把金鑰（結尾 ' + KEY.slice(-4) + '），AI 教練會用它回覆。', remove: true, toast: '已儲存金鑰' });
    });

    // The coach now answers through the API: opener, a correction, more turns, then the review.
    await page.click('#set-done');
    await until(page, () => { const b = document.querySelector('#start-btn'); return !!b && !b.disabled; }, null, 3000);
    await page.click('#start-btn');
    await notBusy(page);
    await say('I go to park yesterday');
    await say('We ate sandwiches');
    await say('It was sunny and warm');
    const talk = await page.evaluate(() => {
      const c = window.__kaikouTest.S.chat;
      const me = c.turns.find(t => t.r === 'm');
      return { opener: c.turns[0].t, fix: (me.fx || []).map(f => f.better), reply: c.turns[c.turns.indexOf(me) + 1].t, count: c.meCount };
    });
    await page.click('[data-fk="review"]');
    await until(page, () => !!window.__kaikouTest.S.review && !window.__kaikouTest.S.reviewing, null, 10000);
    await shot(page, '13-pages-api-review.png');
    const rv = await page.evaluate(() => {
      const S = window.__kaikouTest.S;
      const holders = Object.keys(localStorage).filter(k => (localStorage.getItem(k) || '').includes('TESTONLY'));
      return { summary: S.review.summary, phrases: S.review.phrases.map(p => p.en), holders };
    });
    check('網頁版金鑰：教練經由 Claude API 串流回覆、給更正，也能結束並複習', () => {
      eq(talk, { opener: 'Hi! What did you do last weekend?', fix: ['I went to the park yesterday'], reply: 'Nice! Which park did you go to?', count: 3 });
      eq(rv, { summary: '今天說得很順。', phrases: ['We had a picnic'], holders: ['kaikou:api-key'] });
    });
    check('網頁版金鑰：請求帶金鑰與瀏覽器標頭，對話用 Haiku、複習用 Sonnet，角色輪流', () => {
      eq(api.calls.length, 5);
      for (const c of api.calls) eq([c.key, c.direct, c.version, c.stream], [KEY, 'true', '2023-06-01', true]);
      eq(api.calls.map(c => c.model + ':' + c.max), ['claude-haiku-5-5:2048', 'claude-haiku-5-5:2048', 'claude-haiku-5-5:2048', 'claude-haiku-5-5:2048', 'claude-sonnet-5-5:4096']);
      eq(api.calls.map(c => c.roles), ['u', 'uau', 'uauau', 'uauauau', 'u']);
    });

    // A rejected key: a clear message, no retry, a way to 設定; a new key brings the coach back.
    await page.click('[data-fk="back-menu"]');
    await until(page, () => !window.__kaikouTest.S.unsavedReview, null, 6000);
    const menuFocus = await page.evaluate(() => document.activeElement === document.querySelector('#coach-dyn h2') && document.activeElement.textContent);
    api.fail = { status: 401, error: { type: 'authentication_error', message: 'invalid x-api-key' } };
    await page.click('#start-btn');
    await notBusy(page);
    const bad = await page.evaluate(() => ({ note: document.querySelector('#coach-note').textContent, retry: !!document.querySelector('#coach-note [data-fk="retry"]'), toKey: !!document.querySelector('#coach-note [data-fk="note-key"]') }));
    await shot(page, '14-pages-key-invalid.png');
    api.fail = null;
    await page.click('#coach-note [data-fk="note-key"]');
    await until(page, () => document.activeElement && document.activeElement.id === 'set-api-key', null, 3000);
    await page.fill('#set-api-key', KEY);
    await page.click('#set-api-save');
    await page.click('#set-done');
    await until(page, () => !!document.querySelector('#coach-note [data-fk="retry"]'), null, 3000);
    // The button that opened 設定 is gone once the key works: the focus goes to the text box of the chat.
    await page.waitForTimeout(100);
    const keyFocus = await page.evaluate(() => document.activeElement && document.activeElement.id);
    const again = await page.evaluate(() => document.querySelector('#coach-note').textContent);
    await page.click('#coach-note [data-fk="retry"]');
    await notBusy(page);
    const back = await page.evaluate(() => { const c = window.__kaikouTest.S.chat; return { t: c.turns.length && c.turns[0].t, focus: document.activeElement && document.activeElement.id }; });
    check('網頁版金鑰：金鑰無效時說明清楚、不提供重送；換一把之後可以請教練開場', () => {
      eq([bad.note.startsWith('Claude API 金鑰無效或已停用，請到設定重新輸入。'), bad.retry, bad.toKey], [true, false, true]);
      eq(again.startsWith('對話還沒開始。'), true);
      eq(back.t, 'Hi! What did you do last weekend?');
    });
    check('網頁版金鑰：按鈕不見之後鍵盤焦點不會掉到頁面上：回到練習選單到標題，存好金鑰關掉設定、按請教練開場都到輸入框', () => {
      eq(menuFocus, '今天想怎麼練？');
      eq([keyFocus, back.focus], ['msg-input', 'msg-input']);
    });

    // A reply streamed in parts: 停止 keeps what arrived, and a connection that closes before the reply is complete
    // marks it cut too (it is never taken for a whole reply). The page's fetch is replaced to control the stream.
    await page.evaluate(() => {
      const real = window.fetch, enc = new TextEncoder();
      const ev = (type, data) => 'event: ' + type + '\ndata: ' + JSON.stringify(Object.assign({ type }, data)) + '\n\n';
      window.__realFetch = real;
      window.fetch = (url, opts) => {
        if (!/api\.anthropic\.com/.test(String(url))) return real(url, opts);
        const mode = window.__streamMode;
        return Promise.resolve(new Response(new ReadableStream({
          start(ctl) {
            ctl.enqueue(enc.encode(ev('message_start', { message: { id: 'msg_t', role: 'assistant', content: [] } }) + ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
              + ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Sure, we could talk about ' } })));
            if (mode === 'close') setTimeout(() => ctl.close(), 30);
            else if (opts && opts.signal) opts.signal.addEventListener('abort', () => ctl.error(new DOMException('The user aborted a request.', 'AbortError')));
          },
        }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
      };
    });
    const lastTurn = () => page.evaluate(() => { const c = window.__kaikouTest.S.chat, t = c.turns[c.turns.length - 1]; return { r: t.r, cut: !!t.cut, text: t.t, note: document.querySelector('#coach-note').textContent }; });
    await page.evaluate(() => { window.__streamMode = 'stall'; });
    await page.fill('#msg-input', 'What should we talk about');
    await page.click('#send-btn');
    await until(page, () => { const c = window.__kaikouTest.S.chat, t = c.turns[c.turns.length - 1]; return t.r === 'c' && /talk about/.test(t.t); });
    await page.waitForTimeout(800); // a tap right after sending is taken for a double tap
    await page.click('#send-btn'); // 停止回覆
    await notBusy(page);
    const stopped = await lastTurn();
    await page.evaluate(() => { window.__streamMode = 'close'; });
    await page.click('#coach-note [data-fk="retry"]');
    await notBusy(page);
    const early = await lastTurn();
    await page.evaluate(() => { window.fetch = window.__realFetch; });
    check('網頁版金鑰：按停止留下已收到的字並標示中斷；回覆還沒完連線就斷了也標示中斷並說明，不當成完整的回覆', () => {
      eq(stopped, { r: 'c', cut: true, text: 'Sure, we could talk about', note: '教練的回覆中斷了。重新回覆' });
      eq(early, { r: 'c', cut: true, text: 'Sure, we could talk about', note: '連線中斷了，再試一次。重新回覆' });
    });

    // Error codes from the API and the joined turns.
    const unit = await page.evaluate(() => {
      const T = window.__kaikouTest;
      const e = (s, type, message) => T.apiError(s, { type: 'error', error: { type, message: message || '' } }).code;
      return {
        codes: [e(401, 'authentication_error'), e(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API.'), e(404, 'not_found_error', 'model: x'), e(529, 'overloaded_error'), e(429, 'rate_limit_error'), e(413, 'request_too_large'), e(400, 'invalid_request_error', 'messages: bad'), T.apiError(500, null).code, e(0, 'overloaded_error')],
        joined: T.apiMessages([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }, { role: 'assistant', content: 'c' }, { role: 'user', content: 'd' }]),
      };
    });
    check('網頁版金鑰：API 錯誤對應到中文說明，同一方連續的話合併成一則', () => {
      eq(unit.codes, ['key_invalid', 'no_credit', 'model_missing', 'overloaded', 'rate_limited', 'prompt_too_large', 'invalid_request', 'upstream_error', 'overloaded']);
      eq(unit.joined, [{ role: 'user', content: 'a\n\nb' }, { role: 'assistant', content: 'c' }, { role: 'user', content: 'd' }]);
    });

    // Clearing the practice data in this browser keeps the key, which has its own button.
    await page.click('#btn-settings');
    await page.click('#set-clear');
    await Promise.all([page.waitForEvent('load'), page.click('#set-clear')]);
    await page.waitForFunction(() => window.__kaikouTest && window.__kaikouTest.S && window.__kaikouTest.S.ready, null, { timeout: 10000 });
    const cleared = await page.evaluate(() => ({
      key: localStorage.getItem('kaikou:api-key') !== null,
      practice: Object.keys(localStorage).filter(k => k === 'kaikou:chat' || k.startsWith('kaikou:sessions-')),
      state: window.__kaikouTest.S.sampleState,
    }));
    check('網頁版金鑰：清除這個瀏覽器的練習資料時，金鑰留著', () => eq(cleared, { key: true, practice: [], state: 'ok' }));

    // Removing the key turns the coach off again, also in a tool open on 今日; another tab notices at once.
    const page2 = await addPage(ctx, base + '#coach', 'apikey-2');
    const tab2Before = await page2.evaluate(() => window.__kaikouTest.S.sampleState);
    await page.click('#t-today');
    await page.click('[data-fk="go-shadow"]');
    const toolBefore = await page.evaluate(() => ({ gen: !!document.querySelector('[data-fk="sh-gen"]'), key: !!document.querySelector('[data-fk="tool-key"]') }));
    await page.click('#btn-settings');
    await page.click('#set-api-clear');
    await page.click('#set-api-clear');
    await until(page, () => !localStorage.getItem('kaikou:api-key'), null, 3000);
    await until(page2, () => window.__kaikouTest.S.sampleState === 'none', null, 3000);
    const off = await page.evaluate(() => ({ state: window.__kaikouTest.S.sampleState, openKey: !!document.querySelector('#coach-dyn [data-fk="open-key"]'), toast: document.querySelector('#toast').textContent, text: document.querySelector('#set-api-state').textContent, remove: !document.querySelector('#set-api-clear').hidden,
      focus: document.activeElement && document.activeElement.id, tool: { gen: !!document.querySelector('[data-fk="sh-gen"]'), key: !!document.querySelector('[data-fk="tool-key"]') } }));
    const off2 = await page2.evaluate(() => !!document.querySelector('#coach-dyn [data-fk="open-key"]'));
    check('網頁版金鑰：移除後教練停用（焦點到金鑰欄位），今日開著的跟讀也跟著改，另一個分頁也立刻跟著停用', () => {
      eq(tab2Before, 'ok');
      eq(off, { state: 'none', openKey: true, toast: '已移除金鑰', text: '還沒有儲存金鑰。', remove: false, focus: 'set-api-key', tool: { gen: false, key: true } });
      eq(toolBefore, { gen: true, key: false });
      eq(off2, true);
    });
    await ctx.close();
  }

  // ---------- 4. Failure paths in Claude ----------
  if (want('4')) {
    // a. A write fails twice in a row, is retried later and lands.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'retry', { failWrites: { inbox: { n: 2, code: 'unavailable' } } });
    await page.fill('#inbox-input', '要跟主管說延期');
    await page.click('#inbox-form .btn');
    await until(page, () => document.querySelector('#sync').textContent === '同步失敗，會自動再試', null, 6000);
    await until(page, () => document.querySelector('#sync').textContent === '已同步', null, 12000);
    const inbox = await page.evaluate(() => Object.values(window.__store.get('data/users/u_test/inbox').map || {}).map(x => x && x.text));
    check('寫入失敗會顯示並自動重試，最後存進雲端', () => assert.ok(inbox.includes('要跟主管說延期')));
    await ctx.close();
  }
  if (want('4')) {
    // b. A viewer whose link cannot write keeps working from this browser, also after a reload.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'readonly', { readOnly: true, owner: false });
    await page.fill('#inbox-input', '唯讀連結的句子');
    await page.click('#inbox-form .btn');
    await until(page, () => document.querySelector('#sync').textContent === '只存在這個瀏覽器', null, 6000);
    await until(page, () => (localStorage.getItem('kaikou:inbox') || '').includes('唯讀連結的句子'), null, 3000);
    const a = await page.evaluate(() => ({ toast: document.querySelector('#toast').textContent, ls: localStorage.getItem('kaikou:inbox') || '', flag: localStorage.getItem('kaikou:no-cloud') }));
    await reloadAfterWrites(page);
    const b = await page.evaluate(() => ({ mode: window.__kaikouTest.Store.mode, inbox: window.__kaikouTest.S.inbox.map(x => x.text) }));
    check('不能寫入雲端的連結：改存這個瀏覽器，重新整理後還在', () => {
      eq(a.toast, '這個連結不能把進度存到雲端，改存在這個瀏覽器。');
      assert.ok(a.ls.includes('唯讀連結的句子'));
      eq(a.flag, 'u_test');
      eq(b, { mode: 'local', inbox: ['唯讀連結的句子'] });
    });
    // Later the viewer is given edit access: 設定 → 再試一次存到雲端 uploads what this browser holds.
    await page.evaluate(() => { window.__mockCfg.readOnly = false; });
    await page.click('#btn-settings');
    await page.click('#set-cloud');
    await until(page, () => window.__kaikouTest.Store.mode === 'db' && !window.__kaikouTest.S.uploading, null, 10000);
    const c = await page.evaluate(() => ({ cloud: Object.values((window.__store.get('data/users/u_test/inbox') || {}).map || {}).map(x => x && x.text), flag: localStorage.getItem('kaikou:no-cloud') }));
    check('之後有了寫入權限：設定裡再試一次，會把這個瀏覽器的資料存到雲端', () => { assert.ok(c.cloud.includes('唯讀連結的句子')); eq(c.flag, null); });
    await ctx.close();
  }
  if (want('4')) {
    // The owner's cloud access stops mid-visit; the next visit offers to upload what was kept in this browser.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'held', { persist: true, failWrites: { inbox: { n: 1, code: 'revoked' } } });
    await page.fill('#inbox-input', '同步停止後記的句子');
    await page.click('#inbox-form .btn');
    await until(page, () => document.querySelector('#sync').textContent === '只存在這個瀏覽器' && !!localStorage.getItem('kaikou:held'), null, 6000);
    // Meanwhile the phone deletes an older sentence; the upload must not bring it back. (The test cloud lives in
    // sessionStorage across the reload; should the browser lose the change on the way, it is made again.)
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => { const k = 'data/users/u_test/inbox'; const d = window.__store.get(k); d.map = Object.assign({}, d.map || {}, { i2: null }); window.__store.set(k, d); window.__saveStore(); });
      await reloadAfterWrites(page);
      if (await page.evaluate(() => (window.__store.get('data/users/u_test/inbox').map || {}).i2 === null)) break;
    }
    await page.evaluate(() => { window.__mockCfg.failWrites = {}; });
    await until(page, () => !!document.querySelector('[data-fk="held-up"]'), null, 4000);
    await page.click('[data-fk="held-up"]');
    await until(page, () => !window.__kaikouTest.S.held && !window.__kaikouTest.S.uploading, null, 10000);
    const h = await page.evaluate(() => { const d = window.__store.get('data/users/u_test/inbox') || {}; return { cloud: Object.values(d.map || {}).map(x => x && x.text), deleted: (d.map || {}).i2, marker: localStorage.getItem('kaikou:held'), shown: window.__kaikouTest.S.inbox.map(x => x.text) }; });
    check('雲端同步中途停止：下次開啟只把那段時間的變更存回雲端，不會救回別台刪掉的', () => {
      assert.ok(h.cloud.includes('同步停止後記的句子'));
      eq(h.deleted, null);
      eq(h.marker, null);
      eq(h.shown.includes('同步停止後記的句子'), true);
      eq(h.shown.includes('我們需要再確認一下預算'), false);
    });
    await ctx.close();
  }
  if (want('4')) {
    // c. A refused sentence is marked, not counted and never resent.
    const { ctx, page } = await open(ARTIFACT + '#coach', { viewport: { width: 1000, height: 800 } }, 'refused', { refuse: 'TRIGGER-REFUSE' });
    const before = await page.evaluate(() => window.__kaikouTest.S.chat.meCount);
    await page.fill('#msg-input', 'TRIGGER-REFUSE please');
    await page.click('#send-btn');
    await notBusy(page);
    const r = await page.evaluate(() => { const c = window.__kaikouTest.S.chat; const last = c.turns[c.turns.length - 1]; return { ex: last.r === 'm' && last.ex, count: c.meCount, retry: !!document.querySelector('#coach-note [data-fk="retry"]'), note: document.querySelector('#coach-note').textContent }; });
    check('被拒絕的句子：標記略過、不算句數、不提供重送', () => eq([r.ex, r.count, r.retry, /已略過/.test(r.note)], [true, before, false, true]));
    await ctx.close();
  }
  if (want('4')) {
    // d. Stopping a reply keeps what arrived, marks it cut and offers to ask again.
    const { ctx, page } = await open(ARTIFACT + '#coach', { viewport: { width: 1000, height: 800 } }, 'stop', { slowMs: 700 });
    await page.fill('#msg-input', 'We took the cable car up.');
    await page.click('#send-btn');
    await until(page, () => { const c = window.__kaikouTest.S.chat; const t = c.turns[c.turns.length - 1]; return t.r === 'c' && t.t && t.streaming; }, null, 4000);
    await page.click('#send-btn');
    await notBusy(page);
    const r = await page.evaluate(() => { const c = window.__kaikouTest.S.chat; const t = c.turns[c.turns.length - 1]; return { cut: !!t.cut, text: t.t.length > 0, retry: (document.querySelector('#coach-note [data-fk="retry"]') || {}).textContent || '' }; });
    check('停止回覆：保留已收到的內容、標示中斷、可以重新回覆', () => eq(r, { cut: true, text: true, retry: '重新回覆' }));
    await ctx.close();
  }
  if (want('4')) {
    // e. Cloud storage full: shown once, not retried in a loop, sent again after a deletion.
    const { ctx, page } = await open(ARTIFACT + '#saved', { viewport: { width: 1000, height: 800 } }, 'quota', { failWrites: { phrases: { n: 99, code: 'quota_exceeded' } } });
    await page.click('#starters .icon-btn[aria-pressed="false"][aria-label="收藏"]');
    await until(page, () => document.querySelector('#sync').textContent === '有資料存不進雲端', null, 6000);
    const n1 = await page.evaluate(() => window.__dbCalls.filter(c => c.name === 'phrases' && c.op !== 'get').length);
    await page.waitForTimeout(4000);
    const n2 = await page.evaluate(() => window.__dbCalls.filter(c => c.name === 'phrases' && c.op !== 'get').length);
    await page.evaluate(() => { window.__mockCfg.failWrites.phrases.n = 0; });
    const del = '#saved-list .phrase:last-child [data-fk^="del-"]';
    const prevDel = await page.evaluate(() => { const r = document.querySelectorAll('#saved-list .phrase'); return r[r.length - 2].querySelector('[data-fk^="del-"]').dataset.fk; });
    await page.click(del);
    await page.click(del);
    const delFocus = await page.evaluate(() => document.activeElement && document.activeElement.dataset.fk);
    await until(page, () => document.querySelector('#sync').textContent === '已同步', null, 6000);
    const saved = await page.evaluate(() => { const m = window.__store.get('data/users/u_test/phrases').map || {}; const id = window.__kaikouTest.phraseId('Sorry, could you say that again?'); return !!(m[id] && m[id].en); });
    check('雲端空間已滿：不會一直重試，刪掉東西後自動再存；刪掉最後一句後焦點到上一句的刪除鍵', () => eq([n2 === n1, saved, delFocus], [true, true, prevDel]));
    await ctx.close();
  }
  if (want('4')) {
    // f. The cloud cannot be reached on this visit (the database fails to load; Claude still says who is viewing): the
    //    page works from this browser and keeps the changes, and the next visit that reaches the cloud offers to save
    //    them there, without replacing what the cloud has with this browser's defaults. What is undone during the visit
    //    (a tick taken back, a star taken back) leaves nothing to save, so it never deletes what the cloud has.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'offline', { failUse: ['db'] });
    const off = await page.evaluate(() => ({ mode: window.__kaikouTest.Store.mode, why: window.__kaikouTest.Store.why, sync: document.querySelector('#sync').textContent, notice: (document.querySelector('#today-dyn .notice') || {}).textContent || '', toast: document.querySelector('#toast').textContent }));
    await page.click('#today-dyn .list .item:nth-child(2) .check');
    // 影子跟讀 (ticked in the cloud, not shown here) is ticked by mistake and unticked.
    await page.click('#today-dyn .list .item:nth-child(1) .check');
    await page.click('#today-dyn .list .item:nth-child(1) .check');
    // This browser has no saved phrases: a phrase the cloud has saved long ago looks unsaved, and is starred again.
    await page.click('#t-saved');
    const starKey = await page.getAttribute('#starters .icon-btn[aria-pressed="false"][aria-label="收藏"]', 'data-fk');
    await page.click('[data-fk="' + starKey + '"]');
    const star = await page.evaluate(id => ({ id, en: window.__kaikouTest.S.phrases.find(p => p.id === id).en }), starKey.split(':').pop());
    // Another phrase the cloud has (with its own schedule) is starred and unstarred.
    const p2Id = await page.evaluate(() => window.__kaikouTest.phraseId("I'll get back to you on that."));
    await page.click('[data-fk="star:st:' + p2Id + '"]');
    await page.click('[data-fk="star:st:' + p2Id + '"]');
    // It looks new here, so it is reviewed as a new phrase.
    await page.click('[data-fk="drill-start"]');
    await page.click('[data-fk="flip"]');
    await page.click('[data-fk="rate-2"]');
    // A backup imported now does not bring its settings (the defaults shown here say nothing about the cloud's). Its
    // day that the cloud already has adds the ticks only, not the plan the file had for it.
    const yk = dayKey(-1);
    const settingsFile = path.join(out, 'backup-settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ app: 'kaikou-practice', v: 1, docs: { settings: { plan: '60', level: 'B2', about: 'From a backup', accent: 'en-GB', rate: 1.1, autoSpeak: false },
      ['log-' + yk.slice(0, 7)]: { days: { [yk]: { plan: '60', plans: { 0: '60' }, items: { chunk: true }, coach: {} } } } } }));
    await page.click('#btn-settings');
    const [fcS] = await Promise.all([page.waitForEvent('filechooser'), page.click('#set-import')]);
    await fcS.setFiles(settingsFile);
    await until(page, () => !document.querySelector('#set-import-box').hidden);
    await page.click('[data-fk="imp-go"]');
    await until(page, () => !window.__kaikouTest.S.importing && document.querySelector('#toast').textContent.startsWith('已合併'));
    await page.click('#set-done');
    await until(page, y => { const h = JSON.parse(localStorage.getItem('kaikou:held') || 'null'); return !!h && !!h.docs.phrases && !!h.docs.srs && !!h.docs['log-' + window.__mockToday.slice(0, 7)] && !!h.docs['log-' + y.slice(0, 7)] && !!h.docs['log-' + y.slice(0, 7)].days[y]; }, yk, 6000);
    const held = await page.evaluate(() => Object.assign(JSON.parse(localStorage.getItem('kaikou:held')), { level: window.__kaikouTest.S.settings.level }));
    const heldToday = held.docs['log-' + dayKey(0).slice(0, 7)].days[dayKey(0)];
    await settle(page);
    const page2 = await addPage(ctx, ARTIFACT, 'offline-2');
    await seeWrites(page2, y => { const h = JSON.parse(localStorage.getItem('kaikou:held') || 'null'); return !!h && !!h.docs.phrases && !!h.docs.srs && !!h.docs['log-' + y.slice(0, 7)] && !!h.docs['log-' + y.slice(0, 7)].days[y] && !!h.docs['log-' + window.__mockToday.slice(0, 7)]; }, yk);
    await until(page2, () => !!document.querySelector('[data-fk="held-up"]'), null, 4000);
    const offer = await page2.evaluate(() => document.querySelector('#today-dyn .notice').textContent);
    // In the cloud, today is on the 60-minute plan, and the phrase was saved long ago and last reviewed yesterday
    // (now 30 days apart); the other phrase has a 30-day schedule too.
    await page2.evaluate(([s, p2, y]) => {
      const P = n => 'data/users/u_test/' + n, D = window.__mockToday, L = window.__store.get(P('log-' + D.slice(0, 7))), ph = window.__store.get(P('phrases'));
      L.days[D] = Object.assign({}, L.days[D], { plans: { 0: '60' } });
      ph.map = Object.assign({}, ph.map, { [s.id]: { id: s.id, en: s.en, zh: '', note: '', ex: '', src: 'starter', at: 1 } });
      window.__store.set(P('srs'), { map: { [s.id]: { d: '2099-01-01', i: 30, r: 4, l: 0, f: '2026-01-05', t: y }, [p2]: { d: '2099-01-01', i: 30, r: 4, l: 0, f: '2026-01-05', t: y } } });
    }, [star, p2Id, yk]);
    await page2.click('[data-fk="held-up"]');
    await until(page2, () => !window.__kaikouTest.S.held && !window.__kaikouTest.S.uploading, null, 10000);
    const up = await page2.evaluate(([id, p2, y]) => {
      const X = window.__kaikouTest, P = n => 'data/users/u_test/' + n, D = window.__mockToday, day = window.__store.get(P('log-' + D.slice(0, 7))).days[D];
      const yd = window.__store.get(P('log-' + y.slice(0, 7))).days[y];
      return { ai: !!day.items.ai, shadow: day.items.shadow, plan: day.plans[0], at: (window.__store.get(P('phrases')).map[id] || {}).at, ivl: window.__store.get(P('srs')).map[id].i, settings: window.__store.get(P('settings')).level, marker: localStorage.getItem('kaikou:held'), toast: document.querySelector('#toast').textContent,
        p2: X.normPhrases(window.__store.get(P('phrases'))).some(p => p.id === p2), p2ivl: (window.__store.get(P('srs')).map[p2] || {}).i, yPlan: X.resolvePlan(yd.plans || {}, yd.plan || ''), yChunk: !!yd.items.chunk };
    }, [star.id, p2Id, yk]);
    check('這次連不上雲端：說明改存在這個瀏覽器；下次連上時今日頁提醒，存到雲端時不會用這個瀏覽器的舊資料或預設值蓋掉雲端的計畫、收藏、複習排程和設定', () => {
      eq([off.mode, off.why, off.sync, off.toast], ['local', 'offline', '只存在這個瀏覽器', '這次連不上 Claude 的雲端，變更先存在這個瀏覽器。']);
      assert.ok(off.notice.startsWith('這次連不上 Claude 的雲端'), off.notice);
      eq([held.uid, Object.keys(held.docs).filter(n => /^log-|^phrases$|^srs$/.test(n)).length, !!held.docs.settings, held.level], ['u_test', 2 + new Set([dayKey(0).slice(0, 7), yk.slice(0, 7)]).size, false, 'B1']);
      assert.ok(/連不上雲端時留下的變更（\d 份資料）/.test(offer), offer);
      eq(up.toast, '已把這台裝置上的變更存到雲端');
      eq([up.ai, up.plan, up.at, up.ivl, up.settings, up.marker], [true, '60', 1, 30, 'B1', null]);
      eq([up.yPlan, up.yChunk], ['20', true]);
    });
    check('連不上雲端時打勾又取消、收藏又取消：沒有留下要存的變更，雲端的打勾、收藏和複習排程都還在', () => {
      eq([heldToday.items.ai, 'shadow' in heldToday.items, p2Id in held.docs.phrases.map, p2Id in held.docs.srs.map], [true, false, false, false]);
      eq([up.shadow, up.p2, up.p2ivl], [true, true, 30]);
    });
    await ctx.close();
  }
  if (want('4')) {
    // g. Changes kept when cloud sync stopped on one visit survive a later visit where Claude could not be reached at
    //    all (no database, no viewer); the next cloud visit saves the changes of both.
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    await ctx.clock.install({ time: NOON });
    const v1 = await addPage(ctx, ARTIFACT, 'held-v1', { failWrites: { inbox: { n: 1, code: 'revoked' } } });
    await v1.fill('#inbox-input', '同步停止時記的句子');
    await v1.click('#inbox-form .btn');
    await until(v1, () => /同步停止時記的句子/.test(localStorage.getItem('kaikou:held') || ''), null, 6000);
    await settle(v1);
    await v1.close();
    const v2 = await addPage(ctx, ARTIFACT, 'held-v2', { noDb: true, noUser: true });
    await v2.click('#today-dyn .list .item:nth-child(2) .check');
    await until(v2, () => /"log-/.test(localStorage.getItem('kaikou:held') || ''), null, 6000);
    // A review kept by the previous version of the page (no pt) that continues the cloud's schedule is still sent. A
    // schedule built here over two days from a phrase that only looked new here (its first review is yesterday, not
    // the cloud's) does not replace the cloud's.
    await v2.evaluate(([y, t]) => {
      const h = JSON.parse(localStorage.getItem('kaikou:held'));
      h.docs.srs = { map: { pOld: { d: '2099-01-01', i: 10, r: 3, l: 0, f: '2026-09-01', t }, pChain: { d: '2099-01-01', i: 3, r: 2, l: 0, f: y, t, pt: y } } };
      localStorage.setItem('kaikou:held', JSON.stringify(h));
    }, [dayKey(-1), dayKey(0)]);
    await settle(v2);
    await v2.close();
    const v3 = await addPage(ctx, ARTIFACT, 'held-v3');
    await seeWrites(v3, () => { const h = localStorage.getItem('kaikou:held') || ''; return /同步停止時記的句子/.test(h) && /"log-/.test(h) && /pChain/.test(h); });
    await until(v3, () => !!document.querySelector('[data-fk="held-up"]'), null, 4000);
    const offer = await v3.evaluate(() => document.querySelector('#today-dyn .notice').textContent);
    await v3.evaluate(t2 => { window.__store.set('data/users/u_test/srs', { map: { pOld: { d: '2026-10-01', i: 4, r: 2, l: 0, f: '2026-09-01', t: '2026-09-20' }, pChain: { d: '2099-01-01', i: 30, r: 4, l: 0, f: '2026-01-05', t: t2 } } }); }, dayKey(-2));
    await v3.click('[data-fk="held-up"]');
    await until(v3, () => !window.__kaikouTest.S.held && !window.__kaikouTest.S.uploading, null, 10000);
    const both = await v3.evaluate(() => {
      const get = n => window.__store.get('data/users/u_test/' + n);
      return { note: window.__kaikouTest.normInbox(get('inbox')).some(x => x.text === '同步停止時記的句子'), ai: !!get('log-' + window.__mockToday.slice(0, 7)).days[window.__mockToday].items.ai, ivl: get('srs').map.pOld.i, chain: get('srs').map.pChain.i,
        left: Object.keys(localStorage).filter(k => /^kaikou:(settings|phrases|inbox|srs|shadow|held|log-|sessions-)/.test(k)) };
    });
    check('同步停止時留下的變更，不會被之後一次連不上 Claude 的造訪蓋掉；下次連上時兩次的變更都存到雲端（另起的複習排程不會蓋掉雲端的），瀏覽器裡的舊副本也清掉', () => {
      assert.ok(/（3 份資料）/.test(offer), offer);
      eq(both, { note: true, ai: true, ivl: 10, chain: 30, left: [] });
    });
    await ctx.close();
  }
  if (want('4')) {
    // i. A list or month that could not be read is never edited as if it were empty: a star or a tick waits while the
    //    page reads it again, and is then finished on what is really stored (a phrase saved long ago is not saved again
    //    as new, a day keeps its plan); while it still cannot be read, the learner is told so.
    const month = dayKey(0).slice(0, 7);
    const { ctx, page } = await open(ARTIFACT + '#saved', { viewport: { width: 1000, height: 800 } }, 'unread', { failReads: { phrases: 99, ['log-' + month]: 99 } }, noFocusRefresh);
    const T = (f, a) => page.evaluate(f, a);
    const toastIs = t => until(page, x => document.querySelector('#toast').textContent === x, t);
    const id = await T(() => window.__kaikouTest.phraseId("I'll get back to you on that."));
    const star = '[data-fk="star:st:' + id + '"]', tick = '#today-dyn .list .item:nth-child(4) .check';
    const writes = () => T(m => window.__dbCalls.filter(c => ['phrases', 'srs', 'log-' + m].includes(c.name) && c.op !== 'get').map(c => c.name), month);
    const list = await page.textContent('#saved-list');
    await page.click(star);
    await toastIs('還是讀不到你的收藏，等一下再試。');
    await page.click('#t-today');
    await page.click(tick);
    await toastIs('還是讀不到這個月的紀錄，等一下再試。');
    const before = await writes();
    await page.waitForTimeout(300); // every read started so far has failed by now
    await T(m => { window.__mockCfg.failReads.phrases = 0; window.__mockCfg.failReads['log-' + m] = 0; }, month);
    // Now one tap each: the document is read (unless the page has already done so), then the tap is finished.
    await page.click(tick);
    await until(page, m => !window.__kaikouTest.Store.busyDoc('log-' + m) && ((window.__store.get('data/users/u_test/log-' + m).days[window.__mockToday] || {}).items || {}).listen === true, month, 6000);
    await page.click('#t-saved');
    const starTapped = await T(() => window.__kaikouTest.S.loadErrors.has('phrases'));
    if (starTapped) await page.click(star);
    await until(page, x => document.querySelector(x).getAttribute('aria-pressed') === 'true', star);
    const starToast = await T(() => document.querySelector('#toast').textContent);
    const after = await T(([x, m]) => {
      const get = n => window.__store.get('data/users/u_test/' + n), day = get('log-' + m).days[window.__mockToday];
      return { items: day.items, plans: day.plans === undefined, at: window.__kaikouTest.normPhrases(get('phrases')).find(p => p.id === x).at, n: document.querySelectorAll('#saved-list .phrase').length };
    }, [id, month]);
    const later = await writes();
    check('還讀不到收藏或這個月的紀錄：收藏和打勾先等重新讀取，讀到之後照實際的資料完成（不會把雲端的句子當新的存、不會改掉那天的計畫），還是讀不到就說明', () => {
      assert.ok(list.includes('還讀不到你的收藏'), list);
      eq(before, []);
      eq(after, { items: { shadow: true, listen: true }, plans: true, at: 2, n: 3 });
      eq(later, ['log-' + month]);
      if (starTapped) eq(starToast, '這句已經在收藏裡了');
    });
    await ctx.close();
  }
  if (want('4')) {
    // i2. A review round finished while this month could not be read still ticks 語塊複習. This device's default plan
    //     is written under a weight below the cloud's own default: a day new to the cloud gets it, a day that has a
    //     plan keeps it (also after the month is read and another item is ticked).
    const month = dayKey(0).slice(0, 7);
    const roundUnread = async (tag, cfg, prep) => {
      const { ctx, page } = await open(ARTIFACT + '#saved', { viewport: { width: 1000, height: 800 } }, tag, Object.assign({ failReads: { ['log-' + month]: 99 } }, cfg), noFocusRefresh);
      // The cloud's record of today (or {}), and whether nothing is being written to the month.
      const today = () => page.evaluate(m => ({ day: (window.__store.get('data/users/u_test/log-' + m) || { days: {} }).days[window.__mockToday] || {}, idle: !window.__kaikouTest.Store.busyDoc('log-' + m) }), month);
      const waitFor = async key => { for (let i = 0; i < 60; i++) { const t = await today(); if (t.idle && t.day.items && t.day.items[key]) return t.day; await page.waitForTimeout(100); } throw new Error(key + ' was not written'); };
      if (prep) await page.evaluate(prep, month);
      await page.click('[data-fk="drill-start"]');
      for (let i = 0; i < 3; i++) { await page.click('[data-fk="flip"]'); await page.click('[data-fk="rate-2"]'); }
      await until(page, () => !!window.__kaikouTest.S.drill && window.__kaikouTest.S.drill.done);
      const first = await waitFor('chunk');
      const plan = d => page.evaluate(x => window.__kaikouTest.resolvePlan(x.plans || {}, x.plan || ''), d);
      const firstPlan = await plan(first);
      await page.waitForTimeout(300);
      await page.evaluate(m => { window.__mockCfg.failReads['log-' + m] = 0; }, month);
      await page.click('#t-today');
      await page.click('#today-dyn .list .item:nth-child(4) .check'); // the month is read, then 聽 Podcast is ticked
      const day = await waitFor('listen');
      const dayPlan = await plan(day);
      await ctx.close();
      return { first: firstPlan, plan: dayPlan, items: day.items };
    };
    // In the cloud today is a 60-minute day (its own default), while this device's default is 20.
    const kept = await roundUnread('unread-auto', {}, m => { const L = window.__store.get('data/users/u_test/log-' + m); L.days[window.__mockToday] = { items: { shadow: true }, plans: { 0: '60' } }; });
    // The cloud has no record of today; this device's default is 60.
    const given = await roundUnread('unread-auto-new', { noToday: true, settings: { plan: '60' } });
    check('還讀不到這個月的紀錄時做完一輪句子複習：照樣打勾語塊複習；雲端那天有自己的計畫就保留，沒有就用這台裝置的預設', () => {
      eq(kept, { first: '60', plan: '60', items: { shadow: true, chunk: true, listen: true } });
      eq(given, { first: '60', plan: '60', items: { chunk: true, listen: true } });
    });
  }
  if (want('4')) {
    // i3. The cloud stops while two documents are on their way there: the one that fails after the page has switched
    //     to this browser is kept for the next cloud visit too.
    const month = dayKey(0).slice(0, 7);
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'held-inflight', { failWrites: { ['log-' + month]: { n: 1, code: 'revoked' }, inbox: { n: 1, code: 'revoked' } } });
    await page.click('#today-dyn .list .item:nth-child(4) .check');
    await page.fill('#inbox-input', '兩份資料一起送出時記的句子');
    await page.click('#inbox-form .btn');
    await page.evaluate(() => window.__kaikouTest.Store.flushAll()); // both at once, as when the page is hidden
    await until(page, m => window.__kaikouTest.Store.mode === 'local' && !['inbox', 'log-' + m].some(n => window.__kaikouTest.Store.busyDoc(n)), month, 6000);
    const held = await page.evaluate(() => JSON.parse(localStorage.getItem('kaikou:held') || 'null'));
    const docs = (held && held.docs) || {};
    check('雲端在兩份資料都在路上時停止：比較晚失敗的那份也記下來，下次連上時一起存到雲端', () => eq([
      !!(docs['log-' + month] && docs['log-' + month].days[dayKey(0)] && docs['log-' + month].days[dayKey(0)].items.listen),
      Object.values((docs.inbox || {}).map || {}).some(x => x && x.text === '兩份資料一起送出時記的句子')], [true, true]));
    await ctx.close();
  }
  if (want('4')) {
    // i3b. A note is on its way to the cloud when the cloud stops (another document found out), and is deleted before
    //      its own write fails: the deletion, made later, is what is kept for the next cloud visit.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'held-inflight-undo', { writeDelay: { inbox: 2500 }, failWrites: { inbox: { n: 1, code: 'revoked' }, phrases: { n: 1, code: 'revoked' } } });
    await page.fill('#inbox-input', '雲端停止時又刪掉的句子');
    await page.click('#inbox-form .btn');
    const id = await page.evaluate(() => window.__kaikouTest.S.inbox.find(x => x.text === '雲端停止時又刪掉的句子').id);
    await until(page, () => window.__kaikouTest.Store.inflight.inbox > 0, null, 4000); // on its way (slowly)
    await page.click('#t-saved');
    await page.click('#starters .icon-btn[aria-pressed="false"][aria-label="收藏"]');
    await until(page, () => window.__kaikouTest.Store.mode === 'local', null, 4000);
    await page.click('#t-today');
    await page.click('[data-fk="del-' + id + '"]');
    await page.click('[data-fk="del-' + id + '"]');
    await until(page, () => !window.__kaikouTest.Store.busyDoc('inbox'), null, 8000);
    const kept = await page.evaluate(x => { const h = JSON.parse(localStorage.getItem('kaikou:held') || '{}'); return ((h.docs || {}).inbox || { map: {} }).map[x]; }, id);
    check('雲端停止時正在送出的句子，在那之後又刪掉：留下的是刪除，下次連上時不會把它加回去', () => assert.ok(kept === null || kept === undefined, JSON.stringify(kept)));
    await ctx.close();
  }
  if (want('4')) {
    // i3b2. The same, with the deletion still waiting to be sent to the cloud when it stops: the deletion is what is
    //       held, and this browser's copy does not get the note back either.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'held-inflight-undo2', { writeDelay: { inbox: 2500 }, failWrites: { inbox: { n: 1, code: 'revoked' }, phrases: { n: 1, code: 'revoked' } } });
    await page.fill('#inbox-input', '雲端停止前就刪掉的句子');
    await page.click('#inbox-form .btn');
    const id = await page.evaluate(() => window.__kaikouTest.S.inbox.find(x => x.text === '雲端停止前就刪掉的句子').id);
    await until(page, () => window.__kaikouTest.Store.inflight.inbox > 0, null, 4000);
    await page.click('[data-fk="del-' + id + '"]');
    await page.click('[data-fk="del-' + id + '"]'); // waits behind the slow write
    await page.click('#t-saved');
    await page.click('#starters .icon-btn[aria-pressed="false"][aria-label="收藏"]');
    await until(page, () => window.__kaikouTest.Store.mode === 'local', null, 4000);
    await until(page, () => !window.__kaikouTest.Store.busyDoc('inbox'), null, 8000);
    const left = await page.evaluate(x => { const h = JSON.parse(localStorage.getItem('kaikou:held') || '{}'); return { held: ((h.docs || {}).inbox || { map: {} }).map[x], local: !!(((JSON.parse(localStorage.getItem('kaikou:inbox') || '{}')).map || {})[x]) }; }, id);
    check('刪除還在等著送出時雲端就停止：留下的是刪除，這個瀏覽器的副本也不會把句子加回去', () => {
      assert.ok(left.held === null || left.held === undefined, JSON.stringify(left.held));
      eq(left.local, false);
    });
    await ctx.close();
  }
  if (want('4')) {
    // i3d. A review round ticks 語塊複習 while this month could not be read, the cloud stops before the tick is saved,
    //      and the learner takes the tick back: nothing is left to save, so the next cloud visit offers nothing.
    const month = dayKey(0).slice(0, 7);
    const { ctx, page } = await open(ARTIFACT + '#saved', { viewport: { width: 1000, height: 800 } }, 'held-blind-undo', { failReads: { ['log-' + month]: 99 }, failWrites: { ['log-' + month]: { n: 1, code: 'revoked' } } }, noFocusRefresh);
    await page.click('[data-fk="drill-start"]');
    for (let i = 0; i < 3; i++) { await page.click('[data-fk="flip"]'); await page.click('[data-fk="rate-2"]'); }
    await until(page, () => window.__kaikouTest.Store.mode === 'local', null, 6000);
    await page.click('#t-today');
    await page.click('#today-dyn .list .item:nth-child(3) .check'); // 語塊複習 off again
    await until(page, m => !window.__kaikouTest.Store.busyDoc('log-' + m), month, 6000);
    const left = await page.evaluate(m => { const h = JSON.parse(localStorage.getItem('kaikou:held') || '{}'); const d = (h.docs || {})['log-' + m]; return d && d.days ? Object.keys(d.days) : []; }, month);
    check('還讀不到這個月時自動打勾、雲端停止後又取消：沒有留下要存的變更', () => eq(left, []));
    await ctx.close();
  }
  if (want('4')) {
    // i3c. Two plan choices while this month could not be read: the last one is the choice, also when the read the
    //      first tap started answers after the second's.
    const month = dayKey(0).slice(0, 7);
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'plan-order', { failReads: { ['log-' + month]: 99 } }, noFocusRefresh);
    await page.waitForTimeout(300);
    await page.evaluate(m => { window.__mockCfg.failReads['log-' + m] = 1; }, month); // the next read fails once (and is tried again)
    await page.click('[data-fk="plan-60"]');
    await page.waitForTimeout(150);
    await page.click('[data-fk="plan-20"]');
    await page.waitForTimeout(2000); // the first read has been tried again by now
    await until(page, m => !window.__kaikouTest.Store.busyDoc('log-' + m), month, 6000);
    const chosen = await page.evaluate(m => { const d = window.__store.get('data/users/u_test/log-' + m).days[window.__mockToday]; return { cloud: window.__kaikouTest.resolvePlan(d.plans || {}, d.plan || ''), pressed: document.querySelector('[data-fk="plan-20"]').getAttribute('aria-pressed') }; }, month);
    check('還讀不到這個月的紀錄時連續選了兩次計畫：以最後按的為準', () => eq(chosen, { cloud: '20', pressed: 'true' }));
    await ctx.close();
  }
  if (want('4')) {
    // i4. A viewer whose link cannot write ticks something and takes it back: nothing is left to save, so trying the
    //     cloud again later (after being given access) sends nothing, not this browser's empty days and default
    //     settings over what the cloud has.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'readonly-undo', { readOnly: true, owner: false });
    const first = '#today-dyn .list .item:nth-child(1) .check';
    await page.click(first);
    await until(page, () => window.__kaikouTest.Store.why === 'no_write', null, 6000);
    await page.click(first);
    await until(page, () => !window.__kaikouTest.Store.busyDoc('log-' + window.__mockToday.slice(0, 7)));
    await page.evaluate(() => { window.__mockCfg.readOnly = false; });
    await page.click('#btn-settings');
    await page.click('#set-cloud');
    await until(page, () => window.__kaikouTest.Store.mode === 'db' && !window.__kaikouTest.S.uploading, null, 10000);
    const cloud = await page.evaluate(() => {
      const get = n => window.__store.get('data/users/u_test/' + n);
      return { about: get('settings').about, shadow: get('log-' + window.__mockToday.slice(0, 7)).days[window.__mockToday].items.shadow, saved: window.__dbCalls.filter(c => !['get', 'list'].includes(c.op) && !c.code).map(c => c.name) };
    });
    check('不能寫入的連結：打勾又取消，之後拿到權限再存到雲端時沒有東西要送，不會把這個瀏覽器的空白資料和預設設定蓋到雲端', () => eq(cloud, { about: 'I live in Taipei and work in marketing.', shadow: true, saved: [] }));
    await ctx.close();
  }
  if (want('4')) {
    // j. A refusal is described for what was asked: hints (a task) and the coach's opening line (nothing to resend).
    const { ctx, page } = await open(ARTIFACT + '#coach', { viewport: { width: 1000, height: 800 } }, 'refused-task', { refuse: 'Begin', refuseTask: true });
    const note = () => page.evaluate(() => ({ text: document.querySelector('#coach-note').textContent, retry: !!document.querySelector('#coach-note [data-fk="retry"]') }));
    await page.click('#hint-btn');
    await until(page, () => /教練沒辦法/.test(document.querySelector('#coach-note').textContent));
    const task = await note();
    await page.click('[data-fk="discard"]');
    await page.click('[data-fk="discard"]');
    await page.click('#start-btn');
    await until(page, () => /教練沒辦法/.test((document.querySelector('#coach-note') || {}).textContent || ''));
    const opening = await note();
    check('教練拒絕時依情況說明：提示請你換個話題或說法；開場請你換一個話題或情境，不提供重送', () => {
      eq([task.text, task.retry], ['教練沒辦法處理這個要求，換個話題或說法再試一次。', false]);
      eq([opening.text, opening.retry], ['教練沒辦法用這個話題或情境開始。按「放棄」回到選單，換一個再試。', false]);
    });
    await ctx.close();
  }
  if (want('4')) {
    // k. The viewer does not allow the coach (sample() rejects not_granted): it says so once and stops offering it.
    const { ctx, page } = await open(ARTIFACT + '#coach', { viewport: { width: 1000, height: 800 } }, 'not-granted', { sampleCode: 'not_granted' });
    await page.fill('#msg-input', 'We went to the beach');
    await page.click('#send-btn');
    await until(page, () => window.__kaikouTest.S.sampleState === 'blocked' && !window.__kaikouTest.S.busy);
    await page.waitForTimeout(300);
    const dec = await page.evaluate(() => ({ note: document.querySelector('#coach-note').textContent, retry: !!document.querySelector('#coach-note [data-fk="retry"]'), send: document.querySelector('#send-btn').disabled, calls: window.__calls.filter(c => c.kind === 'sample').length }));
    await page.click('[data-fk="discard"]');
    await page.click('[data-fk="discard"]');
    const menu = await page.evaluate(() => ({ title: document.querySelector('#coach-dyn .card-title').textContent, start: !!document.querySelector('#start-btn') }));
    check('不允許教練（sample 回 not_granted）：說明怎麼重新允許，不重送也不再呼叫；回到選單時說明，不提供開始', () => {
      eq(dec, { note: '這個頁面還沒取得使用 Claude 的權限。重新開啟頁面，詢問時選「允許」。', retry: false, send: true, calls: 1 });
      eq(menu, { title: 'AI 教練目前無法使用', start: false });
    });
    await ctx.close();
  }
  if (want('4')) {
    // l. A view that cannot run the coach or save files (use() resolves null): the chat, the menu, the shadowing tool
    //    and the backup export each say so.
    const { ctx, page } = await open(ARTIFACT + '#coach', { viewport: { width: 1000, height: 800 } }, 'no-caps', { noSample: true, noDownloads: true });
    await until(page, () => window.__kaikouTest.S.sampleState === 'none');
    const chatNote = await page.textContent('#coach-note');
    await page.click('[data-fk="discard"]');
    await page.click('[data-fk="discard"]');
    const menu = await page.evaluate(() => ({ title: document.querySelector('#coach-dyn .card-title').textContent, text: document.querySelector('#coach-dyn .help').textContent }));
    await page.click('#t-today');
    await page.click('[data-fk="go-shadow"]');
    const tool = await page.evaluate(() => [...document.querySelectorAll('#today-dyn .help')].map(n => n.textContent).find(t => /AI 回覆/.test(t)) || '');
    await page.click('[data-fk="tool-back"]');
    await page.click('#btn-settings');
    await page.click('#set-export');
    await until(page, () => !window.__kaikouTest.S.exporting);
    const exp = await page.evaluate(() => document.querySelector('#toast').textContent);
    check('Claude 裡拿不到 AI 回覆或下載功能：對話、選單、跟讀說明可能的原因和做法，匯出說明不能下載', () => {
      assert.ok(/拿不到 Claude 的 AI 回覆/.test(chatNote) && /教練不能回覆/.test(chatNote) && /不是在 Claude 裡打開/.test(chatNote), chatNote);
      eq(menu.title, 'AI 教練目前無法使用');
      assert.ok(/拿不到 Claude 的 AI 回覆/.test(menu.text) && /今日菜單與打卡照樣可以用/.test(menu.text), menu.text);
      assert.ok(/教練不能寫短文/.test(tool), tool);
      eq(exp, '這個畫面不能下載檔案');
    });
    await ctx.close();
  }
  if (want('4')) {
    // m. On a phone, the focus never lands in the text box by itself (the keyboard would cover the conversation):
    //    not after starting a chat, nor after asking the coach again.
    const { ctx, page } = await open(ARTIFACT + '#coach', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, 'touch-focus', { failWrites: {} });
    const where = () => page.evaluate(() => { const a = document.activeElement; return a && (a.id || a.dataset.fk || a.tagName); });
    await page.tap('[data-fk="discard"]');
    await page.tap('[data-fk="discard"]');
    await page.tap('#start-btn');
    await notBusy(page);
    const started = await where();
    check('手機上開始對話之後，焦點不會自己跑到輸入框（不會叫出鍵盤蓋住對話）', () => assert.ok(started !== 'msg-input', started));
    await ctx.close();
  }
  if (want('4')) {
    // h. A chat that ends around midnight is counted for the day it was practised: when its review comes back after
    //    midnight, and when the review of a chat finished just before midnight is asked for after it.
    const midnight = async (tag, beforeClick, afterClick) => {
      const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
      // Late in the evening, with time to spare for a slow start; then on to half a minute before midnight.
      const late = new Date(NOON); late.setHours(23, 50, 0, 0);
      const t = (min, sec) => late.getTime() + (min * 60 + sec) * 1000; // minutes and seconds after 23:50
      await ctx.clock.install({ time: late });
      const page = await addPage(ctx, ARTIFACT + '#coach', tag);
      await page.fill('#msg-input', 'We stayed up late to watch a film');
      await page.click('#send-btn');
      await notBusy(page);
      await clockTo(page, t(9, 30)); // 23:59:30
      await beforeClick(page, t);
      await page.click('[data-fk="review"]');
      await afterClick(page, t);
      await until(page, () => !!window.__kaikouTest.S.review && !window.__kaikouTest.S.reviewing, null, 10000);
      await until(page, () => { const X = window.__kaikouTest, m = window.__mockToday.slice(0, 7); return !X.Store.busyDoc('log-' + m) && !X.Store.busyDoc('sessions-' + m); }, null, 8000);
      const r = await page.evaluate(() => {
        const X = window.__kaikouTest, D = window.__mockToday, d = new Date();
        const nk = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        const day = window.__store.get('data/users/u_test/log-' + D.slice(0, 7)).days[D];
        const next = (X.S.logs[nk.slice(0, 7)] || { days: {} }).days[nk];
        return { past: nk !== D, ai: !!day.items.ai, coach: (day.coach || {}).c1 > 0, date: X.S.review.date === D, next: !!(next && next.items.ai) };
      });
      await ctx.close();
      return r;
    };
    // The review is asked for at 23:59:30 and its answer comes at 00:00:45.
    const across = await midnight('midnight-review', p => p.evaluate(() => { window.__mockCfg.jsonDelay = 70000; }),
      async (p, t) => { await until(p, () => window.__kaikouTest.S.reviewing); await clockTo(p, t(10, 45)); });
    // The chat ends at 23:50, its review is asked for at 00:00:35.
    const after = await midnight('midnight-after', (p, t) => clockTo(p, t(10, 35)), async () => {});
    check('午夜前後結束的對話：複習在午夜後才回來，或午夜後才按複習，都算在練習的那一天', () => {
      eq(across, { past: true, ai: true, coach: true, date: true, next: false });
      eq(after, { past: true, ai: true, coach: true, date: true, next: false });
    });
  }

  // ---------- 5. In Claude: daily phrase review, shadowing and 4/3/2 ----------
  if (want('5')) {
    const { ctx, page } = await open(ARTIFACT_SPEECH, { viewport: { width: 400, height: 860 }, deviceScaleFactor: 2 }, 'tools');
    await until(page, () => document.querySelector('#sync').textContent === '已同步');
    const T = (f, a) => page.evaluate(f, a);
    const tk = await T(() => window.__mockToday);
    const plus = n => { const d = new Date(tk + 'T12:00:00'); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
    const pure = await T(() => {
      const X = window.__kaikouTest;
      return {
        ivl: [X.nextIvl(null, 0), X.nextIvl(null, 1), X.nextIvl(null, 2), X.nextIvl({ i: 2 }, 2), X.nextIvl({ i: 5 }, 2), X.nextIvl({ i: 5 }, 1), X.nextIvl({ i: 300 }, 2)],
        split: X.splitSentences('Mr. Smith went to Washington.  He liked it! Did he stay long? No.'),
        abbr: X.splitSentences('We use tools, e.g. a timer. I moved to the U.S. last year. It costs 3.5 dollars. Mr. Lee agreed.'),
        long: X.splitSentences(Array(30).fill('we talked about the plan').join(', ') + '.').map(s => s.length),
      };
    });
    check('句子複習：間隔天數（忘了今天再一次、新句子記得 2 天、之後約 ×2.5）；貼上的稿子正確斷句', () => {
      eq(pure.ivl, [0, 1, 2, 5, 13, 6, 365]);
      eq(pure.split, ['Mr. Smith went to Washington.', 'He liked it!', 'Did he stay long?', 'No.']);
      eq(pure.abbr, ['We use tools, e.g. a timer.', 'I moved to the U.S. last year.', 'It costs 3.5 dollars.', 'Mr. Lee agreed.']);
      assert.ok(pure.long.length > 1 && pure.long.every(n => n <= 240), 'long sentences are split: ' + pure.long.join(','));
    });

    // The three saved phrases are new: today's 語塊複習 offers them; space flips a card and 1/2/3 rate it.
    const offer = await page.textContent('[data-fk="go-drill"]');
    await page.click('[data-fk="go-drill"]');
    await until(page, () => !!document.querySelector('#drill [data-fk="flip"]'));
    const front = () => T(() => ({ kind: document.querySelector('.drill-q .eyebrow').textContent, text: document.querySelector('.drill-q .big').textContent }));
    const f1 = await front();
    const hidden = await T(() => [document.querySelector('#starters').hidden, document.querySelector('#mine-card').hidden]);
    await page.keyboard.press(' ');
    await until(page, () => window.__kaikouTest.S.drill.flip);
    const labels = await T(() => [...document.querySelectorAll('.rate small')].map(n => n.textContent));
    await shot(page, '11-drill-phone.png');
    await page.keyboard.press('3');
    await until(page, () => window.__kaikouTest.S.drill.i === 1 && !window.__kaikouTest.S.drill.flip);
    const f2 = await front();
    await page.click('[data-fk="flip"]'); await page.click('[data-fk="rate-0"]');
    await page.click('[data-fk="flip"]'); await page.click('[data-fk="rate-1"]');
    const f4 = await front();
    await page.click('[data-fk="flip"]'); await page.click('[data-fk="rate-2"]');
    await until(page, () => window.__kaikouTest.S.drill.done);
    await until(page, () => { const X = window.__kaikouTest; return !X.Store.busyDoc('srs') && !X.Store.busyDoc('log-' + window.__mockToday.slice(0, 7)); });
    const dr = await T(() => {
      const X = window.__kaikouTest, id = s => X.phraseId(s);
      const srs = window.__store.get('data/users/u_test/srs').map;
      const day = window.__store.get('data/users/u_test/log-' + window.__mockToday.slice(0, 7)).days[window.__mockToday];
      const pick = e => [e.d, e.i, e.r, e.l, e.f, e.t];
      return { p1: pick(srs[id('I went hiking with my friends.')]), p2: pick(srs[id("I'll get back to you on that.")]), p3: pick(srs[id('It slipped my mind.')]), chunk: !!day.items.chunk, text: document.querySelector('#drill').textContent, shown: !document.querySelector('#mine-card').hidden };
    });
    check('句子複習：今日的語塊複習帶進來，看提示說、翻面、評分，忘了的句子這一輪再出現一次', () => {
      eq(offer, '開始複習（3 句）');
      eq(f1, { kind: '唸熟這一句', text: 'I went hiking with my friends.' });
      eq(hidden, [true, true]);
      eq(labels, ['等一下再一次', '明天', '2 天後']);
      eq([f2, f4], [{ kind: '用英文怎麼說', text: '這個我再回覆你。' }, { kind: '用英文怎麼說', text: '這個我再回覆你。' }]);
    });
    check('句子複習：存下每句的下次時間，一輪做完自動打勾「語塊複習」', () => {
      eq(dr.p1, [plus(2), 2, 1, 0, tk, tk]);
      eq(dr.p2, [plus(2), 2, 1, 1, tk, tk]);
      eq(dr.p3, [plus(1), 1, 1, 0, tk, tk]);
      eq(dr.chunk, true);
      assert.ok(dr.text.includes('複習了 4 次：記得 2、有點卡 1、忘了 1。'), dr.text);
      assert.ok(dr.text.includes('明天有 1 句到期'), dr.text);
      eq(dr.shown, true);
    });

    // A saved correction keeps the learner's words, and its card asks for the better version.
    await page.click('#t-coach');
    const fixId = await T(() => 'star:fx:' + window.__kaikouTest.phraseId('I went hiking'));
    await page.click('[data-fk="' + fixId + '"]');
    await page.click('#t-saved');
    await page.click('[data-fk="drill-close"]');
    await page.click('[data-fk="drill-start"]');
    const fx = await front();
    await page.click('[data-fk="drill-end"]');
    const stored = await T(() => { const X = window.__kaikouTest; return X.S.phrases.find(p => p.en === 'I went hiking').was; });
    check('收藏「更自然的說法」時留下原本的說法，複習時請你說出更好的版本', () => {
      eq(stored, 'I go to hiking');
      eq(fx, { kind: '改成更自然的說法', text: 'I go to hiking' });
    });

    // Shadowing: the coach writes a passage; sentences play one by one at the shadowing speed.
    await page.click('#t-today');
    await page.click('[data-fk="go-shadow"]');
    await page.click('[data-fk="sh-gen"]');
    await until(page, () => document.querySelectorAll('.sent').length === 6, null, 6000);
    const call = await T(() => window.__calls.filter(c => /^Write a short passage/.test(c.head || '')).map(c => c.tier));
    await T(() => { window.__spoken = []; });
    await page.click('[data-fk="sh-play"]');
    await until(page, () => window.__spoken.length >= 2, null, 8000);
    await page.click('[data-fk="sh-play"]');
    const paused = await T(() => ({ playing: window.__kaikouTest.S.sh.playing, idx: window.__kaikouTest.S.sh.idx, rate: window.__spoken[0].rate, first: window.__spoken[0].text }));
    await page.click('[data-fk="shm-flow"]');
    await page.click('[data-fk="sh-play"]');
    await until(page, () => !window.__kaikouTest.S.sh.playing && window.__kaikouTest.S.sh.idx === -1, null, 10000);
    const said = await T(() => window.__spoken.map(s => s.text));
    await shot(page, '12-shadow-phone.png', true);
    await page.click('[data-fk="sh-done"]');
    await until(page, () => !window.__kaikouTest.Store.busyDoc('shadow') && !!window.__store.get('data/users/u_test/shadow'));
    const sh = await T(() => { const d = window.__store.get('data/users/u_test/shadow'); const p = d.map[d.cur]; return { title: p.title, n: p.sents.length, days: Object.keys(p.days), tag: document.querySelector('#today-dyn .tag').textContent }; });
    check('影子跟讀：教練依程度寫短文，聽一句跟一句、可暫停、可連續播放，完成後記下練習的天數', () => {
      eq(call, ['default']);
      eq([paused.playing, paused.rate, paused.first], [false, 0.85, "I didn't have any plans last Saturday."]);
      assert.ok(paused.idx >= 1, 'paused on a later sentence');
      eq(said.slice(-1)[0], 'It was a simple day, but I really needed it.');
      eq(new Set(said).size, 6);
      eq(sh, { title: 'A Slow Saturday', n: 6, days: [tk], tag: '今天練過了・第 1 天' });
    });

    // 4/3/2: talking points from the coach, a timer that pauses, and three rounds that tick the weekly item.
    await page.click('[data-fk="tool-back"]');
    await page.click('[data-fk="go-f432"]');
    // Points asked for one topic never show up under another topic picked while the coach was still thinking.
    await T(() => { window.__mockCfg.jsonDelay = 800; });
    await page.click('[data-fk="f432-points"]');
    await page.click('#today-dyn [data-fk="chip-trip"]');
    await page.waitForTimeout(1300);
    const stale = await T(() => ({ topic: window.__kaikouTest.S.f432.topic, points: window.__kaikouTest.S.f432.points, shown: document.querySelectorAll('.points li').length }));
    await page.click('#today-dyn [data-fk="chip-intro"]');
    await T(() => { window.__mockCfg.jsonDelay = 30; });
    await page.click('[data-fk="f432-points"]');
    await until(page, () => document.querySelectorAll('.points li').length === 3);
    await page.click('[data-fk="f432-go"]');
    await until(page, () => window.__kaikouTest.S.f432.state === 'run');
    await ff(page, 5000);
    await page.click('[data-fk="f432-pause"]');
    const c1 = await page.textContent('#f432-clock');
    await ff(page, 30000);
    const c2 = await page.textContent('#f432-clock');
    await page.click('[data-fk="f432-resume"]');
    await shot(page, '13-f432-phone.png');
    await ff(page, 30000);
    const bar30 = await T(() => { const b = document.querySelector('#f432-bar'); return [Number(b.getAttribute('aria-valuenow')), b.getAttribute('aria-valuetext')]; });
    await ff(page, 210000);
    await until(page, () => window.__kaikouTest.S.f432.state === 'gap');
    const gap = await page.textContent('.timer-title');
    await page.click('[data-fk="f432-next"]');
    await ff(page, 181000);
    await until(page, () => window.__kaikouTest.S.f432.state === 'gap' && window.__kaikouTest.S.f432.phase === 2);
    await page.click('[data-fk="f432-next"]');
    await until(page, () => window.__kaikouTest.S.f432.state === 'run');
    await page.click('[data-fk="f432-end"]');
    await until(page, () => window.__kaikouTest.S.f432.state === 'done');
    await until(page, () => !window.__kaikouTest.Store.busyDoc('log-' + window.__mockToday.slice(0, 7)));
    const f = await T(() => ({ ticked: !!window.__store.get('data/users/u_test/log-' + window.__mockToday.slice(0, 7)).days[window.__mockToday].items.f432, title: document.querySelector('.timer-title').textContent, rec: !!document.querySelector('[data-fk="f432-rec"]'), tag: document.querySelector('#today-dyn .tag').textContent }));
    check('4/3/2：教練給重點（想重點時換了主題就不顯示舊的），計時可暫停、進度條報剩下的時間，三次講完自動打勾本週的 4/3/2', () => {
      eq(stale, { topic: 'trip', points: null, shown: 0 });
      eq([c1, c2], ['3:55', '3:55']);
      assert.ok(bar30[0] >= 10 && bar30[0] <= 20 && /^還剩 3:2\d$/.test(bar30[1]), bar30.join(' '));
      eq(gap, '第 1 次完成！');
      eq(f, { ticked: true, title: '三次都講完了！', rec: false, tag: '本週 1 / 1' });
    });

    // Pronunciation in Claude: the pairs can be heard (no microphone here) and the listening quiz works.
    await page.click('#t-saved');
    const lessons =await T(() => [...document.querySelectorAll('#pron .lesson b')].map(n => n.textContent));
    await page.click('[data-fk="pron-th"]');
    const lesson = await T(() => ({
      title: document.querySelector('#pron h2').textContent, focus: document.activeElement === document.querySelector('#pron h2'),
      pairs: document.querySelectorAll('#pron .pair').length, speakers: document.querySelectorAll('#pron .word [data-fk^="spk:"]').length,
      mics: document.querySelectorAll('#pron [data-say-btn]').length, sents: document.querySelectorAll('#pron .sent-list .phrase').length,
      hidden: ['#drill', '#starters', '#mine-card'].map(s => document.querySelector(s).hidden),
    }));
    await T(() => { window.__spoken = []; });
    await page.click('[data-fk="quiz-start"]');
    const asked = [], feedback = [], focus = [];
    for (let i = 0; i < 6; i++) {
      const q = await T(() => { const X = window.__kaikouTest, z = X.S.pron.quiz, [pi, side] = z.q[z.i]; return { side, word: X.PRON[0].pairs[pi][side] }; });
      asked.push(q.word);
      // The word is said a moment after the question shows (focus is on 再聽一次 first).
      focus.push(await T(() => [document.activeElement.dataset.fk, document.activeElement.getAttribute('aria-label')]));
      await until(page, n => window.__spoken.length === n, i + 1);
      await page.click('[data-fk="quiz-' + (i < 2 ? q.side : 1 - q.side) + '"]'); // the first two right, the rest wrong
      feedback.push(await T(() => document.querySelector('#pron .quiz p').textContent));
      focus.push(await T(() => document.activeElement.dataset.fk));
      if (i === 1) await shot(page, '14-pron-quiz-phone.png');
      await page.click('[data-fk="quiz-next"]');
    }
    const result = await T(() => ({ score: document.querySelector('#pron .quiz-score').textContent, focus: document.activeElement && document.activeElement.dataset.fk, stored: JSON.parse(localStorage.getItem('kaikou:pron')).th, spoken: window.__spoken.map(s => s.text) }));
    // 再聽一次 pressed right away replaces the word that was about to be said (it is not said twice).
    await T(() => { window.__spoken = []; });
    await page.click('[data-fk="quiz-again"]');
    await page.click('[data-fk="quiz-play"]');
    await page.waitForTimeout(700);
    const replay = await T(() => window.__spoken.length);
    await page.click('[data-fk="pron-back"]');
    const back = await T(() => ({ stat: document.querySelector('[data-fk="pron-th"] span').textContent, focus: document.activeElement && document.activeElement.dataset.fk, shown: ['#drill', '#starters', '#mine-card'].map(s => !document.querySelector(s).hidden) }));
    check('發音練習（Claude 版）：8 組重點、每組 6 對字與 3 句，可以聽但沒有麥克風；打開時收藏的其他部分先收起', () => {
      eq(lessons.length, 8);
      eq(lessons[0], 'th：think 不是 sink');
      eq(lesson, { title: 'th：think 不是 sink', focus: true, pairs: 6, speakers: 12, mics: 0, sents: 3, hidden: [true, true, true] });
    });
    check('發音練習：聽辨小測驗播出題目的字、選完告訴你對錯，6 題後記下成績；鍵盤焦點跟著走', () => {
      eq(result.spoken, asked);
      eq([feedback[0], feedback[1]], ['答對了！', '答對了！']);
      eq(focus.slice(0, 4), [['quiz-play', '第 1 題，再聽一次'], 'quiz-next', ['quiz-play', '第 2 題，再聽一次'], 'quiz-next']);
      assert.ok(feedback[2].startsWith('答案是「' + asked[2] + '」'), feedback[2]);
      eq([result.score, result.focus, result.stored.quiz, result.stored.t, replay], ['聽對 2 / 6', 'quiz-score', [2, 6], tk, 1]);
      eq(back, { stat: '今天練過・聽辨 2 / 6', focus: 'pron-th', shown: [true, true, true] });
    });

    // A phrase review started from 今日 while a lesson is open takes the 收藏 tab over.
    await page.click('[data-fk="pron-th"]');
    await page.click('#t-today');
    await page.click('[data-fk="tool-back"]'); // the finished 4/3/2 is still open there
    await page.click('[data-fk="go-drill"]');
    const drillOver = await T(() => ({ pron: window.__kaikouTest.S.pron, drill: !!window.__kaikouTest.S.drill, shown: ['#drill', '#pron'].map(s => !document.querySelector(s).hidden), focus: document.activeElement === document.querySelector('#drill .card-title') }));
    await page.click('[data-fk="drill-end"]');
    check('發音練習開著時從今日開始句子複習：課程收起，複習卡出現並取得焦點', () => eq(drillOver, { pron: null, drill: true, shown: [true, false], focus: true }));

    // No voice conversation inside Claude (no microphone there), even with an open chat.
    await page.click('#t-coach');
    const noVoice = await T(() => ({ chat: !!window.__kaikouTest.S.chat, toggle: !!document.querySelector('[data-fk="voice"]'), bar: document.querySelector('#voice-bar').hidden }));
    check('Claude 版沒有語音對話（不能用麥克風）', () => eq(noVoice, { chat: true, toggle: false, bar: true }));
    await ctx.close();
  }

  if (want('5')) {
    // The review schedule cannot be read: no round starts (its ratings would overwrite the stored schedule).
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'srs-unread', { failReads: { srs: 99 } });
    const offered = await page.evaluate(() => !!document.querySelector('[data-fk="go-drill"]'));
    await page.click('#t-saved');
    const msg = await page.textContent('#drill');
    await page.click('[data-fk="drill-start"]');
    await until(page, () => /還讀不到你的複習紀錄/.test(document.querySelector('#toast').textContent));
    const blocked = await page.evaluate(() => !!window.__kaikouTest.S.drill);
    await page.evaluate(() => { window.__mockCfg.failReads.srs = 0; });
    await page.click('[data-fk="drill-start"]');
    await until(page, () => !!window.__kaikouTest.S.drill);
    check('句子複習：還讀不到複習紀錄時不開始（以免蓋掉排好的時間），讀到之後才開始', () => {
      eq([offered, blocked], [false, false]);
      assert.ok(msg.includes('還讀不到你的複習紀錄'), msg);
    });
    await ctx.close();
  }

  // ---------- 6. GitHub Pages with a microphone: dictation and the read-aloud check ----------
  if (want('6')) {
    const KEY = 'sk-ant-api03-' + 'TESTONLY'.repeat(6) + '-AA';
    const { ctx, page } = await open(base + '#coach', { viewport: { width: 1000, height: 800 }, serviceWorkers: 'block' }, 'mic', null, speech);
    await giveKey(page, KEY);
    const sent = [];
    let slowReply = 0;
    await page.route('https://api.anthropic.com/v1/messages', async route => {
      const msgs = (JSON.parse(route.request().postData() || '{}').messages) || [];
      const last = String((msgs[msgs.length - 1] || {}).content || '');
      sent.push(last.slice(-40));
      if (slowReply) { const ms = slowReply; slowReply = 0; await new Promise(r => setTimeout(r, ms)); }
      if (/這個功能下週上線$/.test(last)) return sseReply(route, "casual: This won't be out until next week.\nneutral: This feature launches next week.\nSay one of them out loud.\n###\n{\"none\": true}");
      if (/I go to park yesterday$/.test(last)) return sseReply(route, 'Nice! Which park did you go to?\n###\n{"you": "I go to park yesterday", "better": "I went to the park yesterday", "why": "過去式"}');
      return sseReply(route, 'Hi! What did you do last weekend?\n###\n{"none": true}');
    });
    const T = (fn, a) => page.evaluate(fn, a);
    const pure = await T(() => {
      const X = window.__kaikouTest;
      const c = (a, b) => { const r = X.compareSaid(a, b); return [r.hit, r.total, r.marks.filter(m => m.ok === false).map(m => m.w)]; };
      return {
        tokens: X.sayTokens("I'm sure it's two o'clock — can't wait, let's go!"),
        same: c("I'll get back to you on that.", 'I will get back to you on that'),
        miss: c('Could you speak a bit more slowly?', 'could you speak more slowly'),
        nums: c('I have two kids.', 'I have 2 kids'),
        // Numbers said in words are one number, as a recogniser writes them; a list of digits stays a list.
        more: [c("I'm twenty-five.", "I'm 25"), c('It costs two hundred and fifty dollars.', 'it costs 250 dollars'), c('It was two thousand twenty six.', 'it was 2026'),
          c('Okay, see you then.', 'ok see you then'), c('Press one two three.', 'press 1 2 3'), c('We sold 1,000 cups.', 'we sold one thousand cups'), c('I am twenty five.', 'I am 20')],
        joined: [X.sayTokens('twenty-five'), X.sayTokens('one hundred and five'), X.sayTokens('nineteen ninety'), X.sayTokens('ninety nine'), X.sayTokens('a hundred')],
        verdicts: [['see', 'she', 'Sea'], ['right', 'light', 'Write it down.'], ['think', 'sink', 'I think so'], ['light', 'right', 'right'], ['ship', 'sip', 'chip'], ['three', 'free', '3'], ['light', 'right', 'write'], ['fill', 'feel', 'Phil']].map(a => X.pronVerdict(...a)),
        lessons: X.PRON.map(p => [p.pairs.length, new Set(p.pairs.flat()).size, p.sents.length]),
        // Words a speech voice may say two ways never appear, and every other spelling belongs to a word in a pair.
        twoWay: X.PRON.flatMap(p => p.pairs.flat()).filter(w => ['live', 'read', 'lead', 'close', 'wind', 'tear', 'bow', 'row', 'use', 'minute', 'wound', 'does'].includes(w)),
        altsKnown: Object.keys(X.PRON_ALTS).every(w => X.PRON.some(p => p.pairs.flat().includes(w))),
        stats: (() => { localStorage.setItem('kaikou:pron', '{"th":{"said":"01x1","quiz":[7,6],"t":"bad"},"zz":{"said":"1"},"v":5}'); const s = X.pronStats(); localStorage.removeItem('kaikou:pron'); return s; })(),
      };
    });
    check('唸一次的比對：不分大小寫、標點，縮寫和數字寫法不同也算對', () => {
      eq(pure.tokens, ['i', 'am', 'sure', 'it', 'is', '2', 'oclock', 'can', 'not', 'wait', 'let', 'us', 'go']);
      eq(pure.same, [7, 7, []]);
      eq(pure.miss, [5, 7, ['a', 'bit']]);
      eq(pure.nums, [4, 4, []]);
    });
    check('唸一次的比對：用字唸的數字（twenty-five、two hundred and fifty、a hundred、年份）和辨識寫的數字算一樣，okay = ok，算的是句子裡的字數', () => {
      eq(pure.more, [[2, 2, []], [7, 7, []], [6, 6, []], [4, 4, []], [4, 4, []], [4, 4, []], [2, 4, ['twenty', 'five.']]]);
      eq(pure.joined, [['25'], ['105'], ['19', '90'], ['99'], ['100']]);
    });
    // 自動選擇 picks a voice on this device first (an online voice sends the text to Microsoft's or Google's service);
    // 設定 marks the online ones.
    const voices = await T(() => {
      const X = window.__kaikouTest, keep = X.TTS.voices;
      const v = (name, uri, local, dflt) => ({ name, lang: 'en-US', voiceURI: uri, localService: local, default: !!dflt });
      const pickOf = list => { X.TTS.voices = list; return (X.TTS.pick() || {}).voiceURI; };
      const picks = [
        pickOf([v('Google US English', 'g', false, true), v('Microsoft Aria Online (Natural) - English (United States)', 'a', false), v('Samantha', 's', true)]),
        pickOf([v('Google US English', 'g', false), v('Microsoft Aria Online (Natural) - English (United States)', 'a', false)]),
        pickOf([v('Microsoft Zira - English (United States)', 'z', true, true), v('Microsoft David - English (United States)', 'd', true), v('Google US English', 'g', false)]),
        // 英式英文 chosen, but only American voices on this device: one of those, not the online British one.
        (() => { const acc = X.S.settings.accent; X.S.settings.accent = 'en-GB'; const r = pickOf([v('Microsoft Zira - English (United States)', 'z', true, true), Object.assign(v('Google UK English Female', 'gb', false), { lang: 'en-GB' })]); X.S.settings.accent = acc; return r; })(),
      ];
      X.TTS.voices = [v('Samantha', 's', true), v('Google US English', 'g', false)];
      document.querySelector('#btn-settings').click();
      const opts = [...document.querySelectorAll('#set-voice option')].map(o => o.textContent);
      document.querySelector('#set-done').click();
      X.TTS.voices = keep;
      return { picks, opts };
    });
    check('朗讀聲音：自動選擇時先用這台裝置上的聲音（沒有選的口音也一樣），沒有才用線上的；設定裡標出哪些是線上的聲音', () => {
      eq(voices.picks, ['s', 'a', 'z', 'z']);
      eq(voices.opts, ['自動選擇', 'Samantha（en-US）', 'Google US English（en-US，線上）']);
    });
    check('發音字對：同音的拼法也算對，聽成另一個字或聽不出來分開判斷；8 組都是 6 對不重複的字和 3 句；壞掉的紀錄不會出錯', () => {
      eq(pure.verdicts, ['ok', 'ok', 'ok', 'other', 'unclear', 'ok', 'other', 'ok']);
      eq(pure.lessons, Array(8).fill([6, 12, 3]));
      eq([pure.twoWay, pure.altsKnown], [[], true]);
      eq(pure.stats, { th: { said: '011', quiz: null, t: '' } });
    });

    await page.click('#start-btn');
    await notBusy(page);
    await T(() => window.__srScript.push({ text: 'I go to park yesterday' }));
    await page.click('#mic-btn');
    await until(page, () => document.querySelector('#msg-input').value === 'I go to park yesterday' && !window.__kaikouTest.Mic.cur);
    const lang1 = await T(() => window.__srStarts.map(s => s.lang));
    await page.click('#send-btn');
    await notBusy(page);
    await T(() => window.__srScript.push({ text: 'I went to park yesterday' }));
    await page.click('[data-say-btn^="fx"]');
    await until(page, () => !!document.querySelector('.say .say-words'));
    const say = await T(() => ({ head: document.querySelector('.say .say-head b').textContent, miss: [...document.querySelectorAll('.say .miss')].map(n => n.textContent), heard: document.querySelector('.say .say-heard').textContent, lang: document.querySelector('.say').getAttribute('lang') }));
    await shot(page, '14-mic-desk.png');
    // A 唸一次 that hears nothing tells a screen reader too.
    await T(() => window.__srScript.push({ error: 'no-speech' }));
    await page.click('[data-say-btn^="fx"]');
    await until(page, () => /沒有聽到聲音/.test(document.querySelector('#sr-live').textContent), null, 4000);
    // The coach's reply arrives during a 唸一次: it is not read aloud over the check, which goes on to its result.
    slowReply = 1500;
    await page.fill('#msg-input', 'We had a picnic by the lake');
    await page.click('#send-btn');
    await T(() => { window.__speechLog = []; window.__srScript.push({ text: 'I went to the park yesterday', wait: 300, hold: 2600 }); });
    await page.click('[data-say-btn^="fx"]');
    await until(page, () => !window.__kaikouTest.S.busy, null, 8000);
    const midCheck = await T(() => !!window.__kaikouTest.Mic.cur);
    await until(page, () => !window.__kaikouTest.Mic.cur, null, 8000);
    const overCheck = await T(() => ({ log: window.__speechLog.slice(), states: Object.values(window.__kaikouTest.S.say).map(s => s.state) }));
    check('網頁版麥克風：唸一次沒聽到聲音也會告訴螢幕閱讀器；唸一次的時候教練的回覆到了，不會自動唸出來蓋過去', () => {
      eq(midCheck, true);
      eq(overCheck.log, ['listen', 'heard:I went to the park yesterday', 'stop-listen']);
      eq(overCheck.states.includes('done'), true);
    });
    await T(() => window.__srScript.push({ error: 'network' }));
    await page.click('#mic-btn');
    await until(page, () => !document.querySelector('#mic-msg').hidden);
    const net = await page.textContent('#mic-msg');
    const netOff = await T(() => ({ blocked: window.__kaikouTest.Mic.blocked, hidden: document.querySelector('#mic-btn').hidden, kept: localStorage.getItem('kaikou:mic-off') }));
    await page.click('#btn-settings');
    const setMsg = await page.textContent('#set-mic-state');
    await page.click('#set-mic-on');
    await page.click('#set-done');
    const netBack = await T(() => ({ blocked: window.__kaikouTest.Mic.blocked, hidden: document.querySelector('#mic-btn').hidden }));
    check('網頁版麥克風：按一下說英文，文字進輸入框，送出後教練照常回覆；唸一次標出沒聽出來的字', () => {
      eq(lang1, ['en-US']);
      assert.ok(sent.includes('I go to park yesterday'), sent.join(' | '));
      eq(say, { head: '聽出 5 / 6 個字', miss: ['the'], heard: '你唸的：I went to park yesterday', lang: 'zh-Hant-TW' });
      assert.ok(/Google/.test(net) && /Win \+ H/.test(net), net);
    });
    check('連不上語音辨識服務：這次先關掉麥克風（不記住），設定裡可以重新啟用', () => {
      eq(netOff, { blocked: true, hidden: true, kept: null });
      assert.ok(setMsg.includes('連不上語音辨識服務'), setMsg);
      eq(netBack, { blocked: false, hidden: false });
    });

    // 中翻英: dictation starts in Chinese, switches to English after the coach offers ways to say it.
    await page.click('[data-fk="discard"]');
    await page.click('[data-fk="discard"]');
    await page.click('[data-fk="mode-zh"]');
    await page.click('#start-btn');
    await until(page, () => !!window.__kaikouTest.S.chat && window.__kaikouTest.S.chat.mode === 'zh');
    const zh0 = await page.textContent('#mic-lang');
    await T(() => window.__srScript.push({ text: '這個功能下週上線' }));
    await page.click('#mic-btn');
    await until(page, () => document.querySelector('#msg-input').value === '這個功能下週上線' && !window.__kaikouTest.Mic.cur);
    await page.click('#send-btn');
    await notBusy(page);
    const zh1 = await page.textContent('#mic-lang');
    await page.click('#mic-lang');
    const zh2 = await page.textContent('#mic-lang');
    const langs = await T(() => window.__srStarts.map(s => s.lang));
    check('中翻英：先用中文說，教練給說法之後自動改成英文，也可以手動切換', () => {
      eq([zh0, zh1, zh2], ['中', 'EN', '中']);
      eq(langs.slice(-1), ['zh-TW']);
    });

    // The shadowing player stops before the microphone listens, so it never talks into it.
    await page.click('#t-today');
    await page.click('[data-fk="go-shadow"]');
    await page.fill('#sh-own', 'I wake up early. I make some coffee. Then I read the news. After that I go to work.');
    await page.click('[data-fk="sh-own-go"]');
    await until(page, () => document.querySelectorAll('.sent').length === 4);
    await T(() => { window.__spoken = []; window.__srScript.push({ text: 'I make some coffee', hold: 2500 }); });
    await page.click('[data-fk="sh-play"]');
    await until(page, () => window.__spoken.length >= 1);
    await page.click('[data-say-btn^="sh1"]');
    const atMic = await T(() => window.__spoken.length);
    await until(page, () => !!document.querySelector('.sent .say .say-words'), null, 8000);
    const shmic = await T(() => ({ playing: window.__kaikouTest.S.sh.playing, spoken: window.__spoken.length, head: document.querySelector('.sent .say .say-head b').textContent }));
    check('跟讀時按「唸一次」：播放先停下來，不會對著麥克風繼續唸', () => {
      eq(shmic.playing, false);
      eq(shmic.spoken, atMic);
      eq(shmic.head, '每個字都聽出來了！');
    });
    // A voice that sends no events: continuous play still goes on sentence by sentence at the usual pace.
    const flowLeft = await T(() => { const i = window.__kaikouTest.S.sh.idx; return 4 - (i >= 0 ? i : 0); });
    await T(() => { window.__ttsDrop = true; window.__spoken = []; });
    await page.click('[data-fk="shm-flow"]');
    const flow0 = Date.now();
    await page.click('[data-fk="sh-play"]');
    await until(page, n => window.__spoken.length === n && !window.__kaikouTest.S.sh.playing, flowLeft, 25000);
    const flowMs = Date.now() - flow0;
    await T(() => { window.__ttsDrop = false; });
    check('跟讀：朗讀聲音收不到結束通知時，連續播放照樣一句接一句，不會每句等好幾秒', () => assert.ok(flowLeft >= 2 && flowMs < 1500 * flowLeft, flowLeft + ' sentences took ' + flowMs + ' ms'));
    await page.click('[data-fk="tool-back"]');

    // Pronunciation pairs with the microphone: the result says which word of the pair the browser heard.
    await page.click('#t-saved');
    await page.click('[data-fk="pron-th"]');
    const sayWord = async (w, heard, lesson) => {
      const k = await T(([x, l]) => 'pw' + l + ':' + window.__kaikouTest.phraseId(x), [w, lesson || 'th']);
      await T(h => window.__srScript.push({ text: h }), heard);
      await page.click('[data-say-btn="' + k + '"]');
      await until(page, x => { const b = document.querySelector('[data-say="' + x + '"]'); return !!b && !b.hidden && !!b.querySelector('.say-head b') && !window.__kaikouTest.Mic.cur; }, k);
      return T(x => { const b = document.querySelector('[data-say="' + x + '"]'); return [b.querySelector('.say-head b').textContent, (b.querySelector('.help') || b.querySelector('.say-heard')).textContent]; }, k);
    };
    const words = [];
    words.push(await sayWord('think', 'sink'));
    words.push(await sayWord('think', 'think'));
    words.push(await sayWord('sink', 'sync'));
    words.push(await sayWord('three', '3'));
    words.push(await sayWord('mouth', 'mouse'));
    words.push(await sayWord('they', 'hey there'));
    await shot(page, '15-pron-mic-desk.png', true);
    const said = await T(() => JSON.parse(localStorage.getItem('kaikou:pron')).th.said);
    // On phones every word with its two buttons gets a whole row, and no word breaks inside.
    const fits = [];
    for (const w of [360, 390]) {
      await page.setViewportSize({ width: w, height: 800 });
      await page.click('[data-fk="pron-back"]');
      await page.click('[data-fk="pron-rl"]');
      // A long result inside a word's box wraps instead of pushing the page sideways.
      await sayWord('glass', 'I am not sure what you said there at all', 'rl');
      fits.push(await T(() => ({
        cols: getComputedStyle(document.querySelector('#pron .pair')).gridTemplateColumns.split(' ').length,
        broken: [...document.querySelectorAll('#pron .word>b')].filter(b => b.getClientRects().length !== 1 || b.scrollWidth > b.clientWidth + 1).map(b => b.textContent),
        wide: document.documentElement.scrollWidth > window.innerWidth,
      })));
      if (w === 360) await shot(page, '17-pron-mic-phone.png');
    }
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.click('[data-fk="pron-back"]');
    await page.click('[data-fk="pron-th"]');
    const reopened = await T(() => [...document.querySelectorAll('#pron .say')].filter(b => !b.hidden).length);
    const descr = await T(() => { const b = document.querySelector('#pron .word [data-say-btn]'); return document.getElementById(b.getAttribute('aria-describedby')).textContent; });
    await page.click('[data-fk="pron-back"]');
    const stat = await page.textContent('[data-fk="pron-th"] span');
    check('發音練習（網頁版）：唸一個字，說出電腦聽到的是這個字、另一個字，還是聽不出來；只有聽得出來的才記進成績', () => {
      eq(words[0], ['聽起來像「sink」', '先按喇叭聽「think」，照上面的方法再唸一次。']);
      eq(words[1], ['唸對了！', '電腦聽到：think']);
      eq([words[2][0], words[3][0]], ['唸對了！', '唸對了！']);
      eq(words[4][0], '聽起來像「mouse」');
      eq(words[5], ['聽到「hey there」', '不確定是哪一個字。一次只唸一個字、聲音大一點，再唸一次「they」。']);
      eq(said, '01110');
      eq(stat, '今天練過・唸對 3 / 5');
    });
    check('發音練習（網頁版）：手機上一個字一行、字不會被切開；回到收藏再打開時結果已清掉；按鈕說明是哪一個字', () => {
      eq(fits, [{ cols: 1, broken: [], wide: false }, { cols: 1, broken: [], wide: false }]);
      eq([reopened, descr], [0, 'think']);
    });
    await page.click('#t-coach');

    // A browser that refuses the microphone: the buttons go away and the system dictation tip comes back.
    await T(() => window.__srScript.push({ error: 'not-allowed' }));
    await page.focus('#mic-btn');
    await page.keyboard.press('Enter');
    await until(page, () => window.__kaikouTest.Mic.blocked && document.querySelector('#mic-btn').hidden);
    const off = await T(() => ({ say: document.querySelectorAll('#tab-coach [data-say-btn]').length, tip: document.querySelector('#composer-tip-text').textContent, msg: document.querySelector('#mic-msg').textContent, focus: document.activeElement && document.activeElement.id }));
    const keptOff = await T(() => JSON.parse(localStorage.getItem('kaikou:mic-off') || 'null'));
    await reloadAfterWrites(page);
    const after = await T(() => ({ blocked: window.__kaikouTest.Mic.blocked, hidden: document.querySelector('#mic-btn').hidden }));
    await page.click('#t-saved'); // no 唸一次 buttons on the other tabs either
    off.saved = await T(() => document.querySelectorAll('#tab-saved [data-say-btn]').length);
    await page.click('#btn-settings');
    await page.click('#set-mic-on');
    await page.click('#set-done');
    const on = await T(() => ({ blocked: window.__kaikouTest.Mic.blocked, hidden: document.querySelector('#mic-btn').hidden, kept: localStorage.getItem('kaikou:mic-off') }));
    check('瀏覽器不允許麥克風：說明怎麼開啟，麥克風按鈕收起來（鍵盤焦點移到輸入框），改回系統聽寫的提示；下次打開仍記得，設定裡可以重新啟用', () => {
      eq([off.say, off.saved, off.focus], [0, 0, 'msg-input']);
      assert.ok(/Win \+ H/.test(off.tip), off.tip);
      assert.ok(/允許麥克風/.test(off.msg), off.msg);
      eq(keptOff && keptOff.why, 'not-allowed');
      eq(after, { blocked: true, hidden: true });
      eq(on, { blocked: false, hidden: false, kept: null });
    });

    // A 唸一次 result on a review card belongs to that round: the next round starts without it.
    await page.click('#t-saved');
    await page.click('#starters .icon-btn[aria-pressed="false"][aria-label="收藏"]');
    await page.click('[data-fk="drill-start"]');
    await page.click('[data-fk="flip"]');
    const drEn = await T(() => { const X = window.__kaikouTest, d = X.S.drill; return X.S.phrases.find(p => p.id === d.q[d.i]).en; });
    await T(t => window.__srScript.push({ text: t }), drEn);
    await page.click('#drill [data-say-btn^="dr:"]');
    await until(page, () => !!document.querySelector('#drill .say .say-words') && !window.__kaikouTest.Mic.cur);
    await page.click('[data-fk="drill-end"]'); // nothing rated yet
    const drEnd = await T(() => document.activeElement === document.querySelector('#drill .card-title'));
    await page.click('[data-fk="drill-start"]');
    await page.click('[data-fk="flip"]');
    const drNext = await T(() => ({ shown: [...document.querySelectorAll('#drill .say')].filter(b => !b.hidden).length, kept: Object.keys(window.__kaikouTest.S.say).filter(k => k.startsWith('dr:')).length }));
    await page.click('[data-fk="drill-end"]');
    check('句子複習：上一輪「唸一次」的結果不會出現在下一輪的卡片上；還沒評分就結束時，焦點到複習的標題', () => eq([drNext, drEnd], [{ shown: 0, kept: 0 }, true]));

    // 4/3/2 with recording: a microphone that goes away during a round does not hang its end, and what was recorded
    // is kept; when the browser answers the microphone request of the next round after the learner went to another
    // tab, that round waits, paused, instead of running unseen.
    await page.click('#t-today');
    await page.click('[data-fk="go-f432"]');
    await page.click('[data-fk="f432-go"]');
    await until(page, () => window.__kaikouTest.S.f432.state === 'run' && !!window.__kaikouTest.Rec.mr && window.__kaikouTest.Rec.mr.state === 'recording', null, 8000);
    await page.waitForTimeout(1200);
    await T(() => { const mr = window.__kaikouTest.Rec.mr; mr.stream.getTracks().forEach(t => t.stop()); try { if (mr.state !== 'inactive') mr.stop(); } catch (_) { /* stopped already */ } });
    await until(page, () => !window.__kaikouTest.Rec.mr || window.__kaikouTest.Rec.mr.state === 'inactive');
    const recT0 = Date.now();
    await page.click('[data-fk="f432-end"]');
    await until(page, () => window.__kaikouTest.S.f432.state === 'gap', null, 8000);
    const recEnd = { ms: Date.now() - recT0, kept: await T(() => !!window.__kaikouTest.S.f432.recs[0]) };
    await T(() => { const md = navigator.mediaDevices, real = md.getUserMedia.bind(md); window.__realGUM = real; md.getUserMedia = c => new Promise(r => setTimeout(r, 1500)).then(() => real(c)); });
    await page.click('[data-fk="f432-next"]');
    await page.click('#t-coach');
    await until(page, () => { const F = window.__kaikouTest.S.f432; return F.state === 'pause' && !F.starting; }, null, 8000);
    const recAway = await T(() => ({ left: window.__kaikouTest.S.f432.left, rec: window.__kaikouTest.Rec.mr && window.__kaikouTest.Rec.mr.state, phase: window.__kaikouTest.S.f432.phase }));
    await page.click('#t-today');
    const recBack = await T(() => ({ resume: !!document.querySelector('[data-fk="f432-resume"]'), clock: document.querySelector('#f432-clock').textContent }));
    await T(() => { navigator.mediaDevices.getUserMedia = window.__realGUM; });
    check('4/3/2 錄音：麥克風中途斷了，按「這次講完了」也不會卡住，錄到的留著；問麥克風時切到別的分頁，這一次會先暫停，不會在背景計時', () => {
      assert.ok(recEnd.ms < 2500, 'the round ended ' + recEnd.ms + ' ms after the tap');
      eq(recEnd.kept, true);
      eq(recAway, { left: 180, rec: 'paused', phase: 1 });
      eq(recBack, { resume: true, clock: '3:00' });
    });
    await ctx.close();
  }

  // ---------- 6b. GitHub Pages: voice conversation (the coach speaks, the microphone listens, it sends by itself) ----------
  if (want('6b')) {
    const KEY = 'sk-ant-api03-' + 'TESTONLY'.repeat(6) + '-AA';
    const { ctx, page } = await open(base + '#coach', { viewport: { width: 400, height: 860 }, deviceScaleFactor: 2, serviceWorkers: 'block' }, 'voice', null, speech);
    await giveKey(page, KEY);
    const sent = [];
    const LONG = 'Great, I love hearing about your plans because a good weekend makes the whole week feel lighter and happier for everyone around you';
    const MORE = ['What was the film about?', 'Did your sister like it?'];
    let slowNext = false;
    await page.route('https://api.anthropic.com/v1/messages', async route => {
      const msgs = (JSON.parse(route.request().postData() || '{}').messages) || [];
      const last = String((msgs[msgs.length - 1] || {}).content || '');
      if (/^An English learner/.test(last)) return sseReply(route, '[{"en": "Sounds great to me", "zh": "聽起來很棒"}, {"en": "I had a lovely time", "zh": "我玩得很開心"}]');
      if (msgs.length > 1) sent.push(last);
      if (slowNext) { slowNext = false; await new Promise(r => setTimeout(r, 2500)); }
      if (/I go to park yesterday$/.test(last)) return sseReply(route, 'Nice! Which park did you go to?\n###\n{"you": "I go to park yesterday", "better": "I went to the park yesterday", "why": "過去式"}');
      if (/by the river$/.test(last)) return sseReply(route, 'That sounds lovely. What did you eat?\n###\n{"none": true}');
      if (/^Sounds great to me.*$/.test(last)) return sseReply(route, LONG + '.\n###\n{"none": true}');
      if (/^I went to the cinema with my sister$/.test(last)) return sseReply(route, LONG + '. ' + MORE.join(' ') + '\n###\n{"none": true}');
      if (msgs.length > 1) return sseReply(route, 'Great! Tell me more.\n###\n{"none": true}');
      return sseReply(route, 'Hi! What did you do last weekend?\n###\n{"none": true}');
    });
    const T = (fn, a) => page.evaluate(fn, a);
    const VOICE_WAIT = 3200; // longer than the countdown before a send
    const phase = (p, ms) => until(page, x => window.__kaikouTest.Voice.phase === x, p, ms || 10000);
    const bar = () => T(() => ({ on: window.__kaikouTest.Voice.on, phase: window.__kaikouTest.Voice.phase, text: document.querySelector('#voice-bar').textContent, hidden: document.querySelector('#voice-bar').hidden }));
    const input = () => T(() => document.querySelector('#msg-input').value);
    const script = (...steps) => T(x => window.__srScript.push(...x), steps);
    const turns = n => until(page, x => window.__kaikouTest.S.chat.turns.filter(t => t.r === 'm').length === x && !window.__kaikouTest.S.busy, n, 10000);
    const micBtn = () => T(() => { const b = document.querySelector('#mic-btn'); return { label: b.getAttribute('aria-label'), rec: b.classList.contains('rec'), disabled: b.disabled }; });
    const starts = () => T(() => window.__srStarts.length);
    // Everything said to a screen reader (the live region), to check the coach's spoken replies are not read twice.
    await T(() => { const n = document.querySelector('#sr-live'); window.__live = []; new MutationObserver(() => { if (n.textContent) window.__live.push(n.textContent); }).observe(n, { childList: true, characterData: true, subtree: true }); });

    // The start menu offers it for free talk and role-play, not for 中翻英.
    const offer = [await T(() => !!document.querySelector('#start-voice'))];
    await page.click('[data-fk="mode-zh"]');
    offer.push(await T(() => !!document.querySelector('#start-voice')));
    await page.click('[data-fk="mode-role"]');
    offer.push(await T(() => !!document.querySelector('#start-voice')));
    await page.click('[data-fk="mode-free"]');

    // The opening is spoken, then the microphone listens; what was heard goes out by itself after a short countdown.
    await script({ text: 'I go to park yesterday' });
    await page.click('#start-voice');
    await phase('countdown');
    const counting = Object.assign(await bar(), { input: await input(), sent: sent.length, mic: await micBtn(), auto: await T(() => document.querySelector('[data-fk="auto"]').hidden) });
    await shot(page, '16-voice-countdown-phone.png');
    // The reply (with its correction) is spoken and the microphone listens again; three silences in a row pause it.
    await until(page, () => /一直沒有聽到聲音/.test(document.querySelector('#voice-bar').textContent), null, 15000);
    await until(page, () => window.__live.some(t => /一直沒有聽到聲音/.test(t)), null, 3000); // also said to a screen reader
    const loop = await T(() => ({ log: window.__speechLog.slice(), fix: window.__kaikouTest.S.chat.turns[1].fx.map(f => f.better), mic: !!window.__kaikouTest.Mic.cur, input: document.querySelector('#msg-input').value, toggle: document.querySelector('[data-fk="voice"]').getAttribute('aria-pressed'), live: window.__live.slice() }));
    check('語音對話：教練開場會唸出來，接著自動聽你說，說完倒數一下自動送出', () => {
      eq(offer, [true, false, true]);
      eq([counting.on, counting.phase, counting.input, counting.sent, counting.auto], [true, 'countdown', 'I go to park yesterday', 0, true]);
      assert.ok(/即將送出/.test(counting.text) && /現在送出/.test(counting.text) && /先不要送/.test(counting.text), counting.text);
      eq(counting.mic.label, '還沒說完，接著聽');
      eq(sent.slice(0, 1), ['I go to park yesterday']);
      eq(loop.fix, ['I went to the park yesterday']);
    });
    check('語音對話：教練一句一句唸（螢幕閱讀器不再重唸一次），唸完才開麥克風；倒數時也在聽；一直沒聽到聲音就停下來等你', () => {
      assert.ok(!loop.live.some(t => /教練：/.test(t)), loop.live.join(' | '));
      // listen → heard → (the countdown listens on, hears nothing) → the reply, sentence by sentence → three silences.
      eq(loop.log, ['say:Hi!', 'said', 'say:What did you do last weekend?', 'said', 'listen', 'heard:I go to park yesterday', 'stop-listen', 'listen', 'stop-listen',
        'say:Nice!', 'said', 'say:Which park did you go to?', 'said', 'listen', 'stop-listen', 'listen', 'stop-listen', 'listen', 'stop-listen']);
      eq([loop.mic, loop.input, loop.toggle], [false, '', 'true']);
    });

    // 暫停 in the middle of a sentence drops the half-heard words, so saying it again does not repeat them.
    await script({ text: 'It was a really lovely day', hold: 3000 });
    await page.click('[data-fk="vb-go"]');
    await until(page, () => document.querySelector('#msg-input').value === 'It was a');
    const midMic = await micBtn();
    await page.click('[data-fk="vb-pause"]');
    const afterPause = await input();
    await script({ text: 'It was a really lovely day' });
    await page.click('[data-fk="vb-go"]');
    await turns(2);
    // Going on talking during the countdown adds to the sentence instead of sending half of it.
    await script({ text: 'We had a picnic' }, { text: 'by the river' }); // heard once the reply has been spoken
    await turns(3);
    check('語音對話：說到一半按暫停，沒確定的字不留，再說一次不會重複；停頓後接著說，會接在後面一起送', () => {
      eq([midMic.label, midMic.rec], ['說完了', true]);
      eq(afterPause, '');
      eq(sent.slice(1, 3), ['It was a really lovely day', 'We had a picnic by the river']);
    });

    // A hint put in the box and then said aloud replaces the hint instead of being added to it.
    await page.click('#hint-btn');
    await until(page, () => document.querySelectorAll('#hints .hint').length === 2);
    const hinted = await bar();
    await page.click('[data-fk="hint-0"]');
    // Said aloud it replaces the hint; going on during the countdown is added to what was said.
    await script({ text: 'Sounds great to me' }, { text: 'and really fun' });
    await page.click('[data-fk="vb-go"]');
    await until(page, () => window.__kaikouTest.Voice.phase === 'countdown' && document.querySelector('#msg-input').value === 'Sounds great to me and really fun');
    const fromHint = await input();
    await page.click('[data-fk="vb-send"]');
    // Typing while the coach speaks: the coach finishes the sentence, then the loop waits (no microphone).
    await phase('speaking');
    await page.type('#msg-input', 'Hi');
    const typedSpeaking = Object.assign(await bar(), { starts: await starts() });
    await phase('paused');
    await page.waitForTimeout(600);
    const typedAfter = Object.assign(await bar(), { starts: await starts(), log: await T(() => window.__speechLog.slice(-2)) });
    check('語音對話：看提示時暫停，把提示唸出來會取代提示、不會重複；教練說話時打字，教練說完就停下來等，不會自己開麥克風', () => {
      eq([hinted.phase, /看完提示/.test(hinted.text)], ['paused', true]);
      eq([fromHint, sent[3]], ['Sounds great to me and really fun', 'Sounds great to me and really fun']);
      eq([typedSpeaking.phase, typedAfter.phase, /你在打字/.test(typedAfter.text), typedAfter.starts, typedAfter.log], ['speaking', 'paused', true, typedSpeaking.starts, ['say:' + LONG + '.', 'said']]);
    });

    // Tapping into the text during the countdown stops the send (to fix a word).
    await page.fill('#msg-input', '');
    await script({ text: 'We ate sandwiches' });
    await page.click('[data-fk="vb-go"]');
    await phase('countdown');
    await page.click('#msg-input');
    const tapped = Object.assign(await bar(), { input: await input() });
    await page.waitForTimeout(VOICE_WAIT);
    const tappedSent = sent.length;
    // The microphone button during the countdown means "not finished yet": no send, it listens again and adds.
    await page.fill('#msg-input', '');
    await script({ text: 'I went to the' });
    await page.click('[data-fk="vb-go"]');
    await phase('countdown');
    await script({ text: 'cinema with my sister' });
    await page.click('#mic-btn');
    await until(page, () => window.__kaikouTest.Voice.phase === 'countdown' && document.querySelector('#msg-input').value === 'I went to the cinema with my sister');
    await turns(5);
    check('語音對話：倒數時點輸入框就先不送；按麥克風表示還沒說完，接著聽並接在後面', () => {
      eq([tapped.phase, tapped.input, /先不送了/.test(tapped.text), tappedSent], ['paused', 'We ate sandwiches', true, 4]);
      eq(sent[4], 'I went to the cinema with my sister');
    });

    // 換我說 cuts the coach short and listens, and the rest of the reply is never spoken, even with a voice that
    // reports nothing when it is cut off; 說完了 keeps what was heard so far and counts down.
    await script({ text: 'It was a lot of fun', hold: 3000 });
    await phase('speaking');
    await T(() => { window.__ttsDrop = true; });
    await page.click('[data-fk="vb-skip"]');
    await until(page, () => document.querySelector('#msg-input').value === 'It was a');
    await page.waitForTimeout(700);
    await T(() => { window.__ttsDrop = false; });
    const skipLog = await T(x => window.__speechLog.slice(window.__speechLog.lastIndexOf('say:' + x)), LONG + '.');
    await page.click('[data-fk="vb-done"]');
    await phase('countdown');
    const done = await input();
    // Tapping the coach tab again or a focus that comes back to the text does not stop anything; tapping into the
    // text pauses and keeps the words shown, even those not confirmed yet; opening 設定 pauses and drops them.
    await page.click('[data-fk="vb-hold"]');
    await script({ text: 'and very relaxing', hold: 3000 });
    await page.click('[data-fk="vb-go"]');
    await until(page, () => window.__kaikouTest.Voice.phase === 'listening' && document.querySelector('#msg-input').value === 'It was a and very');
    await page.click('#t-coach');
    await page.focus('#msg-input');
    const sameTab = Object.assign(await bar(), { mic: await T(() => !!window.__kaikouTest.Mic.cur) });
    await page.click('#msg-input');
    const tapKeep = Object.assign(await bar(), { input: await input() });
    await script({ text: 'more words here', hold: 3000 });
    await page.click('[data-fk="vb-go"]');
    await until(page, () => document.querySelector('#msg-input').value === 'It was a and very more words');
    await page.click('#btn-settings');
    const inSettings = Object.assign(await bar(), { mic: await T(() => !!window.__kaikouTest.Mic.cur), input: await input() });
    await page.click('#set-done');
    check('語音對話：換我說會打斷教練開始聽，教練不會接著說下一句；說完了留下聽到的字並倒數；再按一次教練分頁或焦點回到輸入框不會中斷；點輸入框暫停並留下顯示的字；打開設定會暫停', () => {
      eq(skipLog, ['say:' + LONG + '.', 'cut', 'listen']);
      eq(done, 'It was a');
      eq([sameTab.phase, sameTab.mic], ['listening', true]);
      eq([tapKeep.phase, tapKeep.input, /先不送了/.test(tapKeep.text)], ['paused', 'It was a and very', true]);
      eq([inSettings.phase, inSettings.mic, inSettings.input], ['paused', false, 'It was a and very']);
    });

    // A tap on the microphone button that starts during the countdown means "not finished", even if the learner
    // starts talking again (and the button turns into 說完了) before the finger is lifted.
    await page.fill('#msg-input', '');
    await script({ text: 'We went home' }, { text: 'after the film', wait: 800, hold: 1500 });
    await page.click('[data-fk="vb-go"]');
    await phase('countdown');
    await page.dispatchEvent('#mic-btn', 'pointerdown');
    await phase('listening');
    await page.dispatchEvent('#mic-btn', 'click');
    const lateTap = { mic: await T(() => !!window.__kaikouTest.Mic.cur), phase: (await bar()).phase };
    await until(page, () => window.__kaikouTest.Voice.phase === 'countdown' && document.querySelector('#msg-input').value === 'We went home after the film');
    await page.click('[data-fk="vb-hold"]');
    check('語音對話：倒數時按下麥克風鍵、放開前又開始說話，仍然當作「還沒說完」，不會把話切斷', () => eq(lateTap, { mic: true, phase: 'listening' }));

    // While the coach is still answering, 繼續說 rejoins the loop: the reply is spoken and the microphone opens.
    await page.fill('#msg-input', 'It was a lot of fun');
    slowNext = true;
    // The keyboard focus is on the microphone button when the loop starts to wait: it stays there (the button only
    // says it cannot be used now), and pressing it does nothing.
    await page.focus('#mic-btn');
    await T(() => document.querySelector('#send-btn').click());
    await phase('waiting');
    const startsWaiting = await starts();
    await page.keyboard.press('Enter');
    const waitMic = await T(() => { const b = document.querySelector('#mic-btn'); return { focus: document.activeElement === b, aria: b.getAttribute('aria-disabled'), disabled: b.disabled, phase: window.__kaikouTest.Voice.phase }; });
    waitMic.starts = (await starts()) - startsWaiting;
    await page.click('#btn-settings');
    await page.click('#set-done');
    const waitPaused = await bar();
    await page.click('[data-fk="vb-go"]');
    const rejoined = await bar();
    await T(() => { window.__ttsDrop = true; }); // and the voice drops its events: the loop must not stall
    await until(page, () => !window.__kaikouTest.S.busy && window.__kaikouTest.Voice.phase === 'speaking', null, 8000);
    const t0 = Date.now();
    await until(page, () => window.__kaikouTest.Voice.phase === 'listening', null, 8000);
    const stalled = Date.now() - t0;
    await T(() => { window.__ttsDrop = false; });
    check('語音對話：等教練回覆時麥克風鍵保留鍵盤焦點但不動作；教練還在回覆時按繼續說，回覆唸完照樣開麥克風；朗讀收不到結束通知也不會卡住', () => {
      eq(waitMic, { focus: true, aria: 'true', disabled: false, phase: 'waiting', starts: 0 });
      eq([waitPaused.phase, rejoined.phase], ['paused', 'waiting']);
      assert.ok(stalled < 3500, 'the microphone opened ' + stalled + ' ms after the reply started to be spoken'); // ~1 s; waiting for the fallback timers alone takes 5 s or more
    });

    // A speaker button pressed while the coach is still answering takes over: the loop pauses, and the reply then
    // waits instead of cutting the playback off; 繼續說 says it first and listens after it.
    await phase('paused', 12000);
    slowNext = true;
    await page.fill('#msg-input', 'We went for a walk');
    await page.click('#send-btn');
    await phase('waiting');
    const spkFrom = await T(() => window.__speechLog.length);
    await page.click('#msgs [data-fk^="spk:"]');
    const spkPhase = (await bar()).phase;
    await until(page, () => !window.__kaikouTest.S.busy, null, 8000);
    await page.waitForTimeout(600);
    const spk = { phase: spkPhase, after: (await bar()).phase, log: await T(n => window.__speechLog.slice(n), spkFrom) };
    await script({ text: 'It was nice', wait: 1500, hold: 3000 });
    await T(() => { window.__kaikouTest.Voice.miss = 2; }); // as after two silences: 繼續說 starts counting afresh
    await page.click('[data-fk="vb-go"]');
    await phase('listening');
    const owed = await T(n => window.__speechLog.slice(n), spkFrom);
    const missAfter = await T(() => window.__kaikouTest.Voice.miss);
    await page.click('[data-fk="vb-pause"]');
    // A reply that came while paused and was then played with 朗讀 is not said again on 繼續說.
    slowNext = true;
    await page.fill('#msg-input', 'We saw some ducks');
    await page.click('#send-btn');
    await phase('waiting');
    await page.click('#msgs [data-fk^="spk:"]');
    await until(page, () => !window.__kaikouTest.S.busy, null, 8000);
    await page.waitForTimeout(400);
    await T(() => { const b = document.querySelectorAll('#msgs .msg.c [data-fk^="spk:"]'); b[b.length - 1].click(); });
    await until(page, () => window.__speechLog[window.__speechLog.length - 1] === 'said', null, 4000);
    const heardFrom = await T(() => window.__speechLog.length);
    await script({ text: 'It was nice', wait: 1500, hold: 3000 });
    await page.click('[data-fk="vb-go"]');
    await phase('listening');
    const notAgain = await T(n => window.__speechLog.slice(n), heardFrom);
    await page.click('[data-fk="vb-pause"]');
    // A double click on 繼續說 (in the bar, or on the microphone button that says it) does not undo itself: its second
    // click lands on 暫停 / 說完了, which take its place.
    await script({ text: 'It was nice', wait: 1500, hold: 3000 });
    await page.dblclick('[data-fk="vb-go"]');
    const dbl = await bar();
    await page.click('[data-fk="vb-pause"]');
    await script({ text: 'It was nice', wait: 1500, hold: 3000 });
    await page.setViewportSize({ width: 1000, height: 800 }); // (on this phone width the button moves after the first click)
    const micFrom = await T(() => [window.__srStarts.length, window.__speechLog.length]);
    await page.dblclick('#mic-btn');
    await page.waitForTimeout(400); // a second click would have stopped the microphone by now
    // (the listening stopped by 暫停 may still log its end just after the snapshot: the log is read from the new start)
    const dblMic = Object.assign(await bar(), { mic: await micBtn(), heard: await T(([n, l]) => { const g = window.__speechLog.slice(l); return [window.__srStarts.length - n, g.slice(g.indexOf('listen'))]; }, micFrom) });
    if (await page.$('[data-fk="vb-pause"]')) await page.click('[data-fk="vb-pause"]');
    await page.setViewportSize({ width: 400, height: 860 });
    check('語音對話：等回覆時按喇叭會先暫停，回覆到了也不會打斷正在唸的，按繼續說時先唸這個回覆再聽你說；連按兩下繼續說（語音條或麥克風鍵）不會又馬上暫停', () => {
      eq([spk.phase, spk.after], ['paused', 'paused']);
      assert.ok(spk.log.length === 2 && /^say:/.test(spk.log[0]) && spk.log[1] === 'said', spk.log.join(' | '));
      eq(owed.slice(2), ['say:Great!', 'said', 'say:Tell me more.', 'said', 'listen']);
      eq([missAfter, notAgain], [0, ['listen']]);
      eq([dbl.phase, dblMic.phase, dblMic.mic.label, dblMic.heard], ['listening', 'listening', '說完了', [1, ['listen']]]);
    });

    // The × ends voice conversation and gives the focus to its switch; 自動朗讀 comes back.
    await phase('paused', 12000);
    await page.click('[data-fk="vb-end"]');
    const ended = Object.assign(await bar(), { toggle: await T(() => document.querySelector('[data-fk="voice"]').getAttribute('aria-pressed')), focus: await T(() => document.activeElement && document.activeElement.dataset.fk), auto: await T(() => document.querySelector('[data-fk="auto"]').hidden), mic: await micBtn() });
    check('語音對話：按 × 結束，焦點回到語音對話按鈕，自動朗讀按鈕回來', () => {
      eq([ended.on, ended.hidden, ended.toggle, ended.focus, ended.auto], [false, true, 'false', 'voice', false]);
      eq(ended.mic.label, '用說的（英文）');
    });

    // A recognition service that cannot be reached turns it off (the focus goes to the text box, to type instead).
    await page.fill('#msg-input', '');
    await script({ text: 'Nothing much' });
    await page.click('[data-fk="voice"]');
    await phase('countdown');
    await page.click('[data-fk="vb-hold"]');
    await page.fill('#msg-input', '');
    await script({ error: 'network' });
    await page.focus('[data-fk="vb-go"]');
    await page.keyboard.press('Enter');
    await until(page, () => !window.__kaikouTest.Voice.on, null, 6000);
    const net = await T(() => ({ msg: document.querySelector('#mic-msg').textContent, toggle: !!document.querySelector('[data-fk="voice"]'), bar: document.querySelector('#voice-bar').hidden, focus: document.activeElement && document.activeElement.id }));
    await page.click('#btn-settings');
    await page.click('#set-mic-on');
    await page.click('#set-done');
    // An automatic start the browser refuses (some want a tap first) only pauses; a refusal after a tap turns the microphone off.
    await script({ text: 'It was great' }, { error: 'no-speech' }, { error: 'not-allowed' });
    await page.click('[data-fk="voice"]');
    await until(page, () => /先按一下/.test(document.querySelector('#voice-bar').textContent), null, 12000);
    const autoRefused = await T(() => ({ blocked: window.__kaikouTest.Mic.blocked, kept: localStorage.getItem('kaikou:mic-off'), phase: window.__kaikouTest.Voice.phase }));
    await script({ error: 'not-allowed' });
    await page.click('[data-fk="vb-go"]');
    await until(page, () => !window.__kaikouTest.Voice.on, null, 6000);
    const tapRefused = await T(() => ({ blocked: window.__kaikouTest.Mic.blocked, kept: !!localStorage.getItem('kaikou:mic-off'), toggle: !!document.querySelector('[data-fk="voice"]'), msg: document.querySelector('#mic-msg').textContent }));
    check('語音對話：連不上語音辨識就關掉並說明，焦點移到輸入框；自動開始被拒只先暫停，按了還被拒才關掉麥克風', () => {
      assert.ok(/Google/.test(net.msg), net.msg);
      eq([net.toggle, net.bar, net.focus], [false, true, 'msg-input']);
      eq(sent.slice(-1), ['It was great']);
      eq(autoRefused, { blocked: false, kept: null, phase: 'paused' });
      eq([tapRefused.blocked, tapRefused.kept, tapRefused.toggle], [true, true, false]);
      assert.ok(/允許麥克風/.test(tapRefused.msg), tapRefused.msg);
    });
    await ctx.close();
  }

  // ---------- 6c. A browser with speech recognition but no speech voice ----------
  if (want('6c')) {
    const noVoice = speech + ';Object.defineProperty(window, "speechSynthesis", { value: undefined, configurable: true }); window.SpeechSynthesisUtterance = undefined;';
    const { ctx, page } = await open(base + '#saved', { viewport: { width: 1000, height: 800 }, serviceWorkers: 'block' }, 'novoice', null, noVoice);
    await giveKey(page, 'sk-ant-api03-' + 'TESTONLY'.repeat(6) + '-AA'); // so that the coach's start menu shows
    const T = (fn, a) => page.evaluate(fn, a);
    const list = await T(() => document.querySelector('#pron .help').textContent);
    await page.click('[data-fk="pron-th"]');
    const lesson = await T(() => ({ quiz: [...document.querySelectorAll('#pron h3')].map(h => h.textContent), how: document.querySelector('#pron .pairs').previousElementSibling.textContent, speakers: document.querySelectorAll('#pron [data-fk^="spk:"]').length, mics: document.querySelectorAll('#pron [data-say-btn]').length }));
    const k = await T(() => 'pwth:' + window.__kaikouTest.phraseId('think'));
    await T(() => window.__srScript.push({ text: 'sink' }));
    await page.click('[data-say-btn="' + k + '"]');
    await until(page, x => { const b = document.querySelector('[data-say="' + x + '"]'); return !!b && !!b.querySelector('.help'); }, k);
    const help = await T(x => document.querySelector('[data-say="' + x + '"] .help').textContent, k);
    await page.click('#t-coach');
    const tips = await T(() => [...document.querySelectorAll('#coach-dyn .tips li')].map(li => li.textContent));
    check('沒有朗讀聲音的瀏覽器：發音練習不提聽辨測驗和喇叭，只用麥克風唸；教練的說明不提語音對話（這時不能用）', () => {
      assert.ok(!/聽辨/.test(list) && /唸給電腦聽/.test(list), list);
      eq(lesson, { quiz: ['一對一對唸', '放進句子裡唸'], how: '按麥克風唸其中一個字，看電腦聽到的是哪一個。電腦常會往常見的字猜，結果當參考就好。', speakers: 0, mics: 15 });
      eq(help, '照上面的方法再唸一次「think」。');
      eq([tips.some(t => /^直接說/.test(t)), tips.some(t => /語音對話/.test(t))], [true, false]);
    });
    await ctx.close();
  }

  // ---------- 7. Backup file: export from the web version, merge into Claude, export from Claude ----------
  if (want('7')) {
    const { ctx, page } = await open(base, { viewport: { width: 1000, height: 800 } }, 'backup');
    await giveKey(page, 'sk-ant-api03-' + 'TESTONLY'.repeat(6) + '-AA'); // a stored key must stay out of the file
    await page.click('#today-dyn .list .item:nth-child(2) .check');
    await page.fill('#inbox-input', '備份測試的句子');
    await page.click('#inbox-form .btn');
    await page.click('#t-saved');
    await page.click('[data-fk^="star:st:"]');
    await until(page, () => !['phrases', 'inbox', 'log-' + window.__kaikouTest.S.lastToday.slice(0, 7)].some(n => window.__kaikouTest.Store.busyDoc(n)));
    await page.click('#btn-settings');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#set-export')]);
    const file = path.join(out, 'backup.json');
    await dl.saveAs(file);
    const raw = fs.readFileSync(file, 'utf8');
    const b = JSON.parse(raw);
    const keyStored = await page.evaluate(() => /TESTONLY/.test(localStorage.getItem('kaikou:api-key') || ''));
    const m = Object.keys(b.docs).find(n => /^log-/.test(n));
    check('匯出備份檔：含設定、打卡、收藏、隨手記（空的資料不放），不含對話與 API 金鑰', () => {
      eq([b.app, b.v, /^kaikou-backup-\d{4}-\d{2}-\d{2}\.json$/.test(dl.suggestedFilename())], ['kaikou-practice', 1, true]);
      eq(Object.keys(b.docs).filter(n => !/^log-/.test(n)).sort(), ['inbox', 'phrases', 'settings']);
      eq(Object.keys(b.docs).filter(n => /^log-/.test(n)).length, 1);
      eq(Object.values(b.docs[m].days).some(d => d.items && d.items.ai), true);
      eq([Object.keys(b.docs.phrases.map).length, Object.values(b.docs.inbox.map).map(x => x.text)], [1, ['備份測試的句子']]);
      eq([/sk-ant-|api-key|TESTONLY/.test(raw), keyStored], [false, true]);
    });
    await ctx.close();

    const c = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'import');
    const p2 = c.page;
    await until(p2, () => document.querySelector('#sync').textContent === '已同步');
    await p2.click('#btn-settings');
    const pick = async () => { const [fc] = await Promise.all([p2.waitForEvent('filechooser'), p2.click('#set-import')]); await fc.setFiles(file); };
    await pick();
    await until(p2, () => !document.querySelector('#set-import-box').hidden);
    const summary = await p2.textContent('#set-import-box');
    await p2.click('[data-fk="imp-go"]');
    await until(p2, () => !window.__kaikouTest.S.uploading && !window.__kaikouTest.S.importing);
    await until(p2, () => { const X = window.__kaikouTest; return ['phrases', 'inbox', 'log-' + window.__mockToday.slice(0, 7)].every(n => !X.Store.busyDoc(n)); }, null, 6000);
    const merged = await p2.evaluate(() => {
      const X = window.__kaikouTest, get = n => window.__store.get('data/users/u_test/' + n);
      return { phrases: X.normPhrases(get('phrases')).length, inbox: X.normInbox(get('inbox')).map(x => x.text).sort(), today: get('log-' + window.__mockToday.slice(0, 7)).days[window.__mockToday].items, about: get('settings').about, toast: document.querySelector('#toast').textContent };
    });
    check('匯入備份檔到 Claude：先顯示內容，合併後雲端的資料都還在、新的加進來', () => {
      assert.ok(summary.includes('1 句收藏') && summary.includes('1 則隨手記'), summary);
      eq(merged.phrases, 4);
      eq(merged.inbox, ['我們需要再確認一下預算', '備份測試的句子', '這個功能下週才能上線'].sort());
      eq([!!merged.today.shadow, !!merged.today.ai], [true, true]);
      eq(merged.about, 'I live in Taipei and work in marketing.');
      assert.ok(merged.toast.startsWith('已合併：新增收藏 1 句、隨手記 1 則'), merged.toast);
    });
    // Importing the same file again adds nothing.
    await pick();
    await until(p2, () => !document.querySelector('#set-import-box').hidden);
    await p2.click('[data-fk="imp-go"]');
    await until(p2, () => !window.__kaikouTest.S.importing && document.querySelector('#toast').textContent.startsWith('已合併'));
    const again = await p2.textContent('#toast');
    // Export from Claude: every stored month, through the downloads capability. Meanwhile another device has saved a
    // phrase, and the cloud holds a month this page never loaded: the file has both (the cloud's copy is the latest).
    const phoneEn = 'I saved this one on my phone.';
    await p2.evaluate(en => {
      const P = n => 'data/users/u_test/' + n, id = window.__kaikouTest.phraseId(en), ph = window.__store.get(P('phrases'));
      window.__store.set(P('phrases'), Object.assign({}, ph, { map: Object.assign({}, ph.map || {}, { [id]: { id, en, zh: '', note: '', ex: '', src: 'starter', at: Date.now() } }) }));
      window.__store.set(P('log-2025-05'), { days: { '2025-05-20': { plans: { 0: '20' }, items: { shadow: true, ai: true } } } });
    }, phoneEn);
    await p2.click('#set-export');
    await until(p2, () => window.__downloads.length === 1, null, 6000);
    const ex = await p2.evaluate(en => {
      const d = window.__downloads[0], b = JSON.parse(d.data);
      const stored = [...window.__store.keys()].map(k => k.split('/').pop()).filter(n => n !== 'chat').sort();
      return { name: /\.json$/.test(d.filename), docs: Object.keys(b.docs).sort(), stored, phone: window.__kaikouTest.normPhrases(b.docs.phrases).some(p => p.en === en), old: !!b.docs['log-2025-05'] };
    }, phoneEn);
    check('重複匯入不會多出東西；Claude 版匯出經由下載確認，含雲端裡每個月的資料（包括這次沒載入的月份和別台裝置剛存的）', () => {
      eq(again, '已合併，沒有新的資料');
      eq(ex.name, true);
      eq(ex.stored.every(n => ex.docs.includes(n)), true);
      eq([ex.docs.includes('chat'), ex.phone, ex.old], [false, true, true]);
    });
    // The list of cloud documents cannot be read (twice): the file still has what this device loaded, and says so.
    await until(p2, () => !window.__kaikouTest.S.exporting);
    await p2.evaluate(() => { window.__mockCfg.failList = 2; });
    await p2.click('#set-export');
    await until(p2, () => window.__downloads.length === 2, null, 8000);
    const part = await p2.evaluate(() => ({ toast: document.querySelector('#toast').textContent, docs: Object.keys(JSON.parse(window.__downloads[1].data).docs) }));
    check('Claude 版匯出時讀不到雲端的清單：仍匯出這台裝置載入的資料，並說明可能少了較舊的月份', () => {
      assert.ok(part.toast.includes('讀不到雲端上較舊的月份'), part.toast);
      eq(['settings', 'phrases', 'inbox'].every(n => part.docs.includes(n)), true);
    });
    // The viewer declines the download (nothing more to say), or one is still waiting for them to confirm.
    await until(p2, () => !window.__kaikouTest.S.exporting);
    await p2.evaluate(() => { window.__mockCfg.saveFail = 'declined'; document.querySelector('#toast').textContent = ''; });
    await p2.click('#set-export');
    await until(p2, () => !window.__kaikouTest.S.exporting, null, 8000);
    const declined = await p2.evaluate(() => ({ toast: document.querySelector('#toast').textContent, files: window.__downloads.length }));
    await p2.evaluate(() => { window.__mockCfg.saveFail = 'rate_limited'; });
    await p2.click('#set-export');
    await until(p2, () => !window.__kaikouTest.S.exporting, null, 8000);
    const waiting = await p2.evaluate(() => document.querySelector('#toast').textContent);
    await p2.evaluate(() => { window.__mockCfg.saveFail = ''; });
    check('Claude 版匯出：不想下載就不多說；還有一個下載在等你確認時會說明', () => eq([declined, waiting], [{ toast: '', files: 2 }, '已經有一個下載在等你確認']));
    // A hand-made or damaged file: a day only takes the app's own items, a few coach sessions and plans, capped minutes.
    const old = new Date(NOON); old.setDate(old.getDate() - 20);
    const oldKey = old.getFullYear() + '-' + String(old.getMonth() + 1).padStart(2, '0') + '-' + String(old.getDate()).padStart(2, '0');
    const crafted = path.join(out, 'backup-crafted.json');
    // It also files days and reviews under months that do not exist or are not theirs: those are left out.
    fs.writeFileSync(crafted, JSON.stringify({ app: 'kaikou-practice', v: 1, docs: {
      ['log-' + oldKey.slice(0, 7)]: { days: { [oldKey]: {
        plans: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [String(i + 1), i === 9 ? '60' : '20'])), // switched ten times, last to 60
        items: { shadow: true, ai: 'yes', hacker: true, f432: true },
        coach: Object.fromEntries(Array.from({ length: 500 }, (_, i) => ['c' + i, 9999])),
        coachMin: 99999,
      }, [oldKey.slice(0, 7) + '-00']: { items: { listen: true } } } },
      'log-2025-01': { days: { [oldKey]: { plans: { 0: '20' }, items: { listen: true } } } },
      'log-2026-13': { monthRecord: true, days: { '2026-13-01': { items: { shadow: true } } } },
      'log-0000-00': { monthRecord: true },
      'sessions-0000-00': { items: [{ id: 'sZero', date: '0000-00-00', summary: 'x' }] },
      ['sessions-' + oldKey.slice(0, 7)]: { items: [{ id: 'sFuture', date: '2099-01-01', summary: 'x' }, { id: 'sBad', date: oldKey.slice(0, 7) + '-32', summary: 'x' }] },
    } }));
    const [fc3] = await Promise.all([p2.waitForEvent('filechooser'), p2.click('#set-import')]);
    await fc3.setFiles(crafted);
    await until(p2, () => !document.querySelector('#set-import-box').hidden);
    const craftedSummary = await p2.textContent('#set-import-box');
    await p2.click('[data-fk="imp-go"]');
    await until(p2, () => !window.__kaikouTest.S.importing && document.querySelector('#toast').textContent.startsWith('已合併'));
    await until(p2, k => !window.__kaikouTest.Store.busyDoc('log-' + k.slice(0, 7)), oldKey, 6000);
    const craftedToast = await p2.textContent('#toast');
    const day = await p2.evaluate(k => window.__store.get('data/users/u_test/log-' + k.slice(0, 7)).days[k], oldKey);
    const strays = await p2.evaluate(k => {
      const keys = [...window.__store.keys()].map(x => x.split('/').pop());
      const sess = window.__store.get('data/users/u_test/sessions-' + k.slice(0, 7));
      return { docs: keys.filter(n => /^log-2025-01$|^log-2026-13$|^log-0000-00$|^sessions-(0000|2099)/.test(n)), days: Object.keys(window.__store.get('data/users/u_test/log-' + k.slice(0, 7)).days).filter(d => d.endsWith('-00')),
        sess: sess ? window.__kaikouTest.normSessions(sess).map(x => x.id).filter(id => /^s(Zero|Future|Bad)$/.test(id)) : [] };
    }, oldKey);
    check('匯入手做或壞掉的備份檔：一天只收這個 App 的項目、最多 20 次對話與最近 5 次計畫選擇，分鐘數有上限', () => {
      eq(day.items, { shadow: true, f432: true });
      eq([Object.keys(day.coach).length, Math.max(...Object.values(day.coach)), Object.keys(day.plans).sort((a, b) => a - b), day.plans['10'], day.coachMin], [20, 600, ['6', '7', '8', '9', '10'], '60', 600]);
    });
    check('匯入手做或壞掉的備份檔：不存在的日期和月份、放錯月份的日子都不收（匯入前的說明也不算它們），也不會多出奇怪的文件', () => {
      eq(strays, { docs: [], days: [], sess: [] });
      assert.ok(!/對話複習/.test(craftedToast), craftedToast);
      assert.ok(/1 天練習/.test(craftedSummary) && /0 次對話複習/.test(craftedSummary), craftedSummary);
    });
    await c.ctx.close();
  }

  if (want('7')) {
    // A change not saved yet (the cloud keeps failing) goes into the backup file, laid over the cloud's copy: what
    // another device changed meanwhile in the same month is not replaced by this device's older copy.
    const month = dayKey(0).slice(0, 7);
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'export-unsaved', { failWrites: { ['log-' + month]: { n: 99, code: 'unavailable' } } });
    await page.click('#today-dyn .list .item:nth-child(4) .check');
    await until(page, m => window.__kaikouTest.Store.failed['log-' + m], month, 8000);
    // Meanwhile the phone takes back today's 影子跟讀.
    await page.evaluate(m => { window.__store.get('data/users/u_test/log-' + m).days[window.__mockToday].items.shadow = false; }, month);
    await page.click('#btn-settings');
    await page.click('#set-export');
    await until(page, () => window.__downloads.length === 1, null, 8000);
    const file = await page.evaluate(m => { const d = JSON.parse(window.__downloads[0].data).docs['log-' + m].days[window.__mockToday].items; return { listen: !!d.listen, shadow: !!d.shadow }; }, month);
    await page.evaluate(m => { window.__mockCfg.failWrites['log-' + m].n = 0; }, month);
    check('匯出備份檔時有還沒存好的變更：檔案裡有這個變更，別台裝置剛改的也照雲端的', () => eq(file, { listen: true, shadow: false }));
    await ctx.close();
  }

  if (want('7')) {
    // The documents here could not be read: the import waits (a merge must never be applied to a stale copy).
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'import-unread', { failReads: { inbox: 99 } });
    await page.click('#btn-settings');
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#set-import')]);
    await fc.setFiles(path.join(out, 'backup.json'));
    await until(page, () => !document.querySelector('#set-import-box').hidden);
    await page.click('[data-fk="imp-go"]');
    await until(page, () => /還讀不到這裡的部分資料/.test(document.querySelector('#toast').textContent));
    const waiting = await page.evaluate(() => ({ offered: !document.querySelector('#set-import-box').hidden, inbox: window.__store.get('data/users/u_test/inbox').items.length }));
    await page.evaluate(() => { window.__mockCfg.failReads.inbox = 0; });
    await page.click('[data-fk="imp-go"]');
    await until(page, () => document.querySelector('#toast').textContent.startsWith('已合併'));
    await until(page, () => !window.__kaikouTest.Store.busyDoc('inbox'));
    const inbox = await page.evaluate(() => window.__kaikouTest.normInbox(window.__store.get('data/users/u_test/inbox')).length);
    check('匯入時這裡有資料還讀不到：先不合併、檔案保留；讀得到之後再合併', () => {
      eq(waiting, { offered: true, inbox: 2 });
      eq(inbox, 3);
    });
    await ctx.close();
  }

  // ---------- 8. Add to home screen (GitHub Pages over http) ----------
  if (want('8')) {
    check('Claude 版片段：不帶加到主畫面的標籤', () => {
      const f = toArtifact(full);
      eq([/rel="manifest"/.test(f), /apple-touch-icon/.test(f), /theme-color/.test(f), f.startsWith('<title>')], [false, false, false, true]);
    });
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    page.on('pageerror', e => errors.push('[pwa] pageerror: ' + e.message));
    await page.addInitScript(() => { window.__kaikouTest = true; });
    const ready = () => page.waitForFunction(() => window.__kaikouTest && window.__kaikouTest.S && window.__kaikouTest.S.ready, null, { timeout: 10000 });
    await page.goto(base);
    await ready();
    const man = await page.evaluate(async () => {
      const l = document.querySelector('link[rel="manifest"]');
      const j = await (await fetch(l.href)).json();
      const icons = await Promise.all(j.icons.map(async i => { const r = await fetch(new URL(i.src, l.href)); return r.ok ? r.headers.get('content-type') : r.status; }));
      const touch = await fetch(document.querySelector('link[rel="apple-touch-icon"]').href);
      return { name: j.name, short: j.short_name, display: j.display, start: j.start_url, icons, touch: touch.ok };
    });
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await ready();
    const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
    await page.click('#btn-settings');
    const inst = await page.evaluate(() => ({ shown: !document.querySelector('#set-install-field').hidden, help: document.querySelector('#set-install-help').textContent }));
    await page.goto(base + 'manifest.webmanifest'); // opening another file of the site must not replace the stored page
    const kept = await page.evaluate(async b => { const r = await caches.match(b); return r ? r.headers.get('content-type') : null; }, base);
    srv.down = true; // the network is gone: only the stored page can open
    await page.goto(base);
    await ready();
    const offline = await page.evaluate(() => ({ title: document.title, today: !!document.querySelector('#today-dyn .item') }));
    srv.down = false;
    // A new version of the site: the next visit with a network shows it (the stored page is only for when there is
    // none), and it is the one stored from then on.
    const version = () => page.evaluate(() => (document.querySelector('meta[name="test-version"]') || {}).content || 'v1');
    srv.page = full.replace('<head>', '<head><meta name="test-version" content="v2">');
    await page.goto(base);
    await ready();
    const online2 = await version();
    srv.down = true;
    await page.goto(base);
    await ready();
    const offline2 = await version();
    srv.down = false;
    srv.page = null;
    // The site moved (the address answers with a redirect): the redirect is followed, not hidden by the stored page.
    srv.moved = '/new-home/';
    await page.goto(base);
    const moved = { path: new URL(page.url()).pathname, title: await page.title() };
    srv.moved = null;
    await ctx.close();
    check('加到主畫面：manifest 與圖示正確，service worker 讓頁面沒有網路也能打開，設定裡有安裝說明', () => {
      eq(man, { name: '開口練習室', short: '開口', display: 'standalone', start: './', icons: ['image/png', 'image/png', 'image/png'], touch: true });
      eq(controlled, true);
      assert.ok(/text\/html/.test(kept || ''), 'the stored page is still the page: ' + kept);
      eq(offline, { title: '開口練習室', today: true });
      eq(inst.shown, true);
      assert.ok(/加到主畫面/.test(inst.help), inst.help);
    });
    check('加到主畫面：網站更新後，有網路時打開就是新版（之後離線也是新版）；網站搬家（轉址）時跟著轉過去，不會一直停在舊的頁面', () => {
      eq([online2, offline2], ['v2', 'v2']);
      eq(moved, { path: '/new-home/', title: '新家' });
    });
  }

  // ---------- 9. A slow or blocked fonts host never holds the page up ----------
  if (want('9')) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    const held = [];
    await page.route(/fonts\.gstatic\.com/, r => r.abort());
    await page.route(/fonts\.googleapis\.com/, r => new Promise(res => held.push(() => res(r.fulfill({ status: 200, contentType: 'text/css', body: '/* test */' })))));
    await page.addInitScript(() => { window.__kaikouTest = true; });
    await page.goto('file://' + PAGES, { waitUntil: 'domcontentloaded' });
    let booted = true;
    try { await page.waitForFunction(() => window.__kaikouTest && window.__kaikouTest.S && window.__kaikouTest.S.ready, null, { timeout: 5000 }); } catch (_) { booted = false; }
    const before = await page.evaluate(() => [...document.querySelectorAll('link[data-font]')].map(l => l.media));
    for (const f of held) f();
    let switched = true;
    try { await page.waitForFunction(() => [...document.querySelectorAll('link[data-font]')].every(l => l.media === 'all'), null, { timeout: 5000 }); } catch (_) { switched = false; }
    await ctx.close();
    check('字型很慢或連不上時，頁面照常打開；字型到了才套用', () => eq([booted, before, held.length, switched], [true, ['print', 'print'], 2, true]));
  }

  srv.close();
  await browser.close();
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'ERRORS: none');
  const bad = failures.length + errors.length;
  if (!checks) { console.log('沒有跑任何檢查'); process.exit(1); }
  console.log(bad ? '有 ' + failures.length + ' 項檢查失敗、' + errors.length + ' 個頁面錯誤' : '全部 ' + checks + ' 項檢查通過');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('RUN FAILED', e); if (errors.length) console.error('ERRORS:\n' + errors.join('\n')); process.exit(1); });
