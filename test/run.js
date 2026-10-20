// 開口練習室的瀏覽器測試。
// - 「在 Claude 裡」的情境：把 docs/index.html 轉成 Artifact 片段（tools/artifact.js），包上和 Claude 一樣的外框，
//   再用 test/mock.js 模擬 window.claude（雲端資料庫與 AI 教練）。
// - 「直接開檔」的情境：原封不動打開 docs/index.html（file://，用手機模擬；這時不能存 API 金鑰）。
// - 「GitHub Pages」的情境：用本機 http 伺服器，像 GitHub Pages 一樣放在 /kaikou-practice/ 底下（金鑰、備份檔、加到主畫面）。
// - 麥克風與朗讀用 test/speech.js 的替身（無頭瀏覽器沒有真的語音辨識和聲音）；Claude API 用 page.route 模擬，金鑰是假的。
// 每一項檢查失敗都會印出 FAIL，最後以非 0 結束碼結束；全部通過時印出 "ERRORS: none" 和通過的項數。
// 執行：npm install、npx playwright install chromium、npm test。截圖存到 test/shots/。
// 只跑其中幾段：npm test -- 3b,6（或 ONLY=3b,6 npm test；段落編號見下面每段的標題）。
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
// npm test -- 3b,6 (or ONLY=3b,6) runs just those sections (each section's blocks are wrapped in want()). The argument
// works in every shell, Windows' too.
const SECTIONS = ['1', '2', '3', '3b', '4', '5', '6', '6b', '6c', '7', '8', '9', '10'];
const ONLY = String(process.argv[2] || process.env.ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
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
// srv.status = 500: the page answers with that status. srv.delay = ms: the page answers that much later.
// srv.swHead = 'code': the service worker is served with this code first (to break its cache storage, for example).
function serve(root) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.json': 'application/json' };
  return new Promise(res => {
    const srv = http.createServer((req, resp) => {
      if (srv.down) { req.socket.destroy(); return; }
      const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (u === '/new-home/') { resp.writeHead(200, { 'content-type': types['.html'] }); resp.end('<!doctype html><meta charset="utf-8"><title>新家</title><p>The site moved here.</p>'); return; }
      if (!u.startsWith('/kaikou-practice/')) { resp.writeHead(404); resp.end(); return; }
      const isPage = u === '/kaikou-practice/' || u === '/kaikou-practice/index.html';
      const answer = () => {
        if (isPage && srv.status) { resp.writeHead(srv.status, { 'content-type': types['.html'] }); resp.end('<!doctype html><meta charset="utf-8"><title>status ' + srv.status + '</title>'); return; }
        if (isPage && srv.moved) { resp.writeHead(301, { location: srv.moved }); resp.end(); return; }
        if (isPage && srv.page) { resp.writeHead(200, { 'content-type': types['.html'] }); resp.end(srv.page); return; }
        let f = path.join(root, u.slice('/kaikou-practice/'.length));
        if (u.endsWith('/')) f = path.join(f, 'index.html');
        if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { resp.writeHead(404); resp.end(); return; }
        resp.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
        if (u === '/kaikou-practice/sw.js' && srv.swHead) { resp.end(srv.swHead + '\n' + fs.readFileSync(f, 'utf8')); return; }
        fs.createReadStream(f).pipe(resp);
      };
      if (isPage && srv.delay) setTimeout(answer, srv.delay); else answer();
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
    // The browser logs the deliberate API failures of the API key scenarios (401, 400, 402, 403, 429, 500) as errors;
    // anything else counts.
    const expected = t => /ERR_FAILED|net::/.test(t) || (/^apikey/.test(tag) && /status of (40[0-3]|429|500)\b/.test(t));
    page.on('console', m => { if (m.type() === 'error' && !expected(m.text())) errors.push('[' + tag + '] console: ' + m.text()); });
    page.on('pageerror', e => errors.push('[' + tag + '] pageerror: ' + e.message));
    await page.addInitScript(c => { window.__kaikouTest = true; if (c) window.__mockCfg = c; }, init || null);
    if (extra) await page.addInitScript({ content: extra });
    await page.goto(/^https?:/.test(file) ? file : 'file://' + file);
    // Opened completely: also past the look at changes earlier visits left unsent (a record a test stores after this
    // is sent only when the test makes it so, not by the page still opening).
    await page.waitForFunction(() => window.__kaikouTest && window.__kaikouTest.S && window.__kaikouTest.S.ready && window.__kaikouTest.S.started, null, { timeout: 10000 });
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
  // A two-step button (放棄, 刪除, 清除…) is confirmed by a second press a moment later: a second press right after the
  // first (a double click) does not confirm it.
  const pressTwice = async (page, sel) => { await page.click(sel); await page.waitForTimeout(650); await page.click(sel); };

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
        // A label or bullet before corrections that come without a separator is not part of the reply either.
        before: [pc('Nice! What did you eat?\nCorrections:\n{"you": "I eat", "better": "I ate", "why": "過去式"}'), pc('Nice!\n- {"you": "a", "better": "b", "why": "c"}'),
          pc('Nice!\nFeedback:\n###\n{"none": true}'), pc('I took some notes.\nFeedback is welcome!'), T.streamPart('Nice! What did you eat?\nCorrections:\n{"you"')],
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
    check('沒有分隔線時，更正前面的「Corrections:」或項目符號也不算進回覆（不會顯示、也不會被唸出來）', () => eq(pure.before, [
      ['Nice! What did you eat?', 1, false], ['Nice!', 1, false], ['Nice!', 0, true], ['I took some notes.\nFeedback is welcome!', 0, false], 'Nice! What did you eat?']));
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
      eq([lvl.chat, lvl.rules, lvl.toast], ['A2', true, '這次對話接下來用 A2 初級的程度回覆']);
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
    await pressTwice(page, '[data-fk="discard"]');
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
    await page.waitForTimeout(650);
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
    await pressTwice(page, delNote);
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

  if (want('3')) {
    // Clearing this browser's practice data: a double click does not do it (the second click lands on 再按一次清除); a
    // later press does, and another tab of the app in this browser starts fresh too (it does not write back what it
    // showed).
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    await ctx.clock.install({ time: NOON });
    const page = await addPage(ctx, PAGES, 'clear-twice');
    await page.fill('#inbox-input', '清除前記的句子');
    await page.click('#inbox-form .btn');
    await until(page, () => /清除前記的句子/.test(localStorage.getItem('kaikou:inbox') || ''), null, 4000);
    await settle(page);
    const other = await addPage(ctx, PAGES, 'clear-other');
    await seeWrites(other, () => /清除前記的句子/.test(localStorage.getItem('kaikou:inbox') || ''));
    await page.click('#btn-settings');
    await page.dblclick('#set-clear');
    await page.waitForTimeout(300);
    const kept = await page.evaluate(() => /清除前記的句子/.test(localStorage.getItem('kaikou:inbox') || ''));
    await page.waitForTimeout(400);
    await Promise.all([page.waitForEvent('load'), other.waitForEvent('load'), page.click('#set-clear')]);
    const ready = p => p.waitForFunction(() => window.__kaikouTest && window.__kaikouTest.S && window.__kaikouTest.S.ready, null, { timeout: 10000 });
    await ready(page);
    await ready(other);
    await other.fill('#inbox-input', '清除後記的句子'); // the other tab writes again: only what is new
    await other.click('#inbox-form .btn');
    await until(other, () => /清除後記的句子/.test(localStorage.getItem('kaikou:inbox') || ''), null, 4000);
    const r = await other.evaluate(() => ({ shown: window.__kaikouTest.S.inbox.map(x => x.text), stored: window.__kaikouTest.normInbox(JSON.parse(localStorage.getItem('kaikou:inbox'))).map(x => x.text) }));
    check('清除這個瀏覽器裡的練習資料：連點兩下不會清掉，隔一下再按才清；同一個瀏覽器的另一個分頁也一起重新開始，不會把畫面上的資料再寫回去', () => {
      eq(kept, true);
      eq(r, { shown: ['清除後記的句子'], stored: ['清除後記的句子'] });
    });
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
      api.calls.push({ key: h['x-api-key'], direct: h['anthropic-dangerous-direct-browser-access'], version: h['anthropic-version'], model: body.model, max: body.max_tokens, thinking: (body.thinking || {}).type, stream: body.stream, roles: msgs.map(m => m.role[0]).join('') });
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
    // 設定 is a modal dialog (the rest of the page is out of sight and out of reach of screen readers): the message is
    // shown on top of it and read out from inside it.
    await until(page, () => /不是 Claude API 金鑰/.test(document.querySelector('#sr-live').textContent), null, 2000).catch(() => {});
    const seen = await page.evaluate(() => {
      const d = document.querySelector('#settings'), t = document.querySelector('#toast'), r = t.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { inside: d.contains(t) && d.contains(document.querySelector('#sr-live')), onTop: !!top && t.contains(top), live: document.querySelector('#sr-live').textContent };
    });
    const wrong = { toast: await toastText(), stored: await page.evaluate(() => localStorage.getItem('kaikou:api-key')) };
    await page.fill('#set-api-key', KEY);
    await page.press('#set-api-key', 'Enter');
    await until(page, () => !!localStorage.getItem('kaikou:api-key'), null, 3000);
    const saved = await page.evaluate(() => ({ input: document.querySelector('#set-api-key').value, state: document.querySelector('#set-api-state').textContent, remove: !document.querySelector('#set-api-clear').hidden, toast: document.querySelector('#toast').textContent }));
    await shot(page, '12-pages-api-key.png');
    await page.click('#set-done');
    const msgsBack = await until(page, () => { const d = document.querySelector('#settings'); return !d.contains(document.querySelector('#toast')) && !d.contains(document.querySelector('#sr-live')); }, null, 2000).then(() => true, () => false);
    check('網頁版金鑰：沒有金鑰時引導到設定，格式不對的不存，存好後只顯示結尾；設定開著時訊息顯示在設定上面、也照樣朗讀', () => {
      eq(before, { title: 'AI 教練需要 Claude', btn: true });
      eq(empty, { field: true, state: '還沒有儲存金鑰。', remove: false });
      eq([/不是 Claude API 金鑰/.test(wrong.toast), wrong.stored], [true, null]);
      eq(saved, { input: '', state: '已儲存一把金鑰（結尾 ' + KEY.slice(-4) + '），AI 教練會用它回覆。', remove: true, toast: '已儲存金鑰' });
      eq([seen.inside, seen.onTop, /不是 Claude API 金鑰/.test(seen.live), msgsBack], [true, true, true, true]);
    });

    // The coach now answers through the API: opener, a correction, more turns, then the review.
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
    check('網頁版金鑰：請求帶金鑰與瀏覽器標頭，對話用 Haiku、複習用 Sonnet（都不先思考，思考會吃掉回覆的長度），角色輪流', () => {
      eq(api.calls.length, 5);
      for (const c of api.calls) eq([c.key, c.direct, c.version, c.stream], [KEY, 'true', '2023-06-01', true]);
      eq(api.calls.map(c => c.model + ':' + c.max + ':' + c.thinking), ['claude-haiku-5-5:2048:disabled', 'claude-haiku-5-5:2048:disabled', 'claude-haiku-5-5:2048:disabled', 'claude-haiku-5-5:2048:disabled', 'claude-sonnet-5-5:8192:between_tools']);
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

    // Refused for where the request comes from (a region the API does not serve), over a spending limit set in the
    // Console, or over the account tier's monthly cap: each says what it is. Only the first can be tried again (after
    // changing the network); none of them sends the learner to re-enter the key.
    const noteNow = () => page.evaluate(() => ({ note: document.querySelector('#coach-note').textContent, retry: !!document.querySelector('#coach-note [data-fk="retry"]'), toKey: !!document.querySelector('#coach-note [data-fk="note-key"]') }));
    api.fail = { status: 403, error: { type: 'forbidden', message: 'Request not allowed' } };
    await say('We went to the beach');
    const region = await noteNow();
    api.fail = { status: 400, error: { type: 'invalid_request_error', message: 'You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.' } };
    await page.click('#coach-note [data-fk="retry"]');
    await notBusy(page);
    const limit = await noteNow();
    api.fail = { status: 429, error: { type: 'rate_limit_error', message: 'You have reached your API usage limits.', details: { error_code: 'enforced_spend_limit_reached' } } };
    await say('The water was cold');
    const cap = await noteNow();
    api.fail = { status: 402, error: { type: 'billing_error', message: 'Payment method declined.' } };
    await say('We swam anyway');
    const billing = await noteNow();
    api.fail = null;
    check('網頁版金鑰：所在地區不支援、到了自己設的花費上限、帳戶的每月上限、付款問題，各自說明真正的原因（只有地區的可以再試）', () => {
      eq([/中國大陸/.test(region.note), region.retry, region.toKey], [true, true, false]);
      eq([/花費上限/.test(limit.note), limit.retry, limit.toKey], [true, false, false]);
      eq([/下個月/.test(cap.note), cap.retry, cap.toKey], [true, false, false]);
      eq([/付款/.test(billing.note), billing.retry], [true, false]);
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
      const e = (s, type, message, details) => T.apiError(s, { type: 'error', error: Object.assign({ type, message: message || '' }, details ? { details } : {}) }).code;
      return {
        codes: [e(401, 'authentication_error'), e(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API.'), e(404, 'not_found_error', 'model: x'), e(529, 'overloaded_error'), e(429, 'rate_limit_error'), e(413, 'request_too_large'), e(400, 'invalid_request_error', 'messages: bad'), T.apiError(500, null).code, e(0, 'overloaded_error'),
          e(402, 'billing_error', 'Payment method declined.'), e(400, 'invalid_request_error', 'You have reached your specified workspace API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.'),
          e(429, 'rate_limit_error', 'You have reached your API usage limits.', { error_code: 'enforced_spend_limit_reached' }), e(403, 'forbidden', 'Request not allowed'), e(403, 'permission_error', 'Your API key does not have permission to use the specified resource.'), e(504, 'timeout_error')],
        joined: T.apiMessages([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }, { role: 'assistant', content: 'c' }, { role: 'user', content: 'd' }]),
      };
    });
    check('網頁版金鑰：API 錯誤依類型對應到中文說明（金鑰、額度、花費上限、每月上限、地區或權限），同一方連續的話合併成一則', () => {
      eq(unit.codes, ['key_invalid', 'no_credit', 'model_missing', 'overloaded', 'rate_limited', 'prompt_too_large', 'invalid_request', 'upstream_error', 'overloaded',
        'no_credit', 'spend_limit', 'spend_cap', 'forbidden', 'forbidden', 'upstream_error']);
      eq(unit.joined, [{ role: 'user', content: 'a\n\nb' }, { role: 'assistant', content: 'c' }, { role: 'user', content: 'd' }]);
    });
    // The stream reader: events cut anywhere across chunks, CRLF line ends, an error in the middle of a reply, a reply
    // cut at max_tokens, a refusal after some text, and a thinking block before the text.
    const reader = await page.evaluate(async () => {
      const T = window.__kaikouTest, enc = new TextEncoder(), real = window.fetch;
      const ev = (type, data) => 'event: ' + type + '\ndata: ' + JSON.stringify(Object.assign({ type }, data)) + '\n\n';
      const run = async (body, size) => {
        window.fetch = () => Promise.resolve(new Response(new ReadableStream({ start(c) { for (let i = 0; i < body.length; i += size) c.enqueue(enc.encode(body.slice(i, i + size))); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
        try { const r = await T.apiSample('hi', {}); return [r.text, r.truncated]; } catch (e) { return [e.code, e.text || '']; } finally { window.fetch = real; }
      };
      const start = ev('message_start', { message: { content: [] } }) + ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      const say = t => ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: t } });
      const end = r => ev('message_delta', { delta: { stop_reason: r } }) + ev('message_stop', {});
      return {
        split: await run(start + say('Hello ') + say('there') + end('end_turn'), 7),
        crlf: await run((start + say('Hello CRLF') + end('end_turn')).replace(/\n/g, '\r\n'), 5),
        error: await run(start + say('Partial') + ev('error', { error: { type: 'overloaded_error', message: 'Overloaded' } }), 50),
        max: await run(start + say('Cut off') + end('max_tokens'), 50),
        refusal: await run(start + say('Some text') + end('refusal'), 50),
        thinking: await run(ev('message_start', { message: { content: [] } }) + ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }) + ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: '' } })
          + ev('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig' } }) + ev('content_block_stop', { index: 0 }) + ev('content_block_start', { index: 1, content_block: { type: 'text', text: '' } })
          + ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'Answer' } }) + end('end_turn'), 13),
      };
    });
    check('網頁版金鑰：串流的事件被切在任何地方、CRLF、回覆中途出錯、在 max_tokens 截斷、回了一些字之後拒絕、先有思考區塊，都照實處理', () => eq(reader, {
      split: ['Hello there', false], crlf: ['Hello CRLF', false], error: ['overloaded', 'Partial'], max: ['Cut off', true], refusal: ['refused', ''], thinking: ['Answer', false],
    }));

    // Clearing the practice data in this browser keeps the key, which has its own button.
    await page.click('#btn-settings');
    await page.click('#set-clear');
    await page.waitForTimeout(650);
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
    await pressTwice(page, '#set-api-clear');
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
  if (want('3b')) {
    // The coach's reply failed (重新回覆 is offered), then hints come back unusable: the hint message does not take the
    // way to ask for the reply again. On a phone, closing the hints does not put the focus in the text box.
    const KEY = 'sk-ant-api03-' + 'TESTONLY'.repeat(6) + '-AA';
    const { ctx, page } = await open(base + '#coach', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' }, 'apikey-note');
    await giveKey(page, KEY);
    let fail = false, hintKeyRefused = false, hints = '{"suggestions": ["Sounds great", "I had fun"]}';
    await page.route('https://api.anthropic.com/v1/messages', route => {
      const msgs = (JSON.parse(route.request().postData() || '{}').messages) || [];
      const last = String((msgs[msgs.length - 1] || {}).content || '');
      if (/^An English learner/.test(last) && hintKeyRefused) return route.fulfill({ status: 401, headers: Object.assign({ 'content-type': 'application/json' }, CORS), body: '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}' });
      if (/^An English learner/.test(last)) return sseReply(route, hints);
      // The review stops at max_tokens in the middle of its JSON.
      if (/^Review this English speaking practice session/.test(last)) return route.fulfill({ status: 200, headers: Object.assign({ 'content-type': 'text/event-stream; charset=utf-8' }, CORS), body: sse('{"summary": "今天說得很順，').replace('"stop_reason":"end_turn"', '"stop_reason":"max_tokens"') });
      if (fail) return route.fulfill({ status: 500, headers: Object.assign({ 'content-type': 'application/json' }, CORS), body: '{"type":"error","error":{"type":"api_error","message":"Internal"}}' });
      return sseReply(route, 'Hi! What did you do last weekend?\n###\n{"none": true}');
    });
    await page.tap('#start-btn');
    await notBusy(page);
    fail = true;
    await page.fill('#msg-input', 'I went hiking');
    await page.tap('#send-btn');
    await notBusy(page);
    await page.tap('#hint-btn');
    await until(page, () => window.__kaikouTest.S.hints !== 'loading', null, 6000);
    await page.waitForTimeout(200);
    const note = await page.evaluate(() => ({ text: document.querySelector('#coach-note span').textContent, retry: !!document.querySelector('#coach-note [data-fk="retry"]') }));
    // Hints refused because of the key itself: asking for the reply again cannot work either, so it is not offered.
    hintKeyRefused = true;
    await page.tap('#hint-btn');
    await until(page, () => window.__kaikouTest.S.hints !== 'loading', null, 6000);
    await page.waitForTimeout(200);
    const keyNote = await page.evaluate(() => ({ text: document.querySelector('#coach-note span').textContent, retry: !!document.querySelector('#coach-note [data-fk="retry"]') }));
    hintKeyRefused = false;
    fail = false;
    hints = '[{"en": "Sounds great to me", "zh": "聽起來很棒"}]';
    await page.tap('#hint-btn');
    await page.waitForSelector('#hints .hint');
    await page.tap('[data-fk="hints-close"]');
    const closeFocus = await page.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.tagName));
    // Two more sentences, then 結束並複習: the review is cut at max_tokens, and it says so.
    await page.tap('#coach-note [data-fk="retry"]');
    await notBusy(page);
    for (const t of ['We saw a waterfall', 'It was beautiful']) { await page.fill('#msg-input', t); await page.tap('#send-btn'); await notBusy(page); }
    await page.tap('[data-fk="review"]');
    await notBusy(page);
    const cut = await page.evaluate(() => document.querySelector('#coach-note').textContent);
    check('提示沒想出來時，教練還沒回覆的那句仍可以重新回覆（金鑰本身被拒時不提供）；手機上收起提示不會把焦點放進輸入框；複習的回覆被截斷時說明是太長', () => {
      eq([/沒想到提示/.test(note.text), /還沒回覆你的上一句/.test(note.text), note.retry], [true, true, true]);
      eq([/金鑰/.test(keyNote.text), keyNote.retry], [true, false]);
      assert.ok(closeFocus !== 'msg-input', closeFocus);
      assert.ok(/太長，被截斷/.test(cut), cut);
    });
    await ctx.close();
  }
  if (want('3b')) {
    // 取消 while the coach writes a passage (the request is really stopped): the focus goes back to 產生短文.
    const KEY = 'sk-ant-api03-' + 'TESTONLY'.repeat(6) + '-AA';
    const { ctx, page } = await open(base, { viewport: { width: 1000, height: 800 }, serviceWorkers: 'block' }, 'apikey-cancel');
    await giveKey(page, KEY);
    await page.route('https://api.anthropic.com/v1/messages', async route => { await new Promise(r => setTimeout(r, 3000)); return sseReply(route, '{"title":"T","sentences":[{"en":"One.","zh":"一"},{"en":"Two.","zh":"二"},{"en":"Three.","zh":"三"}]}').catch(() => {}); });
    const press = async fk => { await page.focus('[data-fk="' + fk + '"]'); await page.keyboard.press('Enter'); };
    await press('go-shadow');
    await press('sh-gen');
    await page.waitForSelector('[data-fk="sh-gen-stop"]');
    await press('sh-gen-stop');
    await until(page, () => !window.__kaikouTest.S.shGen.busy, null, 4000);
    await page.waitForTimeout(100);
    const r = await page.evaluate(() => ({ focus: document.activeElement && document.activeElement.dataset.fk, passages: window.__kaikouTest.S.shadow.list.length }));
    check('網頁版：寫短文時按取消，焦點回到「產生短文」', () => eq(r, { focus: 'sh-gen', passages: 0 }));
    await ctx.close();
  }

  // ---------- 4. Failure paths in Claude ----------
  if (want('4')) {
    // a. A write fails twice in a row, is retried later and lands.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'retry', { failWrites: { inbox: { n: 2, code: 'unavailable' } } });
    await page.fill('#inbox-input', '要跟主管說延期');
    await page.click('#inbox-form .btn');
    const madeBy = await page.evaluate(() => Date.now());
    await until(page, () => document.querySelector('#sync').textContent === '同步失敗，會自動再試', null, 6000);
    // Meanwhile the change is also kept in this browser (so a page closed now loses nothing); once saved, it goes.
    const kept = await until(page, () => Object.keys(localStorage).some(k => k.startsWith('kaikou:unsent:u_test:') && localStorage.getItem(k).includes('要跟主管說延期')), null, 3000).then(() => true, () => false);
    const stamp = await page.evaluate(() => { const k = Object.keys(localStorage).find(x => x.startsWith('kaikou:unsent:u_test:')); const r = k ? JSON.parse(localStorage.getItem(k)) : {}; return { at: r.at, beat: r.beat }; });
    await until(page, () => document.querySelector('#sync').textContent === '已同步', null, 12000);
    const inbox = await page.evaluate(() => Object.values(window.__store.get('data/users/u_test/inbox').map || {}).map(x => x && x.text));
    await until(page, () => !Object.keys(localStorage).some(k => k.startsWith('kaikou:unsent:')), null, 3000).catch(() => {});
    const left = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('kaikou:unsent:')));
    check('寫入失敗會顯示並自動重試，最後存進雲端；等著重試時這個瀏覽器也記著，存好就清掉', () => {
      assert.ok(inbox.includes('要跟主管說延期'));
      assert.ok(kept, 'the waiting change was not kept in this browser');
      assert.ok(stamp.at <= madeBy && stamp.beat >= stamp.at, 'the record is stamped with the time of the change: ' + JSON.stringify(stamp) + ' made by ' + madeBy);
      eq(left, []);
    });
    await ctx.close();
  }
  if (want('4')) {
    // a2. The record of changes waiting for the cloud can no longer be brought up to date (this browser's storage is
    //     full): it is removed, not left as it was (a later visit would send that older state of them again).
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'unsent-full', { failWrites: { inbox: { n: 99, code: 'unavailable' } } });
    await page.fill('#inbox-input', '第一個等著重試的句子');
    await page.click('#inbox-form .btn');
    await until(page, () => Object.keys(localStorage).some(k => k.startsWith('kaikou:unsent:u_test:') && localStorage.getItem(k).includes('第一個等著重試的句子')), null, 4000);
    await page.evaluate(() => {
      // A record a closed page left (sent here later, while this tab's own record cannot be kept).
      localStorage.setItem('kaikou:unsent:u_test:closed', JSON.stringify({ at: Date.now() - 600000, beat: Date.now() - 600000, docs: { inbox: { map: { uC: { id: 'uC', text: '關掉的頁面留下的句子', at: 3 } } } } }));
      const real = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) { if (String(k).startsWith('kaikou:unsent:')) { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; } return real.call(this, k, v); };
    });
    await page.fill('#inbox-input', '第二個等著重試的句子');
    await page.click('#inbox-form .btn');
    await until(page, () => !Object.keys(localStorage).some(k => k.startsWith('kaikou:unsent:') && !k.endsWith(':closed')), null, 4000).catch(() => {});
    const left = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('kaikou:unsent:') && !k.endsWith(':closed')));
    // The closed page's record is sent, but this tab cannot keep it while it retries: the record stays where it is.
    await ff(page, 181000);
    await page.waitForTimeout(23000); // the upload waits up to 20 seconds for the cloud
    const closed = await page.evaluate(() => !!localStorage.getItem('kaikou:unsent:u_test:closed'));
    check('等著存到雲端的變更記不進這個瀏覽器（空間滿了）：舊的紀錄會刪掉，不會留著讓下次送出過時的內容；這時補存別的頁面留下的變更，那份紀錄留著', () => eq([left, closed], [[], true]));
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
    // Later the viewer is given edit access: 設定 → 再試一次存到雲端 uploads what this browser holds. The first try
    // cannot read the cloud: nothing is sent, the page stays with this browser's copy and says so. A change made while
    // it read (its write was still waiting for a retry) is kept for the next try.
    await page.evaluate(() => { const c = window.__mockCfg; c.readOnly = false; c.failReads = { inbox: 4 }; c.readDelay = { inbox: 600 }; c.failWrites = { settings: { n: 99, code: 'unavailable' } }; c.writeDelay = { settings: 2500 }; });
    await page.click('#btn-settings');
    await page.click('#set-cloud');
    await page.click('[data-fk="slvl-B2"]');
    await page.waitForTimeout(700);
    const auto = await page.evaluate(() => !document.querySelector('#set-auto').checked); // what it is switched to
    await page.click('#set-auto'); // waits behind the level's write
    await until(page, () => /還讀不到雲端的資料/.test(document.querySelector('#toast').textContent), null, 8000).catch(() => {});
    // (The level's write is still on its way when the cloud is left: it is held once it fails, a moment later, and that
    // failure is not reported as one of the cloud's. The other change was still waiting: it is held at once.)
    await until(page, () => { const h = localStorage.getItem('kaikou:held') || ''; return /"level":"B2"/.test(h) && /"autoSpeak"/.test(h); }, null, 6000).catch(() => {});
    const unread = await page.evaluate(() => ({ mode: window.__kaikouTest.Store.mode, button: !document.querySelector('#set-cloud').hidden, toast: document.querySelector('#toast').textContent,
      held: (JSON.parse(localStorage.getItem('kaikou:held') || '{}').docs || {}).settings }));
    await page.evaluate(() => { const c = window.__mockCfg; c.failReads = {}; c.readDelay = {}; c.failWrites = {}; c.writeDelay = {}; });
    await page.click('#set-cloud');
    await until(page, () => window.__kaikouTest.Store.mode === 'db' && !window.__kaikouTest.S.uploading, null, 10000);
    const c = await page.evaluate(() => ({ cloud: Object.values((window.__store.get('data/users/u_test/inbox') || {}).map || {}).map(x => x && x.text), flag: localStorage.getItem('kaikou:no-cloud'), level: (window.__store.get('data/users/u_test/settings') || {}).level, auto: (window.__store.get('data/users/u_test/settings') || {}).autoSpeak }));
    check('之後有了寫入權限：設定裡再試一次，會把這個瀏覽器的資料存到雲端（讀不到雲端時先不搬，按鈕留著，那時改的設定也留著）', () => {
      eq([unread.mode, unread.button, /這次先不搬/.test(unread.toast)], ['local', true, true]);
      eq(unread.held, { level: 'B2', autoSpeak: auto });
      assert.ok(c.cloud.includes('唯讀連結的句子')); eq(c.flag, null); eq([c.level, c.auto], ['B2', auto]);
    });
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
    await pressTwice(page, del);
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
    // A backup made now holds only this browser's data, and says so.
    await page.click('#set-export');
    await until(page, () => window.__downloads.length === 1 && !window.__kaikouTest.S.exporting, null, 8000).catch(() => {});
    const offExport = await page.evaluate(() => document.querySelector('#toast').textContent);
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
      assert.ok(/連不上 Claude 的雲端，檔案裡只有這個瀏覽器裡的資料/.test(offExport), offExport);
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
    await pressTwice(page, '[data-fk="del-' + id + '"]');
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
    await pressTwice(page, '[data-fk="del-' + id + '"]'); // waits behind the slow write
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
    await pressTwice(page, '[data-fk="discard"]');
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
    const dec = await page.evaluate(() => ({ note: document.querySelector('#coach-note span').textContent, perms: !!document.querySelector('#coach-note [data-fk="note-perms"]'), retry: !!document.querySelector('#coach-note [data-fk="retry"]'), send: document.querySelector('#send-btn').disabled, calls: window.__calls.filter(c => c.kind === 'sample').length }));
    await pressTwice(page, '[data-fk="discard"]');
    const menu = await page.evaluate(() => ({ title: document.querySelector('#coach-dyn .card-title').textContent, start: !!document.querySelector('#start-btn'), perms: !!document.querySelector('[data-fk="open-perms"]') }));
    // The Permissions panel does not open: it says where to go instead. Then it opens and the coach is switched on.
    await page.evaluate(() => { window.__mockCfg.permsPanel = 'fail'; });
    await page.click('[data-fk="open-perms"]');
    await until(page, () => /權限設定（Permissions）/.test(document.querySelector('#toast').textContent), null, 4000).catch(() => {});
    const failed = await page.evaluate(() => document.querySelector('#toast').textContent);
    await page.evaluate(() => { window.__mockCfg.permsPanel = ''; });
    await page.click('[data-fk="open-perms"]');
    await until(page, () => !!document.querySelector('#start-btn'), null, 4000).catch(() => {});
    const on = await page.evaluate(() => ({ state: window.__kaikouTest.S.sampleState, start: !!document.querySelector('#start-btn'), opened: window.__permsOpened }));
    check('不允許教練（sample 回 not_granted）：說明怎麼重新允許並提供「開啟權限設定」，不重送也不再呼叫；回到選單時也一樣，打開權限後就能用', () => {
      eq(dec, { note: '這個頁面沒有使用 Claude 的權限，所以教練不能回覆。按「開啟權限設定」把 Claude 打開（也可以從這個頁面的權限選單），再試一次。', perms: true, retry: false, send: true, calls: 1 });
      eq(menu, { title: 'AI 教練目前無法使用', start: false, perms: true });
      assert.ok(/權限設定（Permissions）/.test(failed), failed);
      eq(on, { state: 'ok', start: true, opened: 1 });
    });
    await ctx.close();
  }
  if (want('4')) {
    // l. A view that cannot run the coach or save files (use() resolves null): the chat, the menu, the shadowing tool
    //    and the backup export each say so.
    const { ctx, page } = await open(ARTIFACT + '#coach', { viewport: { width: 1000, height: 800 } }, 'no-caps', { noSample: true, noDownloads: true });
    await until(page, () => window.__kaikouTest.S.sampleState === 'none');
    const chatNote = await page.textContent('#coach-note');
    await pressTwice(page, '[data-fk="discard"]');
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
    //    Two quick taps on 放棄 (the second lands on 確定放棄？, drawn in the same place) do not discard the chat.
    const { ctx, page } = await open(ARTIFACT + '#coach', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, 'touch-focus', { failWrites: {} });
    const where = () => page.evaluate(() => { const a = document.activeElement; return a && (a.id || a.dataset.fk || a.tagName); });
    await page.tap('[data-fk="discard"]');
    await page.tap('[data-fk="discard"]');
    await page.waitForTimeout(150);
    const quick = await page.evaluate(() => !!window.__kaikouTest.S.chat);
    await page.waitForTimeout(600);
    await page.tap('[data-fk="discard"]');
    await page.focus('#start-btn'); // a keyboard or switch user on a tablet starts it from the keyboard
    await page.keyboard.press('Enter');
    const starting = await where();
    await notBusy(page);
    const started = await where();
    await page.focus('#tip-close');
    await page.keyboard.press('Enter');
    const tip = await where();
    check('手機上開始對話之後，焦點不會自己跑到輸入框（不會叫出鍵盤蓋住對話），也不會掉到頁面上：在送出鍵（教練回覆時是停止鍵），收起提示時也一樣；連碰兩下「放棄」不會直接放棄', () => {
      eq(quick, true);
      eq([starting, started, tip], ['send-btn', 'send-btn', 'send-btn']);
    });
    await ctx.close();
  }
  if (want('4')) {
    // t. Buttons that go away or turn off when pressed hand the keyboard focus on (never to the top of the page):
    //    下個月 when it brings back this month, 回到今天, and 取消 while the coach is writing a passage.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'focus-gone', { jsonDelay: 4000 });
    const where = () => page.evaluate(() => { const a = document.activeElement; return !a || a === document.body ? 'BODY' : (a.dataset && a.dataset.fk) || a.className || a.tagName; });
    const press = async fk => { await page.focus('[data-fk="' + fk + '"]'); await page.keyboard.press('Enter'); };
    await page.click('#t-log');
    await press('m-prev');
    await press('m-next');
    const monthNext = await where();
    await press('m-prev');
    await press(await page.evaluate(() => document.querySelector('#log-dyn .day[data-fk]:not([disabled])').dataset.fk));
    await press('back-today');
    const backToday = await where();
    await press('go-shadow');
    await press('sh-gen');
    await page.waitForSelector('[data-fk="sh-gen-stop"]');
    await press('sh-gen-stop');
    await until(page, () => !window.__kaikouTest.S.shGen.busy, null, 4000);
    await page.waitForTimeout(100);
    const genCancel = await where();
    const passages = await page.evaluate(() => window.__kaikouTest.S.shadow.list.length);
    check('按了就不見或變成不能按的按鈕（下個月回到本月、回到今天、寫短文時取消）：焦點移到接下來的地方，不會掉到頁面最上面', () => eq([monthNext, backToday, genCancel, passages], ['month-title', 'date-head', 'sh-gen', 0]));
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
  if (want('4')) {
    // n. The cloud keeps answering "try again later" and the page is closed (here: reloaded) before a retry lands: the
    //    next visit sends what was waiting, and nothing is left over afterwards.
    const month = dayKey(0).slice(0, 7);
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'unsent', { persist: true, failWrites: { inbox: { n: 99, code: 'unavailable' }, ['log-' + month]: { n: 99, code: 'unavailable' }, ['sessions-' + month]: { n: 99, code: 'unavailable' } } }, noFocusRefresh);
    // A chat is reviewed too: its review cannot be saved either, so the chat is not marked finished in the cloud.
    await page.click('#t-coach');
    await page.fill('#msg-input', 'We had dinner by the river');
    await page.click('#send-btn');
    await notBusy(page);
    await page.click('[data-fk="review"]');
    await until(page, () => !!window.__kaikouTest.S.review && !window.__kaikouTest.S.reviewing, null, 10000);
    await page.click('#t-today');
    await page.fill('#inbox-input', '網路不穩時記的句子');
    await page.click('#inbox-form .btn');
    await page.click('#today-dyn .list .item:nth-child(4) .check');
    await until(page, () => document.querySelector('#sync').textContent === '同步失敗，會自動再試', null, 6000);
    await until(page, () => Object.keys(localStorage).some(k => k.startsWith('kaikou:unsent:u_test:') && /網路不穩時記的句子/.test(localStorage.getItem(k)) && /listen/.test(localStorage.getItem(k))), null, 4000);
    await page.addInitScript(() => { window.__mockCfg = Object.assign(window.__mockCfg || {}, { failWrites: {} }); }); // the next visit gets through
    await reloadAfterWrites(page);
    await until(page, () => /補存好了/.test(document.querySelector('#toast').textContent), null, 12000);
    await until(page, () => (window.__store.get('data/users/u_test/chat') || {}).active === false, null, 6000).catch(() => {});
    const r = await page.evaluate(m => {
      const get = n => window.__store.get('data/users/u_test/' + n) || {};
      return { cloud: Object.values(get('inbox').map || {}).map(x => x && x.text).includes('網路不穩時記的句子'), listen: !!((get('log-' + m).days || {})[window.__mockToday] || { items: {} }).items.listen,
        shown: window.__kaikouTest.S.inbox.some(x => x.text === '網路不穩時記的句子'), left: Object.keys(localStorage).filter(k => k.startsWith('kaikou:unsent:')),
        review: !!((get('sessions-' + m).map || {}).c1), chatOpen: !!(window.__kaikouTest.S.chat && window.__kaikouTest.S.chat.id === 'c1'), chatEnded: get('chat').active === false };
    }, month);
    check('變更等著重試時就關掉頁面：下次開啟會補存到雲端（存不進去的對話複習也是，那個對話就算結束），存好後不留紀錄', () => eq(r, { cloud: true, listen: true, shown: true, left: [], review: true, chatOpen: false, chatEnded: true }));
    await ctx.close();
  }
  if (want('4')) {
    // n1. The times kept for each field (records of unsent changes), and the rules for what a record may bring back.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'unsent-times');
    const r = await page.evaluate(() => {
      const X = window.__kaikouTest, paths = [];
      X.leaves({ a: { b: 1, c: {} }, d: null, e: [1], f: { g: { h: 'x' } } }, p => paths.push(p.join('.')));
      const s1 = X.stampTimes({}, { map: { X: { en: 'a', zh: 'b' } } }, 5);
      const s2 = X.stampTimes(X.stampTimes({}, { map: { X: null } }, 3), { map: { X: { zh: 'y' } } }, 7);
      const s3 = X.stampTimes({}, { level: 'B2' }, 10);
      X.mergeTimes(s3, { level: 'A2' }, { level: 5 });
      const kept = X.timeAt(s3, ['level']);
      X.mergeTimes(s3, { level: 'A1' }, { level: 20 });
      const cloud = { phrases: { map: { pOwn: null, pElse: null } }, srs: { map: { pOwn: null, pElse: null } }, inbox: { map: { n1: null } } };
      const docs = { phrases: { map: { pOwn: { en: 'Own.' }, pElse: { en: 'Else.' } } }, srs: { map: { pOwn: { d: '2030-01-01', f: '2030-01-01', t: '2030-01-01' }, pElse: { d: '2030-01-01', f: '2030-01-01', t: '2030-01-01' } } }, inbox: { map: { n1: { text: 'x' }, n2: { text: 'y' } } } };
      const own = { phrases: new Set(['pOwn']), srs: new Set(['pOwn']) };
      const fromCloud = X.heldOver(cloud, docs, true, own), held = X.heldOver(cloud, docs, false);
      return { paths, s1: [X.timeAt(s1, ['map', 'X', 'en']), X.timeAt(s1, ['map', 'X']), X.timeAt(s1, ['map', 'Y'])],
        s2: [X.timeAt(s2, ['map', 'X', 'zh']), X.timeAt(s2, ['map', 'X', 'en']), X.timeAt(s2, ['map', 'X'])], merged: [kept, X.timeAt(s3, ['level'])],
        fromCloud: [Object.keys(fromCloud.phrases.map), Object.keys(fromCloud.srs.map), Object.keys(fromCloud.inbox.map)], held: [Object.keys(held.phrases.map).sort(), Object.keys(held.inbox.map).sort()] };
    });
    check('補存的時間與規則：每個欄位記下改的時間（刪掉後又設的欄位、整個刪掉的時間都算得出來），較晚的時間留著；自己刪過又存回的才會救回，別台刪掉的不會', () => eq(r, {
      paths: ['a.b', 'd', 'e', 'f.g.h'], s1: [5, 5, 0], s2: [7, 3, 7], merged: [10, 20],
      fromCloud: [['pOwn'], ['pOwn'], ['n2']], held: [['pElse', 'pOwn'], ['n1', 'n2']] }));
    await ctx.close();
  }
  if (want('4')) {
    // n5. The record of changes kept in this browser (kaikou:held). Another account's record is left alone. A change
    //     saved to the cloud here replaces what is held for the same fields (with the marks of its items). Of a
    //     snapshot taken before, only what is still held is sent. Once sent, it goes with its marks (a field changed
    //     since stays). With nothing left, the record and this browser's copies go.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'held-take');
    const r = await page.evaluate(() => {
      const X = window.__kaikouTest, K = 'kaikou:held', get = () => JSON.parse(localStorage.getItem(K) || 'null'), put = v => localStorage.setItem(K, JSON.stringify(v));
      const m = 'log-2030-01', day = '2030-01-02';
      const docs = () => ({ inbox: { map: { a: { id: 'a', text: '甲', at: 1 }, b: { id: 'b', text: '乙', at: 2 } } }, [m]: { days: { [day]: { items: { ai: true, listen: true } } } }, settings: { level: 'B2', about: 'x' } });
      const out = {};
      put({ uid: 'u_other', docs: docs(), fresh: { inbox: { a: 1 } }, drop: {} });
      X.takeHeld(docs()); X.heldSuperseded('inbox', { map: { a: null } });
      out.other = get();
      put({ uid: X.Store.uid, docs: docs(), fresh: { inbox: { a: 1, b: 1 }, [m]: { [day + '|ai']: 1, [day + '|listen']: 1 } }, drop: {} });
      X.heldSuperseded('inbox', { map: { a: { id: 'a', text: '甲', at: 1 } } }); // the same note saved to the cloud
      X.heldSuperseded(m, { days: { [day]: { items: { ai: false } } } }); // unticked there
      X.heldSuperseded('settings', { level: 'A2' });
      X.heldSuperseded('phrases', { map: { z: null } }); // nothing held for it
      out.superseded = get();
      out.still = X.stillHeld(docs());
      put({ uid: X.Store.uid, docs: docs(), fresh: { inbox: { a: 1, b: 1 } }, drop: { inbox: { z: 1 } } });
      X.takeHeld(Object.assign(docs(), { settings: { level: 'A2', about: 'x' }, inbox: { map: { a: docs().inbox.map.a } } }));
      out.taken = get();
      X.takeHeld({ inbox: { map: { b: docs().inbox.map.b } }, settings: { level: 'B2' } });
      out.gone = [get()];
      put({ uid: X.Store.uid, docs: { inbox: { map: { b: docs().inbox.map.b } }, settings: { level: 'B2' } }, fresh: { inbox: { b: 1 } }, drop: {} });
      localStorage.setItem('kaikou:inbox', JSON.stringify({ map: {} }));
      X.heldSuperseded('inbox', { map: { b: null } }); // deleted there
      X.heldSuperseded('settings', { level: 'A2' });
      out.gone.push(get(), localStorage.getItem('kaikou:inbox'));
      // A review rated again since the snapshot (e1 → e2, same first review and time): not sent from the snapshot, and
      // kept whole once the snapshot is taken.
      const e1 = { d: '2030-01-09', i: 6, r: 2, l: 0, f: '2030-01-01', t: '2030-01-03', pt: '2030-01-02' }, e2 = { d: '2030-01-04', i: 1, r: 0, l: 1, f: '2030-01-01', t: '2030-01-03', pt: '2030-01-02' };
      put({ uid: X.Store.uid, docs: { srs: { map: { P: e2 } }, inbox: { map: { c: { id: 'c', text: '丙', at: 3 } } } }, fresh: {}, drop: {} });
      out.stillSrs = X.stillHeld({ srs: { map: { P: e1 } } });
      X.takeHeld({ srs: { map: { P: e1 } } });
      out.keptSrs = get().docs.srs.map.P;
      // A passage deleted here: practising it in the cloud does not replace the deletion; saving it again whole does.
      put({ uid: X.Store.uid, docs: { shadow: { map: { Q: null } }, inbox: { map: { c: { id: 'c', text: '丙', at: 3 } } } }, fresh: {}, drop: {} });
      X.heldSuperseded('shadow', { map: { Q: { days: { '2030-01-02': 1 } } } });
      out.delKept = get().docs.shadow;
      X.heldSuperseded('shadow', { map: { Q: { id: 'Q', title: 'T', level: 'B1', at: 5, src: 'ai', sents: [{ en: 'A.', zh: '' }], days: {} } } });
      out.delGone = get().docs.shadow || null;
      return out;
    });
    const m = 'log-2030-01', day = '2030-01-02', A = { id: 'a', text: '甲', at: 1 }, B = { id: 'b', text: '乙', at: 2 };
    check('瀏覽器裡留著的變更：另一個帳號的不動；這裡存到雲端的同一個欄位取代留著的（連同項目的記號；刪掉的項目要整個再存一次才算）；先前的快照只送還留著的、一筆複習紀錄整筆比；送出後拿掉送出的部分和記號，之後又改的欄位留著；什麼都不剩就清掉', () => {
      eq(r.other, { uid: 'u_other', docs: { inbox: { map: { a: A, b: B } }, [m]: { days: { [day]: { items: { ai: true, listen: true } } } }, settings: { level: 'B2', about: 'x' } }, fresh: { inbox: { a: 1 } }, drop: {} });
      eq(r.superseded, { uid: 'u_test', docs: { inbox: { map: { b: B } }, [m]: { days: { [day]: { items: { listen: true } } } }, settings: { about: 'x' } }, fresh: { inbox: { b: 1 }, [m]: { [day + '|listen']: 1 } }, drop: {} });
      eq(r.still, { inbox: { map: { b: B } }, [m]: { days: { [day]: { items: { listen: true } } } }, settings: { about: 'x' } });
      eq(r.taken, { uid: 'u_test', docs: { inbox: { map: { b: B } }, settings: { level: 'B2' } }, fresh: { inbox: { b: 1 } }, drop: { inbox: { z: 1 } } });
      eq(r.gone, [null, null, null]);
      eq([r.stillSrs, r.keptSrs], [{}, { d: '2030-01-04', i: 1, r: 0, l: 1, f: '2030-01-01', t: '2030-01-03', pt: '2030-01-02' }]);
      eq([r.delKept, r.delGone], [{ map: { Q: null } }, null]);
    });
    await ctx.close();
  }
  if (want('4')) {
    // n2. Records left by other tabs of this browser: one whose tab is still open (it holds the lock named after its
    //     record) is left to that tab; the others are sent oldest first, so the later change wins. Once that tab is
    //     closed (its lock goes), its record is sent too.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'unsent-tabs', null, noFocusRefresh);
    await page.evaluate(() => {
      const rec = (min, docs, beatMin) => JSON.stringify({ at: Date.now() - min * 60000, beat: Date.now() - (beatMin || min) * 60000, docs });
      // Stored (and named) in the opposite order of their changes: the storage order says nothing about which came first.
      // The tab with the older change kept trying for longer (its record was renewed later): the change time decides.
      localStorage.setItem('kaikou:unsent:u_test:tab-m', rec(10, { settings: { level: 'A2' } }));
      localStorage.setItem('kaikou:unsent:u_test:tab-z', rec(20, { settings: { level: 'B2' }, inbox: { map: { uA: { id: 'uA', text: '較早關掉的分頁記的句子', at: 5 } } } }, 6));
      localStorage.setItem('kaikou:unsent:u_test:tab-open', rec(30, { inbox: { map: { uO: { id: 'uO', text: '還開著的分頁記的句子', at: 6 } } } }));
      navigator.locks.request('kaikou:unsent:u_test:tab-open', () => new Promise(r => { window.__closeTab = r; }));
    });
    const cloud = () => page.evaluate(() => ({ level: window.__store.get('data/users/u_test/settings').level, inbox: window.__kaikouTest.normInbox(window.__store.get('data/users/u_test/inbox')).map(x => x.text).filter(t => /分頁/.test(t)).sort(), open: !!localStorage.getItem('kaikou:unsent:u_test:tab-open') }));
    await ff(page, 181000); // the page reads everything again every three minutes, then sends what closed pages left
    await until(page, () => !localStorage.getItem('kaikou:unsent:u_test:tab-m') && !localStorage.getItem('kaikou:unsent:u_test:tab-z'), null, 8000).catch(() => {});
    await until(page, () => !window.__kaikouTest.Store.busyDoc('inbox') && !window.__kaikouTest.Store.busyDoc('settings'), null, 6000);
    const a = await cloud();
    await page.evaluate(() => window.__closeTab());
    await ff(page, 181000);
    await until(page, () => !localStorage.getItem('kaikou:unsent:u_test:tab-open'), null, 8000).catch(() => {});
    await until(page, () => !window.__kaikouTest.Store.busyDoc('inbox'), null, 6000);
    const b = await cloud();
    // Another tab is already sending what closed pages left (it holds the account's lock for that): this one leaves
    // it alone, and sends it once that tab is done without having sent it.
    await page.evaluate(() => {
      localStorage.setItem('kaikou:unsent:u_test:tab-x', JSON.stringify({ at: Date.now() - 600000, docs: { inbox: { map: { uX: { id: 'uX', text: '另一個分頁正在補存的句子', at: 7 } } } } }));
      navigator.locks.request('kaikou:unsent:u_test', () => new Promise(r => { window.__doneSending = r; }));
    });
    await ff(page, 181000);
    await page.waitForTimeout(1500);
    const c = await page.evaluate(() => !!localStorage.getItem('kaikou:unsent:u_test:tab-x'));
    await page.evaluate(() => window.__doneSending());
    await ff(page, 181000);
    await until(page, () => !localStorage.getItem('kaikou:unsent:u_test:tab-x'), null, 8000).catch(() => {});
    await until(page, () => !window.__kaikouTest.Store.busyDoc('inbox'), null, 6000);
    const d = await page.evaluate(() => window.__kaikouTest.normInbox(window.__store.get('data/users/u_test/inbox')).some(x => x.text === '另一個分頁正在補存的句子'));
    check('其他分頁留下的待存變更：還開著的分頁的不代送，其他的照變更的先後補存（後來的為準），那個分頁關掉後再補存；另一個分頁正在補存時不重複送', () => {
      eq(a, { level: 'A2', inbox: ['較早關掉的分頁記的句子'], open: true });
      eq(b, { level: 'A2', inbox: ['較早關掉的分頁記的句子', '還開著的分頁記的句子'].sort(), open: false });
      eq([c, d], [true, true]);
    });
    await ctx.close();
  }
  if (want('4')) {
    // n3. Where locks cannot be used, a record counts as left behind only once it has not been brought up to date for
    //     five minutes (a tab with changes still waiting renews its record more often than that).
    const noLocks = "Object.defineProperty(Navigator.prototype, 'locks', { get: () => undefined, configurable: true });";
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'unsent-nolocks', null, noFocusRefresh + noLocks);
    await page.evaluate(() => {
      const rec = (min, docs) => JSON.stringify({ at: Date.now() - min * 60000, docs });
      localStorage.setItem('kaikou:unsent:u_test:recent', rec(1, { inbox: { map: { uR: { id: 'uR', text: '一分鐘前還更新過的紀錄', at: 7 } } } }));
      localStorage.setItem('kaikou:unsent:u_test:stale', rec(30, { inbox: { map: { uS: { id: 'uS', text: '半小時沒更新的紀錄', at: 8 } } } }));
    });
    await ff(page, 181000); // four minutes after its last update: its tab may still be open
    await until(page, () => !localStorage.getItem('kaikou:unsent:u_test:stale'), null, 8000).catch(() => {});
    const a = await page.evaluate(() => ({ recent: !!localStorage.getItem('kaikou:unsent:u_test:recent'), stale: !!localStorage.getItem('kaikou:unsent:u_test:stale') }));
    await ff(page, 181000); // seven minutes: left behind
    await until(page, () => !localStorage.getItem('kaikou:unsent:u_test:recent'), null, 8000).catch(() => {});
    await until(page, () => !window.__kaikouTest.Store.busyDoc('inbox'), null, 6000);
    const b = await page.evaluate(() => ({ recent: !!localStorage.getItem('kaikou:unsent:u_test:recent'), cloud: window.__kaikouTest.normInbox(window.__store.get('data/users/u_test/inbox')).map(x => x.text).filter(t => /紀錄/.test(t)).sort() }));
    // Another tab has claimed the sending (no locks here): this one waits until the claim is gone.
    await page.evaluate(() => {
      localStorage.setItem('kaikou:unsent:u_test:stale2', JSON.stringify({ at: Date.now() - 1800000, beat: Date.now() - 1800000, docs: { inbox: { map: { uT: { id: 'uT', text: '另一個分頁正在補存的紀錄', at: 9 } } } } }));
      localStorage.setItem('kaikou:unsent-claim:u_test', JSON.stringify({ k: 'kaikou:unsent:u_test:other', until: Date.now() + 600000 }));
    });
    await ff(page, 181000);
    await page.waitForTimeout(1500);
    const c = await page.evaluate(() => !!localStorage.getItem('kaikou:unsent:u_test:stale2'));
    await page.evaluate(() => localStorage.removeItem('kaikou:unsent-claim:u_test'));
    await ff(page, 181000);
    await until(page, () => !localStorage.getItem('kaikou:unsent:u_test:stale2'), null, 8000).catch(() => {});
    const d = await page.evaluate(() => !localStorage.getItem('kaikou:unsent:u_test:stale2'));
    // A second tab of this browser keeps failing to save: it keeps renewing its record, so it is left to that tab
    // while it is open; once it is closed, its record is sent here.
    const p2 = await addPage(ctx, ARTIFACT, 'unsent-nolocks-2', { failWrites: { inbox: { n: 99, code: 'unavailable' } } }, noFocusRefresh + noLocks);
    await p2.fill('#inbox-input', '另一個分頁一直存不進去的句子');
    await p2.click('#inbox-form .btn');
    await until(p2, () => Object.keys(localStorage).some(k => k.startsWith('kaikou:unsent:u_test:') && /一直存不進去/.test(localStorage.getItem(k))), null, 6000);
    await ff(page, 181000);
    await ff(page, 181000);
    await page.waitForTimeout(1500);
    const live = await page.evaluate(() => ({ kept: Object.keys(localStorage).some(k => k.startsWith('kaikou:unsent:u_test:') && /一直存不進去/.test(localStorage.getItem(k))), sent: window.__kaikouTest.normInbox(window.__store.get('data/users/u_test/inbox')).some(x => /一直存不進去/.test(x.text)) }));
    await p2.close();
    await ff(page, 181000);
    await ff(page, 181000);
    await until(page, () => window.__kaikouTest.normInbox(window.__store.get('data/users/u_test/inbox')).some(x => /一直存不進去/.test(x.text)), null, 8000).catch(() => {});
    const after = await page.evaluate(() => window.__kaikouTest.normInbox(window.__store.get('data/users/u_test/inbox')).some(x => /一直存不進去/.test(x.text)));
    check('不能用鎖的瀏覽器：五分鐘內還更新過的待存紀錄先不代送，超過五分鐘沒更新才補存；別的分頁正在補存時等它；一直重試的分頁開著時不代送，關掉後才補存', () => {
      eq(a, { recent: true, stale: false });
      eq(b, { recent: false, cloud: ['一分鐘前還更新過的紀錄', '半小時沒更新的紀錄'].sort() });
      eq([c, d], [true, true]);
      eq([live, after], [{ kept: true, sent: false }, true]);
    });
    await ctx.close();
  }
  if (want('4')) {
    // n4. A change on its way to the cloud for the first time is not kept as unsent: the page is closed before the
    //     answer comes, but the write lands anyway (the host carries it out). Another device changes the same setting
    //     afterwards; the next visit here does not send the old value again over it.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'unsent-landed', { persist: true, writeLandsFirst: true, writeDelay: { settings: 4000 } }, noFocusRefresh);
    await page.click('#btn-settings');
    await page.click('[data-fk="slvl-B2"]');
    await page.click('#set-done');
    await until(page, () => window.__store.get('data/users/u_test/settings').level === 'B2', null, 4000);
    await page.evaluate(() => { const k = 'data/users/u_test/settings'; window.__store.set(k, Object.assign({}, window.__store.get(k), { level: 'A2' })); window.__saveStore(); });
    await page.addInitScript(() => { window.__mockCfg = Object.assign(window.__mockCfg || {}, { writeLandsFirst: false, writeDelay: {} }); });
    await reloadAfterWrites(page);
    await page.waitForTimeout(1500);
    const r = await page.evaluate(() => ({ cloud: window.__store.get('data/users/u_test/settings').level, shown: window.__kaikouTest.S.settings.level, left: Object.keys(localStorage).filter(k => k.startsWith('kaikou:unsent:')) }));
    check('第一次送出的變更不當成「還沒存到」記下：頁面關掉時它照樣存好、之後別台又改了同一個設定，下次開啟不會把舊的值送回去', () => eq(r, { cloud: 'A2', shown: 'A2', left: [] }));
    await ctx.close();
  }
  if (want('4')) {
    // u. A record left behind holds changes made on the cloud's own documents: a phrase rated twice today keeps its
    //    second rating; a phrase that tab had deleted itself and then saved again comes back, but a phrase, a note or a
    //    passage deleted on another device in the meantime stays deleted. (Records are put in place while the page runs
    //    and sent at the next refresh: a page loaded right after another wrote to the storage may not see the write.)
    const seed = `window.__mockSeed = (store, P, dk) => {
      const t = dk(new Date());
      store.set(P('srs'), { map: { p1: { d: t, i: 0, r: 0, l: 1, f: '2026-09-01', t: t, pt: '2026-09-20' }, pBack: null, pGone: null } });
      const ph = store.get(P('phrases')); ph.map = { pBack: null, pGone: null }; store.set(P('phrases'), ph);
      const ib = store.get(P('inbox')); ib.map = { nGone: null }; store.set(P('inbox'), ib);
      store.set(P('shadow'), { cur: '', map: { sGone: null } });
    };`;
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'unsent-rules', null, noFocusRefresh + seed);
    await page.evaluate(() => {
      const t = window.__mockToday, d2 = new Date(t + 'T12:00:00'); d2.setDate(d2.getDate() + 2);
      const due = d2.getFullYear() + '-' + String(d2.getMonth() + 1).padStart(2, '0') + '-' + String(d2.getDate()).padStart(2, '0');
      const ago = Date.now() - 600000, phrase = (id, en) => ({ id, en, zh: '', note: '', ex: '', src: 'fix', at: Date.now() - 700000 });
      localStorage.setItem('kaikou:unsent:u_test:closed', JSON.stringify({ at: ago, beat: ago, docs: {
        srs: { map: { p1: { d: due, i: 2, r: 1, l: 1, f: '2026-09-01', t, pt: '2026-09-20' }, pBack: { d: due, i: 2, r: 1, l: 0, f: t, t }, pGone: { d: due, i: 2, r: 1, l: 0, f: t, t } } },
        phrases: { map: { pBack: phrase('pBack', 'A phrase saved again after it was removed.'), pGone: phrase('pGone', 'A phrase removed on another device.') } },
        inbox: { map: { nGone: { id: 'nGone', text: '別台裝置刪掉的隨手記', at: 3 }, nNew: { id: 'nNew', text: '還沒存到的隨手記', at: 4 } } },
        shadow: { cur: 'sGone', map: { sGone: { days: { [t]: 1 } } } } }, del: { phrases: ['pBack'], srs: ['pBack'] } }));
    });
    await ff(page, 181000); // the page reads everything again every three minutes, then sends what closed pages left
    await until(page, () => !localStorage.getItem('kaikou:unsent:u_test:closed'), null, 8000).catch(() => {});
    await until(page, () => ['srs', 'phrases', 'inbox', 'shadow'].every(n => !window.__kaikouTest.Store.busyDoc(n)), null, 6000);
    const r = await page.evaluate(() => {
      const get = n => window.__store.get('data/users/u_test/' + n) || {};
      const srs = get('srs').map, ph = get('phrases').map, ib = get('inbox').map, sh = get('shadow'), shown = id => window.__kaikouTest.S.phrases.some(p => p.id === id);
      return { p1: [srs.p1.i, srs.p1.r], back: [!!(ph.pBack && ph.pBack.en), !!srs.pBack, shown('pBack')], gone: [ph.pGone, srs.pGone, shown('pGone')],
        notes: [ib.nGone, !!ib.nNew], shadow: [sh.map.sGone, sh.cur], left: !!localStorage.getItem('kaikou:unsent:u_test:closed') };
    });
    check('補存上次沒存到的變更：同一天又評了一次的句子用後來的評分；自己刪掉後又收藏的句子會回來，別台裝置刪掉的句子、隨手記、跟讀短文不會被救回', () =>
      eq(r, { p1: [2, 1], back: [true, true, true], gone: [null, null, false], notes: [null, true], shadow: [null, ''], left: false }));
    await ctx.close();
  }
  if (want('4')) {
    // v. Sending a record left behind reads the documents first; a change made here meanwhile (saved before that read
    //    is over) stays on screen, and the same setting changed here meanwhile is not set back.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'unsent-edit', null, noFocusRefresh);
    await page.evaluate(() => {
      localStorage.setItem('kaikou:unsent:u_test:closed', JSON.stringify({ at: Date.now() - 600000, beat: Date.now() - 600000, docs: {
        inbox: { map: { uY: { id: 'uY', text: '紀錄裡的句子', at: 2 } } },
        phrases: { map: { pY: { id: 'pY', en: 'A phrase from the record.', zh: '', note: '', ex: '', src: 'fix', at: 9 } } },
        settings: { level: 'A2' } } }));
      window.__mockCfg.readDelay = { phrases: [20, 20, 1500] }; // read 1: at the start, 2: the refresh, 3: before sending
    });
    await ff(page, 181000);
    await until(page, () => (window.__readStarts || {}).phrases >= 3, null, 6000);
    await page.fill('#inbox-input', '補存時剛記的句子');
    await page.click('#inbox-form .btn');
    await page.click('#btn-settings');
    await page.click('[data-fk="slvl-B2"]');
    await page.click('#set-done');
    await until(page, () => window.__kaikouTest.normInbox(window.__store.get('data/users/u_test/inbox')).some(x => x.text === '補存時剛記的句子') && window.__store.get('data/users/u_test/settings').level === 'B2', null, 4000);
    await until(page, () => !localStorage.getItem('kaikou:unsent:u_test:closed'), null, 8000).catch(() => {});
    await until(page, () => ['inbox', 'phrases', 'settings'].every(n => !window.__kaikouTest.Store.busyDoc(n)), null, 6000);
    const r = await page.evaluate(() => ({ shown: window.__kaikouTest.S.inbox.map(x => x.text).filter(t => /句子/.test(t)).sort(), list: document.querySelector('#inbox-list').textContent.includes('補存時剛記的句子'), phrase: window.__kaikouTest.S.phrases.some(p => p.id === 'pY'),
      level: [window.__store.get('data/users/u_test/settings').level, window.__kaikouTest.S.settings.level] }));
    check('補存上次沒存到的變更時，同時新記下的句子不會從畫面上消失，同時改的設定也不會被改回去', () => eq(r, { shown: ['紀錄裡的句子', '補存時剛記的句子'].sort(), list: true, phrase: true, level: ['B2', 'B2'] }));
    await ctx.close();
  }
  if (want('4')) {
    // w. The cloud stops (access withdrawn) while a record left behind is being read against: nothing of it was sent,
    //    so it stays, and the next visit that can use the cloud sends it.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'unsent-stop', { persist: true }, noFocusRefresh);
    // The record's tab counts as open while this page is (it holds the lock named after the record): it is not sent yet.
    await page.evaluate(() => new Promise(res => { navigator.locks.request('kaikou:unsent:u_test:closed', () => { res(); return new Promise(() => {}); }); }));
    await page.evaluate(() => {
      localStorage.setItem('kaikou:unsent:u_test:closed', JSON.stringify({ at: Date.now() - 600000, beat: Date.now() - 600000, docs: {
        inbox: { map: { uX: { id: 'uX', text: '雲端停止前要補存的句子', at: 1 } } },
        phrases: { map: { pX: { id: 'pX', en: 'Another phrase from the record.', zh: '', note: '', ex: '', src: 'fix', at: 9 } } } } }));
    });
    // The page opens again (the lock is let go): the record is sent again at once, and its read of the phrases is slow.
    await page.addInitScript(() => { window.__mockCfg = Object.assign(window.__mockCfg || {}, { readDelay: { phrases: [20, 3000] }, failWrites: { settings: { n: 1, code: 'revoked' } } }); });
    await reloadAfterWrites(page);
    await until(page, () => (window.__readStarts || {}).phrases >= 2, null, 6000);
    await page.click('#btn-settings');
    await page.click('[data-fk="slvl-B2"]');
    await page.click('#set-done');
    await until(page, () => window.__kaikouTest.Store.mode === 'local', null, 6000);
    await page.waitForTimeout(3300); // the read is over by now
    const inCloud = () => page.evaluate(() => ({ left: !!localStorage.getItem('kaikou:unsent:u_test:closed'), cloud: window.__kaikouTest.normInbox(window.__store.get('data/users/u_test/inbox')).some(x => x.text === '雲端停止前要補存的句子') }));
    const a = await inCloud();
    // A backup made now has only this browser's data, and says so.
    await page.click('#btn-settings');
    await page.click('#set-export');
    await until(page, () => window.__downloads.length === 1, null, 8000);
    const exported = await page.evaluate(() => document.querySelector('#toast').textContent);
    await page.click('#set-done');
    await page.addInitScript(() => { window.__mockCfg = Object.assign(window.__mockCfg || {}, { readDelay: {}, failWrites: {} }); });
    await reloadAfterWrites(page);
    await until(page, () => !localStorage.getItem('kaikou:unsent:u_test:closed'), null, 8000).catch(() => {});
    await until(page, () => !window.__kaikouTest.Store.busyDoc('inbox'), null, 6000);
    const b = await inCloud();
    check('補存到一半雲端停止：紀錄留著（沒送出也沒刪掉），下次能用雲端時再補存；這時匯出的備份檔說明只有這個瀏覽器的資料', () => {
      eq(a, { left: true, cloud: false }); eq(b, { left: false, cloud: true });
      assert.ok(/雲端同步停止了/.test(exported), exported);
    });
    await ctx.close();
  }
  if (want('4')) {
    // x. Field by field, the later change wins. A record left behind cannot be sent at first (a read fails); meanwhile
    //    the same setting is changed here, later than in the record: that change stays. A record whose change is later
    //    than the one made here wins, also over one sent again here earlier from an older record.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'unsent-later', null, noFocusRefresh);
    const plant = (key, level, msAgo, extra, levelAgo) => page.evaluate(([k, l, ago, x, lAgo]) => {
      const at = Date.now() - ago;
      localStorage.setItem(k, JSON.stringify({ at, beat: at, docs: Object.assign({ settings: { level: l } }, x || {}), times: { settings: { level: lAgo ? Date.now() - lAgo : at } } }));
    }, [key, level, msAgo, extra, levelAgo]);
    const level = () => page.evaluate(() => [window.__store.get('data/users/u_test/settings').level, window.__kaikouTest.S.settings.level]);
    await plant('kaikou:unsent:u_test:closed', 'A2', 600000, { inbox: { map: { uL: { id: 'uL', text: '關掉的頁面晚一點才補存的句子', at: 3 } } } });
    await page.evaluate(() => { window.__mockCfg.failReads = { settings: 4 }; });
    await ff(page, 181000);
    await until(page, () => window.__mockCfg.failReads.settings === 0, null, 8000);
    await page.waitForTimeout(500);
    const kept = await page.evaluate(() => !!localStorage.getItem('kaikou:unsent:u_test:closed'));
    await page.click('#btn-settings');
    await page.click('[data-fk="slvl-B2"]');
    await page.click('#set-done');
    await until(page, () => window.__store.get('data/users/u_test/settings').level === 'B2' && !window.__kaikouTest.Store.busyDoc('settings'), null, 6000);
    const sendNext = async () => { await ff(page, 181000); await until(page, () => !Object.keys(localStorage).some(k => k.startsWith('kaikou:unsent:u_test:') && /closed|later|newest|mixed|older-field|newer-field/.test(k)), null, 8000).catch(() => {}); await until(page, () => !window.__kaikouTest.Store.busyDoc('settings') && !window.__kaikouTest.Store.busyDoc('inbox'), null, 6000); };
    await sendNext();
    const a = await level();
    const note = await page.evaluate(() => window.__kaikouTest.normInbox(window.__store.get('data/users/u_test/inbox')).some(x => x.id === 'uL'));
    // Another tab (open at the same time, closed since) changed the level a minute ago, later than here: its change wins.
    await plant('kaikou:unsent:u_test:later', 'A2', 60000);
    await sendNext();
    const b = await level();
    // One more, changed half a minute ago: later than the one this page just sent again (which keeps its own time).
    await plant('kaikou:unsent:u_test:newest', 'B1', 30000);
    await sendNext();
    const c = await level();
    // A record changed something else a moment ago, but its level long ago: each field keeps its own time.
    await plant('kaikou:unsent:u_test:mixed', 'A2', 10000, { inbox: { map: { uM: { id: 'uM', text: '剛剛記的句子', at: 5 } } } }, 1200000);
    await sendNext();
    const d = await level();
    const noteM = await page.evaluate(() => window.__kaikouTest.normInbox(window.__store.get('data/users/u_test/inbox')).some(x => x.id === 'uM'));
    // Two records at once: the one saved last changed the level earlier than the other one did.
    await plant('kaikou:unsent:u_test:older-field', 'A2', 60000, { inbox: { map: { uO: { id: 'uO', text: '一分鐘前記的句子', at: 6 } } } }, 240000);
    await plant('kaikou:unsent:u_test:newer-field', 'B2', 120000, null, 120000);
    await sendNext();
    const e = await level();
    check('同一個欄位以比較晚的變更為準（每個欄位比自己的時間）：別的頁面留下的變更晚一點才補存時，這裡在那之後改的設定不會被蓋回去；另一個同時開著的分頁改得比較晚，就用它的', () =>
      eq([kept, a, note, b, c, d, noteM, e], [true, ['B2', 'B2'], true, ['A2', 'A2'], ['B1', 'B1'], ['B1', 'B1'], true, ['B2', 'B2']]));
    await ctx.close();
  }
  if (want('4')) {
    // y. 存到雲端 is pressed for changes kept from an earlier visit, and the page is closed before they land: they are
    //    kept as this tab's unsent changes, so the next visit sends them, and it does not offer them again.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'held-closed', { persist: true, failWrites: { inbox: { n: 1, code: 'revoked' } } }, noFocusRefresh);
    await page.fill('#inbox-input', '存到雲端時關掉頁面的句子');
    await page.click('#inbox-form .btn');
    await until(page, () => /存到雲端時關掉頁面的句子/.test(localStorage.getItem('kaikou:held') || ''), null, 6000);
    await page.addInitScript(() => { window.__mockCfg = Object.assign(window.__mockCfg || {}, { failWrites: {}, writeDelay: { inbox: 8000 } }); });
    await reloadAfterWrites(page);
    await until(page, () => !!document.querySelector('[data-fk="held-up"]'), null, 6000);
    await page.click('[data-fk="held-up"]');
    // Still on its way (the cloud answers slowly), not failed: kept all the same.
    await until(page, () => Object.keys(localStorage).some(k => k.startsWith('kaikou:unsent:u_test:') && /存到雲端時關掉頁面的句子/.test(localStorage.getItem(k))), null, 3000);
    const held = await page.evaluate(() => localStorage.getItem('kaikou:held'));
    await page.addInitScript(() => { window.__mockCfg = Object.assign(window.__mockCfg || {}, { writeDelay: {} }); });
    await reloadAfterWrites(page);
    await until(page, () => window.__kaikouTest.normInbox(window.__store.get('data/users/u_test/inbox')).some(x => x.text === '存到雲端時關掉頁面的句子'), null, 10000).catch(() => {});
    const r = await page.evaluate(() => ({ cloud: window.__kaikouTest.normInbox(window.__store.get('data/users/u_test/inbox')).some(x => x.text === '存到雲端時關掉頁面的句子'), offer: !!document.querySelector('[data-fk="held-up"]'), held: localStorage.getItem('kaikou:held') }));
    check('按「存到雲端」後還沒存完就關掉頁面：下次開啟會補存，不會再提醒一次（也不會讓「捨棄」看起來還有用）', () => eq([held, r], [null, { cloud: true, offer: false, held: null }]));
    await ctx.close();
  }
  if (want('4')) {
    // z. The settings could not be read, then the cloud stops: 關於我 stays closed for the rest of the visit (the copy
    //    kept in this browser would only have the defaults, and typing would later replace the stored text).
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'settings-lost', { failReads: { settings: 2 }, failWrites: { inbox: { n: 1, code: 'revoked' } } }, noFocusRefresh);
    await page.fill('#inbox-input', '設定讀不到時記的句子');
    await page.click('#inbox-form .btn');
    await until(page, () => window.__kaikouTest.Store.mode === 'local', null, 6000);
    await page.click('#btn-settings');
    await page.waitForTimeout(500);
    await page.click('#set-about');
    await page.keyboard.type('I am a nurse.');
    await page.waitForTimeout(800);
    const r = await page.evaluate(() => { const t = document.querySelector('#set-about'); const h = JSON.parse(localStorage.getItem('kaikou:held') || '{}'); return { ro: t.readOnly, value: t.value, hint: /讀不到你的設定/.test(t.placeholder), held: !!((h.docs || {}).settings || {}).about, copy: localStorage.getItem('kaikou:settings') }; });
    check('設定讀不到時雲端又停止：這次「關於我」都不能改，不會把預設值當成你的設定存下來', () => eq(r, { ro: true, value: '', hint: true, held: false, copy: null }));
    await ctx.close();
  }
  if (want('4')) {
    // z2. The same, for a viewer whose link could not write: once 再試一次存到雲端 works, the settings are read from
    //     the cloud and 關於我 can be changed again.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'settings-lost-retry', { owner: false, readOnlyWrites: true, failReads: { settings: 2 } }, noFocusRefresh);
    await page.fill('#inbox-input', '檢視者記的句子');
    await page.click('#inbox-form .btn');
    await until(page, () => window.__kaikouTest.Store.mode === 'local', null, 6000);
    await page.evaluate(() => { window.__mockCfg.readOnlyWrites = false; });
    await page.click('#btn-settings');
    const before = await page.evaluate(() => document.querySelector('#set-about').readOnly);
    await page.click('#set-cloud');
    await until(page, () => window.__kaikouTest.Store.mode === 'db' && !window.__kaikouTest.S.uploading, null, 10000);
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => { const t = document.querySelector('#set-about'); return { ro: t.readOnly, value: t.value }; });
    check('讀不到設定時雲端又停止、之後再試一次存到雲端成功：設定重新讀到，「關於我」又可以改', () => eq([before, r], [true, { ro: false, value: 'I live in Taipei and work in marketing.' }]));
    await ctx.close();
  }
  if (want('4')) {
    // z5. 再試一次存到雲端 while another tab of this browser (still unable to save) keeps a new note: once the upload is
    //     done, that note is offered (存到雲端); what was uploaded is not offered again.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'retry-more', { owner: false, readOnlyWrites: true }, noFocusRefresh);
    await page.fill('#inbox-input', '檢視者記的句子');
    await page.click('#inbox-form .btn');
    await until(page, () => window.__kaikouTest.Store.mode === 'local', null, 6000);
    await until(page, () => /檢視者記的句子/.test(localStorage.getItem('kaikou:held') || ''), null, 4000);
    await page.evaluate(() => { const c = window.__mockCfg; c.readOnlyWrites = false; c.readDelay = { inbox: 800 }; });
    await page.click('#btn-settings');
    await page.click('#set-cloud');
    await page.waitForTimeout(250); // the cloud is being read
    await page.evaluate(() => { const h = JSON.parse(localStorage.getItem('kaikou:held')); h.docs.inbox.map.other1 = { id: 'other1', text: '另一個分頁剛記的句子', at: Date.now() }; (h.fresh.inbox = h.fresh.inbox || {}).other1 = 1; localStorage.setItem('kaikou:held', JSON.stringify(h)); });
    await until(page, () => /已改用雲端儲存/.test(document.querySelector('#toast').textContent), null, 10000);
    await page.click('#set-done');
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => ({ offer: !!document.querySelector('[data-fk="held-up"]'), held: Object.values(((JSON.parse(localStorage.getItem('kaikou:held') || '{}').docs || {}).inbox || { map: {} }).map).map(x => x && x.text),
      cloud: window.__kaikouTest.normInbox(window.__store.get('data/users/u_test/inbox')).map(x => x.text).filter(t => t === '檢視者記的句子' || t === '另一個分頁剛記的句子') }));
    check('再試一次存到雲端時另一個分頁又記了一句：上傳完之後提醒裡出現那一句（可以存到雲端），已經上傳的不會再提', () => eq(r, { offer: true, held: ['另一個分頁剛記的句子'], cloud: ['檢視者記的句子'] }));
    await ctx.close();
  }
  if (want('4')) {
    // z3. A page that is being hidden (a phone switching apps, which may freeze or close it at any moment): a change
    //     whose first write fails then is kept as unsent at once, without the usual short wait.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'unsent-hidden', { failWrites: { inbox: { n: 99, code: 'unavailable' } } }, noFocusRefresh);
    await page.fill('#inbox-input', '切到別的 App 前記的句子');
    await page.click('#inbox-form .btn');
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(250);
    const kept = await page.evaluate(() => Object.keys(localStorage).some(k => k.startsWith('kaikou:unsent:u_test:') && /切到別的 App 前記的句子/.test(localStorage.getItem(k))));
    check('頁面被切到背景時第一次寫入就失敗：馬上記成還沒存到雲端的變更（手機可能隨時把頁面凍結或關掉）', () => eq(kept, true));
    await ctx.close();
  }
  if (want('4')) {
    // o. A member who was moved down to Viewer: their documents still read, but every write is refused. The page
    //    says so and keeps working from this browser (not "too large, delete something").
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'downgraded', { readOnlyWrites: true, owner: false });
    await page.fill('#inbox-input', '降為檢視者後記的句子');
    await page.click('#inbox-form .btn');
    await until(page, () => document.querySelector('#sync').textContent === '只存在這個瀏覽器', null, 6000);
    await until(page, () => /降為檢視者後記的句子/.test(localStorage.getItem('kaikou:inbox') || ''), null, 3000);
    const r = await page.evaluate(() => ({ toast: document.querySelector('#toast').textContent, mode: window.__kaikouTest.Store.mode, local: window.__kaikouTest.normInbox(JSON.parse(localStorage.getItem('kaikou:inbox'))).map(x => x.text).sort() }));
    check('被改成檢視者（讀得到、寫不進）：說明改存這個瀏覽器，不會說資料太大；雲端原有的也一起留在這裡', () => {
      eq([r.toast, r.mode], ['這個連結不能把進度存到雲端，改存在這個瀏覽器。', 'local']);
      eq(r.local, ['我們需要再確認一下預算', '降為檢視者後記的句子', '這個功能下週才能上線'].sort());
    });
    await ctx.close();
  }
  if (want('4')) {
    // p. Another device sets a document back to what this page read before its own change: the next refresh shows it.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'revert', null, noFocusRefresh);
    await page.click('#btn-settings');
    await page.click('[data-fk="slvl-B2"]');
    await page.click('#set-done');
    await until(page, () => window.__store.get('data/users/u_test/settings').level === 'B2' && !window.__kaikouTest.Store.busyDoc('settings'), null, 6000);
    await page.evaluate(() => { const k = 'data/users/u_test/settings'; window.__store.set(k, Object.assign({}, window.__store.get(k), { level: 'B1' })); });
    await ff(page, 181000); // the page reads everything again every three minutes
    await until(page, () => window.__kaikouTest.S.settings.level === 'B1', null, 6000).catch(() => {});
    const level = await page.evaluate(() => window.__kaikouTest.S.settings.level);
    check('別台裝置把資料改回這台之前讀到的樣子：重新讀取時照樣更新', () => eq(level, 'B1'));
    await ctx.close();
  }
  if (want('4')) {
    // q. The settings could not be read: 關於我 is not shown as empty and editable (typing would replace the saved
    //    text); opening 設定 reads them again, and once read, they are shown.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'settings-unread', { failReads: { settings: 4 } }, noFocusRefresh);
    await page.click('#btn-settings');
    await until(page, () => window.__mockCfg.failReads.settings === 0, null, 6000);
    await page.waitForTimeout(300);
    const a = await page.evaluate(() => { const t = document.querySelector('#set-about'); return { ro: t.readOnly, value: t.value, hint: t.placeholder }; });
    await page.click('#set-about');
    await page.keyboard.type('Overwrite');
    await page.waitForTimeout(700);
    const cloud = await page.evaluate(() => window.__store.get('data/users/u_test/settings').about);
    // The box keeps the focus while the next read succeeds: it then shows the stored text and can be edited.
    await ff(page, 181000);
    await until(page, () => window.__kaikouTest.S.settingsRead, null, 6000);
    await page.waitForTimeout(200);
    const b = await page.evaluate(() => { const t = document.querySelector('#set-about'); return { ro: t.readOnly, value: t.value, focused: document.activeElement === t }; });
    await page.keyboard.press('End');
    await page.keyboard.type(' I like hiking.');
    await until(page, () => /hiking/.test(window.__store.get('data/users/u_test/settings').about), null, 4000).catch(() => {});
    // A later read that fails changes nothing: the box stays as it is, and what is typed is still saved.
    await page.evaluate(() => { window.__mockCfg.failReads.settings = 2; });
    await ff(page, 181000);
    await until(page, () => window.__mockCfg.failReads.settings === 0, null, 6000);
    await page.waitForTimeout(200);
    const c = await page.evaluate(() => { const t = document.querySelector('#set-about'); return { ro: t.readOnly, value: t.value }; });
    await page.keyboard.type(' And tea.');
    await until(page, () => /tea/.test(window.__store.get('data/users/u_test/settings').about), null, 4000).catch(() => {});
    const saved = await page.evaluate(() => window.__store.get('data/users/u_test/settings').about);
    check('讀不到設定時：關於我先不能改（不會蓋掉雲端的），讀到之後照常顯示（游標還在框裡也一樣），之後再讀不到也照常能改', () => {
      eq([a.ro, a.value, /還讀不到你的設定/.test(a.hint)], [true, '', true]);
      eq(cloud, 'I live in Taipei and work in marketing.');
      eq(b, { ro: false, value: 'I live in Taipei and work in marketing.', focused: true });
      eq(c, { ro: false, value: 'I live in Taipei and work in marketing. I like hiking.' });
      eq(saved, 'I live in Taipei and work in marketing. I like hiking. And tea.');
    });
    await ctx.close();
  }
  if (want('4')) {
    // r. 存到雲端 while a month could not be read before: the upload reads the cloud again first, so the days this
    //    page never showed stay as the cloud has them (and a later tick on such a day keeps its plan).
    const yk = dayKey(-1), month = yk.slice(0, 7);
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'upload-unread', { persist: true, failWrites: { inbox: { n: 1, code: 'revoked' } } });
    await page.fill('#inbox-input', '先存在瀏覽器的句子');
    await page.click('#inbox-form .btn');
    await until(page, () => !!localStorage.getItem('kaikou:held'), null, 6000);
    // Held: a tick on a day the cloud has (yesterday) whose month will not be readable at the next visit's start.
    await page.evaluate(([m, k]) => { const h = JSON.parse(localStorage.getItem('kaikou:held')); h.docs['log-' + m] = { days: { [k]: { items: { chunk: true } } } }; localStorage.setItem('kaikou:held', JSON.stringify(h)); }, [month, yk]);
    await page.addInitScript(m => { window.__mockCfg = Object.assign(window.__mockCfg || {}, { failWrites: {}, failReads: { ['log-' + m]: 2 } }); }, month);
    await reloadAfterWrites(page);
    await until(page, () => !!document.querySelector('[data-fk="held-up"]'), null, 6000);
    await page.click('[data-fk="held-up"]');
    await until(page, () => !window.__kaikouTest.S.held && !window.__kaikouTest.S.uploading, null, 10000);
    const r = await page.evaluate(([m, k]) => {
      const X = window.__kaikouTest, days = X.S.logs[m].days, cloud = window.__store.get('data/users/u_test/log-' + m).days;
      return { shown: Object.keys(cloud).every(d => d in days), y: !!(days[k] && days[k].items.chunk && days[k].items.shadow), plan: (days[k] || {}).plan, read: !X.S.loadErrors.has('log-' + m) };
    }, [month, yk]);
    check('先前讀不到某個月時按「存到雲端」：會先重新讀取，這個月雲端上的其他日子照樣顯示，計畫不被改掉', () => eq(r, { shown: true, y: true, plan: '20', read: true }));
    await ctx.close();
  }
  if (want('4')) {
    // s. This browser keeps another account's changes (its record and copies) when a viewer whose link cannot write
    //    gets access later: 再試一次存到雲端 puts none of them in this viewer's cloud, and leaves them for that account.
    //    The page starts again from the cloud, so nothing it showed of them (an open chat, a review) is written there.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'other-account', { readOnly: true, owner: false });
    await page.fill('#inbox-input', '這個帳號的句子');
    await page.click('#inbox-form .btn');
    await until(page, () => document.querySelector('#sync').textContent === '只存在這個瀏覽器', null, 6000);
    await page.evaluate(() => {
      const now = Date.now(), m = window.__mockToday.slice(0, 7);
      localStorage.setItem('kaikou:held', JSON.stringify({ uid: 'u_other', docs: { inbox: { map: { oX: { id: 'oX', text: '另一個帳號的句子', at: 5 } } } }, fresh: {}, drop: {} }));
      const inbox = JSON.parse(localStorage.getItem('kaikou:inbox') || '{}'); inbox.map = Object.assign({}, inbox.map, { oX: { id: 'oX', text: '另一個帳號的句子', at: 5 } });
      localStorage.setItem('kaikou:inbox', JSON.stringify(inbox));
      localStorage.setItem('kaikou:chat', JSON.stringify({ active: true, id: 'oChat', mode: 'free', level: 'B1', topicZh: '另一個帳號', topicEn: 'other', sceneZh: '', sceneEn: '', aiRole: '', meRole: '', startedAt: now - 60000, updatedAt: now - 1000, lastAt: now - 1000, activeMs: 50000, meCount: 1,
        turns: [{ r: 'c', t: 'OTHER-ACCOUNT opening', raw: 'OTHER-ACCOUNT opening\n###\n{"none": true}', at: now - 60000 }, { r: 'm', t: 'OTHER-ACCOUNT words', at: now - 30000 }, { r: 'c', t: 'OTHER-ACCOUNT reply', raw: 'OTHER-ACCOUNT reply\n###\n{"none": true}', at: now - 1000 }] }));
      localStorage.setItem('kaikou:sessions-' + m, JSON.stringify({ map: { oS1: { id: 'oS1', date: window.__mockToday, at: now - 5000, mode: 'free', label: 'OTHER session', level: 'B1', minutes: 5, count: 3, summary: 'OTHER-ACCOUNT summary', strengths: [], patterns: [], phrases: [], next: '' } } }));
    });
    await reloadAfterWrites(page); // this browser's copies (the other account's among them) are what the page shows
    const before = await page.evaluate(() => ({ mode: window.__kaikouTest.Store.mode, chat: window.__kaikouTest.S.chat && window.__kaikouTest.S.chat.id }));
    await page.addInitScript(() => { window.__mockCfg = Object.assign(window.__mockCfg || {}, { readOnly: false }); });
    await page.evaluate(() => { window.__mockCfg.readOnly = false; });
    await page.click('#btn-settings');
    await Promise.all([page.waitForEvent('load', { timeout: 10000 }), page.click('#set-cloud')]);
    await page.waitForFunction(() => window.__kaikouTest && window.__kaikouTest.S && window.__kaikouTest.S.ready, null, { timeout: 10000 });
    await until(page, () => /另一個帳號/.test(document.querySelector('#toast').textContent), null, 6000).catch(() => {});
    const note = await page.evaluate(() => document.querySelector('#toast').textContent);
    // Something is said in the open chat: what is written is this account's chat.
    await page.click('#t-coach');
    await page.fill('#msg-input', 'I had a quiet weekend at home');
    await page.click('#send-btn');
    await notBusy(page);
    await until(page, () => !window.__kaikouTest.Store.busyDoc('chat'), null, 6000);
    const m = await page.evaluate(() => window.__mockToday.slice(0, 7));
    const r = await page.evaluate(mm => {
      const X = window.__kaikouTest, get = n => window.__store.get('data/users/u_test/' + n) || {};
      return { mode: X.Store.mode, cloud: X.normInbox(get('inbox')).map(x => x.text), held: (JSON.parse(localStorage.getItem('kaikou:held') || '{}')).uid,
        chat: X.S.chat && X.S.chat.id, cloudChat: JSON.stringify(get('chat')).includes('OTHER-ACCOUNT'), review: (X.S.sessions[mm] || []).some(s => s.id === 'oS1'), flag: localStorage.getItem('kaikou:no-cloud') };
    }, m);
    check('這個瀏覽器留著另一個帳號的變更時，再試一次存到雲端不會把它們存進這個帳號，也不會刪掉它們（頁面重新從雲端開始）', () => {
      eq(before, { mode: 'local', chat: 'oChat' });
      eq([r.mode, r.cloud.includes('另一個帳號的句子'), r.held, r.chat, r.cloudChat, r.review, r.flag], ['db', false, 'u_other', 'c1', false, false, null]);
      assert.ok(note.includes('另一個帳號'), note);
    });
    await ctx.close();
  }

  if (want('4')) {
    // s2. The page reloads to use the cloud (see s), but this time the cloud cannot be reached: it says that, not that
    //     the cloud is now used.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'note-offline');
    await page.evaluate(() => sessionStorage.setItem('kaikou:note', '已改用雲端儲存。這個瀏覽器裡留著另一個帳號的資料，所以這裡的資料都沒有搬到你的雲端。'));
    await page.addInitScript(() => { window.__mockCfg = Object.assign(window.__mockCfg || {}, { noDb: true }); });
    await reloadAfterWrites(page);
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => ({ toast: document.querySelector('#toast').textContent, left: sessionStorage.getItem('kaikou:note') }));
    check('重新整理後要說「已改用雲端儲存」，但這次連不上雲端：照實說明連不上，不說已改用雲端', () => {
      assert.ok(/連不上 Claude 的雲端/.test(r.toast) && !/已改用雲端儲存/.test(r.toast), r.toast);
      eq(r.left, null);
    });
    await ctx.close();
  }

  if (want('4')) {
    // a3. Documents read at the start whose later read fails, then the cloud stops: they are kept in this browser as
    //     shown (not left out as if never read), so the next read here does not empty them; an older copy kept here
    //     does not bring back a phrase the cloud has deleted since.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'stop-after-failed-read', null, noFocusRefresh);
    const m = await page.evaluate(() => window.__mockToday.slice(0, 7));
    await page.evaluate(m => {
      const en = 'A phrase deleted on the phone last week.', id = window.__kaikouTest.phraseId(en);
      localStorage.setItem('kaikou:phrases', JSON.stringify({ map: { [id]: { id, en, zh: '', note: '', ex: '', src: 'fix', at: 1 } } }));
      Object.assign(window.__mockCfg.failReads, { phrases: 2, settings: 2, inbox: 2, ['log-' + m]: 2 });
    }, m);
    await ff(page, 181000); // the refresh every three minutes: these reads fail
    await until(page, m => ['phrases', 'settings', 'inbox', 'log-' + m].every(n => window.__kaikouTest.S.loadErrors.has(n)), m, 8000);
    await page.evaluate(() => { window.__mockCfg.failWrites.shadow = { n: 1, code: 'revoked' }; window.__kaikouTest.Store.patch('shadow', { cur: '', map: {} }, { cur: '' }); });
    await until(page, () => window.__kaikouTest.Store.mode === 'local', null, 6000);
    await ff(page, 181000); // the next refresh reads this browser's copies
    await page.waitForTimeout(500);
    const r = await page.evaluate(m => { const X = window.__kaikouTest, S = X.S; return { phrases: S.phrases.map(p => p.en).sort(), inbox: S.inbox.length, about: S.settings.about, today: X.status(S.logs[m].days[window.__mockToday]), streak: S.streak }; }, m);
    const copies = await page.evaluate(m => ['phrases', 'settings', 'inbox', 'log-' + m].filter(n => !localStorage.getItem('kaikou:' + n)), m);
    await page.click('#btn-settings');
    const box = await page.evaluate(() => { const t = document.querySelector('#set-about'); return { ro: t.readOnly, value: t.value }; });
    check('讀到過、後來重新讀取失敗的資料，雲端停止時照樣存進這個瀏覽器：之後重新讀取不會清空收藏、隨手記、紀錄和設定（「關於我」照常顯示），瀏覽器裡舊的副本也不會救回雲端刪掉的句子', () => {
      eq(r, { phrases: ['I went hiking with my friends.', "I'll get back to you on that.", 'It slipped my mind.'], inbox: 2, about: 'I live in Taipei and work in marketing.', today: 1, streak: 5 });
      eq(box, { ro: false, value: 'I live in Taipei and work in marketing.' });
      eq(copies, []); // a later visit that cannot reach the cloud shows them too
    });
    await ctx.close();
  }
  if (want('4')) {
    // y2. Two tabs of one browser: tab A cannot reach the cloud (its changes are held here), tab B can and offers to save
    //     them. What A holds when 存到雲端 is pressed is saved (also what it noted after B opened), except a field A sets
    //     again while B's upload reads the cloud: that later value stays held, with what A notes meanwhile, and B offers
    //     it again. A keeps showing all of it, also once B is done and this browser's copies are gone.
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    await ctx.clock.install({ time: NOON });
    const A = await addPage(ctx, ARTIFACT, 'held-tabs-A', { noDb: true }, noFocusRefresh);
    const note = async t => { await A.fill('#inbox-input', t); await A.click('#inbox-form .btn'); await until(A, x => (localStorage.getItem('kaikou:held') || '').includes(x), t, 4000); };
    const level = async l => { await A.click('#btn-settings'); await A.click('[data-fk="slvl-' + l + '"]'); await A.click('#set-done'); await until(A, x => ((JSON.parse(localStorage.getItem('kaikou:held') || '{}').docs || {}).settings || {}).level === x, l, 4000); };
    await note('A 分頁記的第一句');
    await level('B2');
    await settle(A);
    const B = await addPage(ctx, ARTIFACT, 'held-tabs-B', { readDelay: { inbox: [20, 1500], settings: [20, 1500] } }, noFocusRefresh);
    await seeWrites(B, () => /A 分頁記的第一句/.test(localStorage.getItem('kaikou:held') || ''));
    await until(B, () => !!document.querySelector('[data-fk="held-up"]'), null, 6000);
    await note('A 分頁記的第二句'); // after B opened
    await until(B, () => /第二句/.test(localStorage.getItem('kaikou:held') || ''), null, 4000);
    await B.click('[data-fk="held-up"]');
    await B.waitForTimeout(300); // B reads the cloud (slowly) before it sends anything
    await note('A 分頁記的第三句');
    await level('A2');
    await until(B, () => !window.__kaikouTest.S.uploading, null, 10000);
    const texts = p => p.evaluate(() => window.__kaikouTest.normInbox(window.__store.get('data/users/u_test/inbox')).map(x => x.text).filter(t => /A 分頁/.test(t)).sort());
    const cloudLevel = () => B.evaluate(() => window.__store.get('data/users/u_test/settings').level);
    const first = { cloud: await texts(B), level: await cloudLevel(), held: await B.evaluate(() => { const d = JSON.parse(localStorage.getItem('kaikou:held') || '{}').docs || {}; return { notes: Object.values(d.inbox.map).map(x => x && x.text), settings: d.settings }; }), offer: !!(await B.$('[data-fk="held-up"]')), toast: await B.evaluate(() => document.querySelector('#toast').textContent) };
    await B.click('[data-fk="held-up"]');
    await until(B, () => !window.__kaikouTest.S.uploading && !window.__kaikouTest.S.held, null, 10000);
    const second = { cloud: await texts(B), level: await cloudLevel(), held: await B.evaluate(() => localStorage.getItem('kaikou:held')), copy: await B.evaluate(() => localStorage.getItem('kaikou:inbox')) };
    await ff(A, 181000); // A reads this browser's storage again: its copy is gone
    await A.waitForTimeout(400);
    const shownA = await A.evaluate(() => window.__kaikouTest.S.inbox.map(x => x.text).filter(t => /A 分頁/.test(t)).sort());
    check('另一個分頁連不上雲端還在記東西時按「存到雲端」：按下時記著的都上傳（包括頁面打開後才記的；上傳途中又改的欄位只留後來的），上傳途中記的留著、再提醒一次；那個分頁的畫面不會變空', () => {
      eq(first, { cloud: ['A 分頁記的第一句', 'A 分頁記的第二句'], level: 'B1', held: { notes: ['A 分頁記的第三句'], settings: { level: 'A2' } }, offer: true, toast: '已把這台裝置上的變更存到雲端。之後又留下了新的變更，可以再按一次存到雲端。' });
      const all = ['A 分頁記的第一句', 'A 分頁記的第二句', 'A 分頁記的第三句'].sort();
      eq(second, { cloud: all, level: 'A2', held: null, copy: null });
      eq(shownA, all);
    });
    await ctx.close();
  }
  if (want('4')) {
    // y3. Tab A cannot reach the cloud: it notes two sentences and ticks AI 對話 (held here). Tab B reaches the cloud and
    //     presses 存到雲端; while B reads the cloud, A deletes the first sentence and unticks the item: those are not
    //     uploaded (B sends what is still held, not what it had when pressed). The second sentence, saved there, is
    //     deleted in A afterwards: that is kept as a deletion (for the next 存到雲端).
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    await ctx.clock.install({ time: NOON });
    const A = await addPage(ctx, ARTIFACT, 'held-race-A', { noDb: true }, noFocusRefresh);
    const m = await A.evaluate(() => window.__mockToday.slice(0, 7));
    const note = async t => { await A.fill('#inbox-input', t); await A.click('#inbox-form .btn'); await until(A, x => (localStorage.getItem('kaikou:held') || '').includes(x), t, 4000); };
    await note('上傳時被刪掉的句子');
    await note('上傳之後才刪掉的句子');
    await A.click('[data-fk="ck-ai"]');
    await until(A, () => /"ai":true/.test(localStorage.getItem('kaikou:held') || ''), null, 4000);
    await settle(A);
    const B = await addPage(ctx, ARTIFACT, 'held-race-B', { readDelay: { inbox: [20, 2500] } }, noFocusRefresh);
    await seeWrites(B, () => /上傳之後才刪掉的句子/.test(localStorage.getItem('kaikou:held') || '') && /"ai":true/.test(localStorage.getItem('kaikou:held') || ''));
    await until(B, () => !!document.querySelector('[data-fk="held-up"]'), null, 6000);
    const del = async t => { const id = await A.evaluate(x => window.__kaikouTest.S.inbox.find(y => y.text === x).id, t); await pressTwice(A, '[data-fk="del-' + id + '"]'); return id; };
    await B.click('[data-fk="held-up"]');
    await B.waitForTimeout(200); // B reads the cloud (slowly) before it sends anything
    await del('上傳時被刪掉的句子');
    await A.click('[data-fk="ck-ai"]');
    await until(B, () => !window.__kaikouTest.S.uploading, null, 10000);
    await until(B, () => !window.__kaikouTest.Store.busyDoc('inbox'), null, 6000);
    const a = await B.evaluate(m => { const X = window.__kaikouTest, d = (window.__store.get('data/users/u_test/log-' + m).days || {})[window.__mockToday] || { items: {} };
      return { notes: X.normInbox(window.__store.get('data/users/u_test/inbox')).map(x => x.text).filter(t => /上傳/.test(t)), ai: !!d.items.ai, offer: !!document.querySelector('[data-fk="held-up"]') }; }, m);
    const later = await del('上傳之後才刪掉的句子');
    await until(A, x => { const h = JSON.parse(localStorage.getItem('kaikou:held') || 'null'); return !!h && (h.docs.inbox || { map: {} }).map[x] === null; }, later, 4000).catch(() => {});
    const c = await A.evaluate(x => { const h = JSON.parse(localStorage.getItem('kaikou:held') || 'null'); return h && (h.docs.inbox || { map: {} }).map[x]; }, later);
    check('上傳途中另一個分頁刪掉或取消打勾的不會上傳；已經上傳的句子之後再刪，記成刪除', () => eq([a, c], [{ notes: ['上傳之後才刪掉的句子'], ai: false, offer: false }, null]));
    await ctx.close();
  }
  if (want('4')) {
    // y4. 不要了 drops what the notice showed: what another tab (still unable to reach the cloud) held after the notice
    //     was drawn stays, and is offered.
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    await ctx.clock.install({ time: NOON });
    const A = await addPage(ctx, ARTIFACT, 'held-drop-A', { noDb: true }, noFocusRefresh);
    const note = async t => { await A.fill('#inbox-input', t); await A.click('#inbox-form .btn'); await until(A, x => (localStorage.getItem('kaikou:held') || '').includes(x), t, 4000); };
    const level = async l => { await A.click('#btn-settings'); await A.click('[data-fk="slvl-' + l + '"]'); await A.click('#set-done'); await until(A, x => ((JSON.parse(localStorage.getItem('kaikou:held') || '{}').docs || {}).settings || {}).level === x, l, 4000); };
    await note('提醒裡要捨棄的句子');
    await level('B2');
    await settle(A);
    const B = await addPage(ctx, ARTIFACT, 'held-drop-B', null, noFocusRefresh);
    await seeWrites(B, () => /提醒裡要捨棄的句子/.test(localStorage.getItem('kaikou:held') || ''));
    await until(B, () => !!document.querySelector('[data-fk="held-drop"]'), null, 6000);
    await note('提醒之後才記的句子');
    await level('A2');
    await until(B, () => /提醒之後才記的句子/.test(localStorage.getItem('kaikou:held') || '') && /"level":"A2"/.test(localStorage.getItem('kaikou:held') || ''), null, 4000);
    await pressTwice(B, '[data-fk="held-drop"]');
    await B.waitForTimeout(200);
    const notes = x => Object.values((x && x.map) || {}).map(y => y && y.text).filter(t => /提醒/.test(t || '')).sort();
    const r = await B.evaluate(() => ({ held: Object.values(((JSON.parse(localStorage.getItem('kaikou:held') || '{}').docs || {}).inbox || { map: {} }).map).map(x => x && x.text), level: ((JSON.parse(localStorage.getItem('kaikou:held') || '{}').docs || {}).settings || {}).level, offer: !!document.querySelector('[data-fk="held-up"]'), copy: JSON.parse(localStorage.getItem('kaikou:inbox') || 'null') }));
    await until(A, () => !window.__kaikouTest.S.inbox.some(x => x.text === '提醒裡要捨棄的句子'), null, 4000).catch(() => {});
    const shownA = await A.evaluate(() => window.__kaikouTest.S.inbox.map(x => x.text).filter(t => /提醒/.test(t)));
    check('「不要了」只捨棄提醒裡的變更：另一個分頁之後才留下的（或又改的程度）照樣留著，提醒也還在；瀏覽器的副本和那個分頁的畫面也不再有捨棄的', () =>
      eq([r.held, r.level, r.offer, notes(r.copy), shownA], [['提醒之後才記的句子'], 'A2', true, ['提醒之後才記的句子'], ['提醒之後才記的句子']]));
    await ctx.close();
  }
  if (want('4')) {
    // y5. 存到雲端 while this browser cannot keep the record of changes on their way (its storage is full) and the cloud
    //     does not take them yet: the changes stay held here and offered (a page closed now would lose them otherwise).
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'held-nokeep', { noDb: true }, noFocusRefresh);
    await page.fill('#inbox-input', '存不進紀錄時的句子');
    await page.click('#inbox-form .btn');
    await until(page, () => /存不進紀錄時的句子/.test(localStorage.getItem('kaikou:held') || ''), null, 4000);
    await page.addInitScript(() => { window.__mockCfg = Object.assign(window.__mockCfg || {}, { noDb: false, failWrites: { inbox: { n: 99, code: 'unavailable' } } }); });
    await reloadAfterWrites(page);
    await until(page, () => !!document.querySelector('[data-fk="held-up"]'), null, 6000);
    await page.evaluate(() => { const real = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (String(k).startsWith('kaikou:unsent:')) { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; } return real.call(this, k, v); }; });
    await page.click('[data-fk="held-up"]');
    await until(page, () => window.__dbCalls.some(c => c.name === 'inbox' && c.code === 'unavailable'), null, 6000); // queued, and refused for now
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => ({ waiting: window.__kaikouTest.S.uploading, held: /存不進紀錄時的句子/.test(localStorage.getItem('kaikou:held') || '') }));
    check('存到雲端時這個瀏覽器記不住送出中的變更、雲端又還沒收下：變更照樣留在這裡（頁面這時關掉也不會不見）', () => eq(r, { waiting: true, held: true }));
    await ctx.close();
  }
  if (want('4')) {
    // u2. A record left behind deleted a phrase ten minutes ago; five minutes ago the same phrase was saved again on
    //     another device: sending the record keeps it, with its review schedule. A deletion made after a phrase was
    //     saved still deletes it.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'resend-resaved', null, noFocusRefresh);
    await page.evaluate(() => {
      const X = window.__kaikouTest, now = Date.now(), k = 'data/users/u_test/', t = now - 10 * 60000;
      const a = X.phraseId('Let me think about it.'), b = X.phraseId('It slipped my mind.');
      const d = window.__store.get(k + 'phrases'); d.map = Object.assign({}, d.map || {}, { [a]: { id: a, en: 'Let me think about it.', zh: '讓我想一想', note: '', ex: '', src: 'fix', at: now - 5 * 60000 } }); window.__store.set(k + 'phrases', d);
      window.__store.set(k + 'srs', { map: { [a]: { d: window.__mockToday, i: 1, r: 1, l: 0, f: window.__mockToday, t: window.__mockToday } } });
      localStorage.setItem('kaikou:unsent:u_test:closed', JSON.stringify({ at: t, beat: t, docs: { phrases: { map: { [a]: null, [b]: null } }, srs: { map: { [a]: null } } }, times: { phrases: { map: { [a]: t, [b]: t } }, srs: { map: { [a]: t } } }, del: {} }));
      window.__ids = [a, b];
    });
    await ff(page, 181000);
    await until(page, () => !localStorage.getItem('kaikou:unsent:u_test:closed'), null, 10000);
    await until(page, () => !window.__kaikouTest.Store.busyDoc('phrases') && !window.__kaikouTest.Store.busyDoc('srs'), null, 6000);
    const r = await page.evaluate(() => {
      const [a, b] = window.__ids, k = 'data/users/u_test/', X = window.__kaikouTest, ids = X.normPhrases(window.__store.get(k + 'phrases')).map(p => p.id);
      return { kept: ids.includes(a), schedule: !!X.normSrs(window.__store.get(k + 'srs'))[a], deleted: !ids.includes(b), shown: X.S.phrases.some(p => p.id === a) };
    });
    check('補存上次沒存到的刪除：在那之後（別台裝置）又收藏的同一句和它的複習排程不會被刪掉；比收藏還晚的刪除照樣刪掉', () => eq(r, { kept: true, schedule: true, deleted: true, shown: true }));
    await ctx.close();
  }
  if (want('4')) {
    // i5. The settings (a 60-minute plan) cannot be read yet and the cloud has no record of today: today's first ticks
    //     write a stand-in plan (this page does not know the learner's). Once the settings are read (here: opening 設定
    //     reads them again), the day takes the learner's plan, so two ticks do not count as a finished 60-minute day.
    //     When the month could not be read either (a review round ticks 語塊複習 by itself), the plan is set once the
    //     month is read too.
    const m = dayKey(0).slice(0, 7), n = 'log-' + m;
    const plansOf = (page, x) => page.evaluate(x => (((window.__store.get('data/users/u_test/' + x) || {}).days || {})[window.__mockToday] || {}).plans, x);
    let r1, blind1, r2, blind2, early2;
    {
      const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'plan-unread', { noToday: true, settings: { plan: '60' }, failReads: { settings: 2 } }, noFocusRefresh);
      await page.click('[data-fk="ck-shadow"]');
      await page.click('[data-fk="ck-ai"]');
      await until(page, x => !window.__kaikouTest.Store.busyDoc(x), n, 6000);
      blind1 = await plansOf(page, n);
      await page.click('#btn-settings');
      await until(page, x => window.__kaikouTest.S.settingsRead && !window.__kaikouTest.Store.busyDoc(x) && !!(window.__store.get('data/users/u_test/' + x).days[window.__mockToday].plans || {})['0'], n, 6000).catch(() => {});
      r1 = await page.evaluate(x => { const X = window.__kaikouTest, d = X.S.logs[x.slice(4)].days[window.__mockToday]; return { cloud: window.__store.get('data/users/u_test/' + x).days[window.__mockToday].plans, plan: d.plan, status: X.status(d) }; }, n);
      await ctx.close();
    }
    {
      const { ctx, page } = await open(ARTIFACT + '#saved', { viewport: { width: 1000, height: 800 } }, 'plan-unread-month', { noToday: true, settings: { plan: '60' }, failReads: { settings: 2, [n]: 99 } }, noFocusRefresh);
      await page.click('[data-fk="drill-start"]');
      for (let i = 0; i < 3; i++) { await page.click('[data-fk="flip"]'); await page.click('[data-fk="rate-2"]'); }
      await until(page, x => !!window.__kaikouTest.S.drill && window.__kaikouTest.S.drill.done && !window.__kaikouTest.Store.busyDoc(x) && !!window.__store.get('data/users/u_test/' + x).days[window.__mockToday], n, 6000);
      blind2 = await plansOf(page, n);
      await page.click('#btn-settings'); // the settings are read, the month still is not
      await until(page, () => window.__kaikouTest.S.settingsRead, null, 6000);
      await page.waitForTimeout(400);
      early2 = await plansOf(page, n);
      await page.click('#set-done');
      await page.evaluate(x => { window.__mockCfg.failReads[x] = 0; }, n);
      await ff(page, 181000); // the month is read now
      await until(page, x => !window.__kaikouTest.Store.busyDoc(x) && !!(window.__store.get('data/users/u_test/' + x).days[window.__mockToday].plans || {})['0'], n, 6000).catch(() => {});
      r2 = await plansOf(page, n);
      await ctx.close();
    }
    check('設定還讀不到時打勾新的一天：先寫替代的計畫，讀到設定後換成你的計畫（不會把 20 分鐘當成你的計畫算完成）；那個月也讀不到時，等月份也讀到再換', () => {
      eq(blind1, { '-1': '20' });
      eq(r1, { cloud: { '-1': '20', 0: '60' }, plan: '60', status: 1 });
      eq([blind2, early2, r2], [{ '-1': '20' }, { '-1': '20' }, { '-1': '20', 0: '60' }]);
    });
  }
  if (want('4')) {
    // i6. Another device created today with a stand-in plan (it could not read the settings): the next tick here, where
    //     the learner's plan (60 minutes) is known, gives the day that plan.
    const seed = "window.__mockSeed = (store, P, dk) => { const k = dk(new Date()), d = store.get(P('log-' + k.slice(0, 7))); d.days[k] = { plans: { '-1': '20' }, items: { shadow: true } }; };";
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'plan-standin', { settings: { plan: '60' } }, seed + noFocusRefresh);
    const m = await page.evaluate(() => window.__mockToday.slice(0, 7));
    const before = await page.evaluate(m => window.__kaikouTest.S.logs[m].days[window.__mockToday].plan, m);
    await page.click('[data-fk="ck-ai"]');
    await until(page, n => !window.__kaikouTest.Store.busyDoc(n), 'log-' + m, 6000);
    const r = await page.evaluate(m => ({ cloud: window.__store.get('data/users/u_test/log-' + m).days[window.__mockToday].plans, plan: window.__kaikouTest.S.logs[m].days[window.__mockToday].plan }), m);
    check('別台裝置在讀不到設定時建了今天（替代的計畫）：這裡知道你的計畫，下次打勾時就補上', () => eq([before, r], ['20', { cloud: { '-1': '20', 0: '60' }, plan: '60' }]));
    await ctx.close();
  }
  if (want('4')) {
    // f2. A visit that cannot reach the cloud and finds no copy of the settings in this browser does not know them:
    //     關於我 stays closed, and a day created now gets the stand-in plan. Changing the coach level there does not make
    //     the next such visit take the defaults for the learner's settings (關於我 stays closed then too). The visit
    //     after that reaches the cloud (the learner's plan is 60 minutes) and saves the changes: the day gets that plan.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'offline-no-settings', { noDb: true, persist: true, noToday: true, settings: { plan: '60' } }, noFocusRefresh);
    const m = await page.evaluate(() => window.__mockToday.slice(0, 7));
    await page.click('[data-fk="ck-shadow"]');
    await page.click('[data-fk="ck-ai"]');
    await until(page, n => !window.__kaikouTest.Store.busyDoc(n), 'log-' + m, 6000);
    const plans = await page.evaluate(n => (JSON.parse(localStorage.getItem('kaikou:held') || '{}').docs[n].days[window.__mockToday] || {}).plans, 'log-' + m);
    await page.click('#btn-settings');
    const aboutBox = () => page.evaluate(() => { const t = document.querySelector('#set-about'); return { ro: t.readOnly, hint: /讀不到你的設定/.test(t.placeholder) }; });
    const box = await aboutBox();
    await page.click('[data-fk="slvl-B2"]');
    await page.click('#set-done');
    await until(page, () => !window.__kaikouTest.Store.busyDoc('settings'), null, 4000);
    await reloadAfterWrites(page); // the next visit cannot reach the cloud either
    await page.click('#btn-settings');
    const box2 = await aboutBox();
    const level2 = await page.evaluate(() => window.__kaikouTest.S.settings.level);
    await page.click('#set-done');
    await page.addInitScript(() => { window.__mockCfg = Object.assign(window.__mockCfg || {}, { noDb: false }); });
    await reloadAfterWrites(page); // this one reaches the cloud
    await until(page, () => !!document.querySelector('[data-fk="held-up"]'), null, 6000);
    await page.click('[data-fk="held-up"]');
    await until(page, n => !window.__kaikouTest.S.uploading && !window.__kaikouTest.Store.busyDoc(n), 'log-' + m, 10000);
    const up = await page.evaluate(n => { const X = window.__kaikouTest, d = X.S.logs[n.slice(4)].days[window.__mockToday]; return { cloud: window.__store.get('data/users/u_test/' + n).days[window.__mockToday].plans, plan: d.plan, status: X.status(d), about: window.__store.get('data/users/u_test/settings').about }; }, 'log-' + m);
    check('連不上雲端、瀏覽器裡也沒有設定的副本：這次當作讀不到設定，「關於我」先不能改，新的一天先用替代的計畫；在那裡改了教練程度，下次連不上時也一樣；之後存到雲端時那天換成你的計畫', () => {
      eq([box, plans], [{ ro: true, hint: true }, { '-1': '20' }]);
      eq([box2, level2], [{ ro: true, hint: true }, 'B2']);
      eq(up, { cloud: { '-1': '20', 0: '60' }, plan: '60', status: 1, about: 'I live in Taipei and work in marketing.' });
    });
    await ctx.close();
  }
  if (want('4')) {
    // f3. Changes kept from a visit that could not reach the cloud, not saved there yet, then a visit that reaches it and
    //     stops (access withdrawn): this browser's copies keep those changes, so the next visit that cannot reach the
    //     cloud still shows them (they are saved with 存到雲端 later).
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'held-copies', { noDb: true, persist: true }, noFocusRefresh);
    const m = await page.evaluate(() => window.__mockToday.slice(0, 7));
    await page.fill('#inbox-input', '連不上雲端時記的句子');
    await page.click('#inbox-form .btn');
    await page.click('[data-fk="ck-ai"]');
    await until(page, n => !window.__kaikouTest.Store.busyDoc('inbox') && !window.__kaikouTest.Store.busyDoc(n), 'log-' + m, 4000);
    await page.addInitScript(() => { window.__mockCfg = Object.assign(window.__mockCfg || {}, { noDb: false, failWrites: { shadow: { n: 1, code: 'revoked' } } }); });
    await reloadAfterWrites(page); // reaches the cloud, offers 存到雲端; then a write is refused
    await until(page, () => !!document.querySelector('[data-fk="held-up"]'), null, 6000);
    await page.evaluate(() => window.__kaikouTest.Store.patch('shadow', { cur: '', map: {} }, { cur: '' }));
    await until(page, () => window.__kaikouTest.Store.mode === 'local', null, 6000);
    await page.addInitScript(() => { window.__mockCfg = Object.assign(window.__mockCfg || {}, { noDb: true, failWrites: {} }); });
    await reloadAfterWrites(page); // cannot reach the cloud again
    const r = await page.evaluate(m => { const X = window.__kaikouTest, d = X.S.logs[m] && X.S.logs[m].days[window.__mockToday]; return { note: X.S.inbox.some(x => x.text === '連不上雲端時記的句子'), ai: !!(d && d.items.ai), held: /連不上雲端時記的句子/.test(localStorage.getItem('kaikou:held') || '') }; }, m);
    check('連不上雲端時留下、還沒存到雲端的變更：之後一次連上又停止的造訪不會把它們從瀏覽器的副本裡拿掉，下次連不上時照樣顯示', () => eq(r, { note: true, ai: true, held: true }));
    await ctx.close();
  }
  if (want('4')) {
    // g2. Kept on a visit that could not reach the cloud: two ticks and the coach level (B2). On the next visit, which
    //     reaches it, the learner ticks one of those items and takes it back, then presses 存到雲端 and, while the
    //     cloud is read, sets the level to A2: those later choices stay (the upload does not bring the earlier tick or
    //     level back); the other tick is uploaded.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'held-later', { noDb: true, persist: true }, noFocusRefresh);
    const m = await page.evaluate(() => window.__mockToday.slice(0, 7));
    const level = async l => { await page.click('#btn-settings'); await page.click('[data-fk="slvl-' + l + '"]'); await page.click('#set-done'); };
    const idle = () => until(page, n => !window.__kaikouTest.Store.busyDoc(n) && !window.__kaikouTest.Store.busyDoc('settings'), 'log-' + m, 6000);
    await page.click('[data-fk="ck-ai"]');
    await page.click('[data-fk="ck-listen"]');
    await level('B2');
    await idle();
    await page.addInitScript(() => { window.__mockCfg = Object.assign(window.__mockCfg || {}, { noDb: false }); });
    await reloadAfterWrites(page); // this visit reaches the cloud
    await until(page, () => !!document.querySelector('[data-fk="held-up"]'), null, 6000);
    await page.click('[data-fk="ck-ai"]');
    await page.waitForTimeout(700);
    await page.click('[data-fk="ck-ai"]');
    await idle();
    await page.evaluate(() => { window.__mockCfg.readDelay = { settings: 1500 }; });
    await page.click('[data-fk="held-up"]');
    await page.waitForTimeout(300); // the cloud is being read
    await level('A2');
    await until(page, () => !window.__kaikouTest.S.uploading, null, 15000);
    await idle();
    const r = await page.evaluate(m => { const d = window.__store.get('data/users/u_test/log-' + m).days[window.__mockToday]; return { level: window.__store.get('data/users/u_test/settings').level, shown: window.__kaikouTest.S.settings.level, ai: !!d.items.ai, listen: !!d.items.listen, held: localStorage.getItem('kaikou:held') }; }, m);
    check('連不上雲端時留下的打勾和教練程度，下次連上雲端後又改了同一項（打勾又取消、上傳途中改程度）：存到雲端不會把之前的改回來，其他的照樣上傳', () => eq(r, { level: 'A2', shown: 'A2', ai: false, listen: true, held: null }));
    await ctx.close();
  }
  if (want('4')) {
    // g3. The coach level set to B2 on a visit that could not reach the cloud (kept for it), then to A2 on a visit that
    //     reaches it and then stops (access withdrawn): this browser's copy has A2, the later choice, and so does the
    //     next visit that cannot reach the cloud.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'held-later-copy', { noDb: true, persist: true }, noFocusRefresh);
    const level = async l => { await page.click('#btn-settings'); await page.click('[data-fk="slvl-' + l + '"]'); await page.click('#set-done'); await until(page, () => !window.__kaikouTest.Store.busyDoc('settings'), null, 6000); };
    await level('B2');
    await page.addInitScript(() => { window.__mockCfg = Object.assign(window.__mockCfg || {}, { noDb: false, failWrites: { shadow: { n: 1, code: 'revoked' } } }); });
    await reloadAfterWrites(page);
    await until(page, () => !!document.querySelector('[data-fk="held-up"]'), null, 6000);
    await level('A2');
    await page.waitForTimeout(300);
    const notice = await page.evaluate(() => !!document.querySelector('[data-fk="held-up"]'));
    await page.evaluate(() => window.__kaikouTest.Store.patch('shadow', { cur: '', map: {} }, { cur: '' }));
    await until(page, () => window.__kaikouTest.Store.mode === 'local', null, 6000);
    const copy = await page.evaluate(() => JSON.parse(localStorage.getItem('kaikou:settings') || '{}').level);
    await page.addInitScript(() => { window.__mockCfg = Object.assign(window.__mockCfg || {}, { noDb: true, failWrites: {} }); });
    await reloadAfterWrites(page);
    const next = await page.evaluate(() => window.__kaikouTest.S.settings.level);
    check('連不上雲端時改的教練程度、連上雲端後又改了一次（沒有別的留著了，提醒就收起來），之後雲端停止：瀏覽器裡的副本是後來改的，下次連不上時也一樣', () => eq([notice, copy, next], [false, 'A2', 'A2']));
    await ctx.close();
  }
  if (want('4')) {
    // g4. Kept on a visit that could not reach the cloud: the coach level (B2) and a note. On the next visit, which
    //     reaches it, the level is set to A2 while the note is still kept: this browser's copy says A2 at once, so the
    //     next visit that cannot reach the cloud shows A2 with the note. Until the cloud has A2, this tab keeps it in its
    //     record of unsent changes (the kept B2 is gone, nothing else would bring A2 back).
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'held-later-copies', { noDb: true, persist: true }, noFocusRefresh);
    const level = async l => { await page.click('#btn-settings'); await page.click('[data-fk="slvl-' + l + '"]'); await page.click('#set-done'); };
    await page.fill('#inbox-input', '程度改兩次時記的句子');
    await page.click('#inbox-form .btn');
    await level('B2');
    await until(page, () => !window.__kaikouTest.Store.busyDoc('settings') && !window.__kaikouTest.Store.busyDoc('inbox'), null, 6000);
    await page.addInitScript(() => { window.__mockCfg = Object.assign(window.__mockCfg || {}, { noDb: false, writeDelay: { settings: 3000 } }); });
    await reloadAfterWrites(page);
    await until(page, () => !!document.querySelector('[data-fk="held-up"]'), null, 6000);
    await level('A2');
    await page.waitForTimeout(800); // the write takes 3 s
    const mid = await page.evaluate(() => ({ copy: JSON.parse(localStorage.getItem('kaikou:settings') || '{}').level, held: (JSON.parse(localStorage.getItem('kaikou:held') || '{}').docs || {}).settings || null,
      unsent: Object.keys(localStorage).filter(k => k.startsWith('kaikou:unsent:u_test:')).map(k => ((JSON.parse(localStorage.getItem(k)).docs || {}).settings || {}).level) }));
    await until(page, () => !window.__kaikouTest.Store.busyDoc('settings') && window.__store.get('data/users/u_test/settings').level === 'A2', null, 8000);
    await page.addInitScript(() => { window.__mockCfg = Object.assign(window.__mockCfg || {}, { noDb: true, writeDelay: {} }); });
    await reloadAfterWrites(page);
    const next = await page.evaluate(() => ({ level: window.__kaikouTest.S.settings.level, note: window.__kaikouTest.S.inbox.some(x => x.text === '程度改兩次時記的句子') }));
    check('連不上雲端時改的程度和記的句子，連上雲端後程度又改了（句子還留著）：瀏覽器的副本馬上是新的程度，下次連不上時照樣顯示句子；雲端收下新的程度前，這個分頁一直記著它', () => {
      eq(mid, { copy: 'A2', held: null, unsent: ['A2'] });
      eq(next, { level: 'A2', note: true });
    });
    await ctx.close();
  }
  if (want('4')) {
    // f4. A day made on a visit that could not reach the cloud and did not know the settings (a stand-in plan) is saved
    //     with 存到雲端 on a visit whose settings cannot be read yet: once they are read, the day gets the learner's plan.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'held-plan-later', { noDb: true, persist: true, noToday: true, settings: { plan: '60' } }, noFocusRefresh);
    const m = await page.evaluate(() => window.__mockToday.slice(0, 7));
    await page.click('[data-fk="ck-shadow"]');
    await until(page, n => !window.__kaikouTest.Store.busyDoc(n), 'log-' + m, 6000);
    await page.addInitScript(() => { window.__mockCfg = Object.assign(window.__mockCfg || {}, { noDb: false, failReads: { settings: 99 } }); });
    await reloadAfterWrites(page);
    await until(page, () => !!document.querySelector('[data-fk="held-up"]'), null, 6000);
    await page.click('[data-fk="held-up"]');
    await until(page, n => !window.__kaikouTest.S.uploading && !window.__kaikouTest.Store.busyDoc(n), 'log-' + m, 10000);
    const plans = () => page.evaluate(m => ((window.__store.get('data/users/u_test/log-' + m) || { days: {} }).days[window.__mockToday] || {}).plans, m);
    const before = await plans();
    await page.evaluate(() => { window.__mockCfg.failReads.settings = 0; });
    await ff(page, 181000);
    await until(page, m => '0' in (((window.__store.get('data/users/u_test/log-' + m) || { days: {} }).days[window.__mockToday] || {}).plans || {}), m, 8000).catch(() => {});
    const after = await plans();
    check('連不上雲端、也不知道設定時建立的那一天，在讀不到設定的造訪存到雲端：之後讀到設定，那天就換成你的計畫', () => eq([before, after], [{ '-1': '20' }, { '-1': '20', 0: '60' }]));
    await ctx.close();
  }
  if (want('4')) {
    // f6. A note kept from a visit that could not reach the cloud; meanwhile another device noted something else. A
    //     visit that reaches the cloud (the note is still kept) brings this browser's copies up to date, so the next
    //     visit that cannot reach it shows both.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'held-fresh-copies', { noDb: true, persist: true }, noFocusRefresh);
    await page.fill('#inbox-input', '這台連不上雲端時記的句子');
    await page.click('#inbox-form .btn');
    await until(page, () => /這台連不上雲端時記的句子/.test(localStorage.getItem('kaikou:held') || ''), null, 4000);
    await page.addInitScript(() => {
      window.__mockCfg = Object.assign(window.__mockCfg || {}, { noDb: false });
      window.__mockSeed = (store, P) => { store.get(P('inbox')).items.push({ id: 'phone1', text: '手機上記的句子', at: 9 }); };
    });
    await reloadAfterWrites(page);
    await until(page, () => !!document.querySelector('[data-fk="held-up"]'), null, 6000);
    await page.addInitScript(() => { window.__mockCfg = Object.assign(window.__mockCfg || {}, { noDb: true }); });
    await reloadAfterWrites(page);
    const shown = await page.evaluate(() => window.__kaikouTest.S.inbox.map(x => x.text).filter(t => /句子/.test(t) && /台|手機/.test(t)).sort());
    check('連不上雲端時記的句子還沒存到雲端，之後連上雲端的造訪會更新瀏覽器的副本：下次連不上時，別台記的和這台記的都看得到', () => eq(shown, ['手機上記的句子', '這台連不上雲端時記的句子'].sort()));
    await ctx.close();
  }
  if (want('4')) {
    // f5. A phrase starred on a visit that could not reach the cloud (kept for it) was starred on another device too,
    //     with a note. A visit that reaches the cloud and then stops writes this browser's copy as an upload would leave
    //     it: the cloud's entry with its note, not the one kept here.
    const { ctx, page } = await open(ARTIFACT + '#saved', { viewport: { width: 1000, height: 800 } }, 'held-copy-rules', { noDb: true, persist: true }, noFocusRefresh);
    await page.click('#starters .icon-btn[aria-pressed="false"][aria-label="收藏"]');
    await until(page, () => /"phrases"/.test(localStorage.getItem('kaikou:held') || ''), null, 4000);
    await settle(page);
    const p = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('kaikou:held')).docs.phrases.map)[0]);
    await page.addInitScript(p => {
      window.__mockCfg = Object.assign(window.__mockCfg || {}, { noDb: false, failWrites: { shadow: { n: 1, code: 'revoked' } } });
      window.__mockSeed = (store, P) => { const ph = store.get(P('phrases')); ph.items.push({ id: p.id, en: p.en, zh: p.zh || '', note: 'NOTE FROM THE PHONE', ex: '', src: 'starter', at: 99 }); };
    }, p);
    await reloadAfterWrites(page); // reaches the cloud (which has the phrase from the phone); then a write is refused
    await until(page, () => !!document.querySelector('[data-fk="held-up"]'), null, 6000);
    await page.evaluate(() => window.__kaikouTest.Store.patch('shadow', { cur: '', map: {} }, { cur: '' }));
    await until(page, () => window.__kaikouTest.Store.mode === 'local', null, 6000);
    const note = await page.evaluate(id => { const c = JSON.parse(localStorage.getItem('kaikou:phrases') || '{}'); return ((c.map || {})[id] || {}).note; }, p.id);
    check('連不上雲端時收藏、別台也收藏了同一句（有筆記），之後一次連上又停止：瀏覽器的副本照上傳時的規則，用雲端那一筆（有筆記）', () => eq(note, 'NOTE FROM THE PHONE'));
    await ctx.close();
  }
  if (want('4')) {
    // y6. 存到雲端 while another tab of this browser rates a kept review again (the same first review and time, other
    //     fields): the older rating is not sent half over the cloud's, and the newer one stays kept, whole.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'held-entry', { persist: true }, noFocusRefresh);
    const c = { d: '2030-01-05', i: 6, r: 2, l: 0, f: '2030-01-01', t: '2030-01-02', pt: '2030-01-01' };
    const e1 = { d: '2030-01-09', i: 12, r: 3, l: 0, f: '2030-01-01', t: '2030-01-03', pt: '2030-01-02' }, e2 = { d: '2030-01-04', i: 1, r: 0, l: 1, f: '2030-01-01', t: '2030-01-03', pt: '2030-01-02' };
    await page.evaluate(([c, e1]) => {
      window.__store.set('data/users/u_test/srs', { map: { p1: c } }); window.__saveStore();
      localStorage.setItem('kaikou:held', JSON.stringify({ uid: 'u_test', docs: { srs: { map: { p1: e1 } } }, fresh: {}, drop: {} }));
    }, [c, e1]);
    await page.addInitScript(() => { window.__mockCfg = Object.assign(window.__mockCfg || {}, { readDelay: { srs: [20, 1500] } }); });
    await reloadAfterWrites(page);
    await until(page, () => !!document.querySelector('[data-fk="held-up"]'), null, 6000);
    await page.click('[data-fk="held-up"]');
    await page.waitForTimeout(300); // the cloud is being read
    await page.evaluate(e2 => { const h = JSON.parse(localStorage.getItem('kaikou:held')); h.docs.srs.map.p1 = e2; localStorage.setItem('kaikou:held', JSON.stringify(h)); }, e2);
    await until(page, () => !window.__kaikouTest.S.uploading, null, 10000);
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => ({ cloud: window.__store.get('data/users/u_test/srs').map.p1, held: JSON.parse(localStorage.getItem('kaikou:held') || '{}').docs.srs.map.p1, offer: !!document.querySelector('[data-fk="held-up"]') }));
    check('存到雲端途中另一個分頁又評了同一句：不會把舊的評分拆一半送到雲端，新的評分整筆留著、還會提醒', () => eq(r, { cloud: c, held: e2, offer: true }));
    await ctx.close();
  }
  if (want('4')) {
    // y7. 存到雲端 while this tab cannot keep its record of changes on their way (storage full), so what was sent leaves
    //     this browser's record only once the cloud has it. While the cloud is read, another tab takes back a kept tick
    //     (not sent then), and ticks it again before the upload lands: that tick stays kept (it was never sent).
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'held-deferred', { persist: true }, noFocusRefresh);
    const m = await page.evaluate(() => window.__mockToday.slice(0, 7));
    await page.evaluate(m => {
      const k = window.__mockToday;
      localStorage.setItem('kaikou:held', JSON.stringify({ uid: 'u_test', docs: { inbox: { map: { d1: { id: 'd1', text: '延後扣掉時的句子', at: 1 } } }, ['log-' + m]: { days: { [k]: { items: { listen: true } } } } }, fresh: { inbox: { d1: 1 }, ['log-' + m]: { [k + '|listen']: 1 } }, drop: {} }));
    }, m);
    await page.addInitScript(() => { window.__mockCfg = Object.assign(window.__mockCfg || {}, { readDelay: { inbox: [20, 1500] }, writeDelay: { inbox: 1500 } }); });
    await reloadAfterWrites(page);
    await until(page, () => !!document.querySelector('[data-fk="held-up"]'), null, 6000);
    await page.evaluate(() => { const real = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (String(k).startsWith('kaikou:unsent:')) { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; } return real.call(this, k, v); }; });
    const setListen = on => page.evaluate(([m, on]) => {
      const h = JSON.parse(localStorage.getItem('kaikou:held')), k = window.__mockToday, n = 'log-' + m;
      if (on) { h.docs[n] = { days: { [k]: { items: { listen: true } } } }; h.fresh[n] = { [k + '|listen']: 1 }; } else { delete h.docs[n]; delete h.fresh[n]; }
      localStorage.setItem('kaikou:held', JSON.stringify(h));
    }, [m, on]);
    await page.click('[data-fk="held-up"]');
    await page.waitForTimeout(300); // the cloud is being read
    await setListen(false); // taken back in another tab (it was only ticked here: nothing to upload)
    await until(page, () => window.__kaikouTest.Store.busyDoc('inbox'), null, 6000); // the note is on its way (1.5 s)
    await setListen(true); // ticked again
    await until(page, () => !window.__kaikouTest.S.uploading, null, 10000);
    const r = await page.evaluate(m => { const h = JSON.parse(localStorage.getItem('kaikou:held') || 'null'), k = window.__mockToday;
      return { kept: !!(h && h.docs['log-' + m] && h.docs['log-' + m].days[k].items.listen), note: !!(h && h.docs.inbox), cloud: !!(((window.__store.get('data/users/u_test/log-' + m) || { days: {} }).days[k] || { items: {} }).items.listen), offer: !!document.querySelector('[data-fk="held-up"]') }; }, m);
    check('存到雲端時這個分頁記不住送出中的變更（等雲端收下才從瀏覽器的紀錄拿掉）：上傳途中另一個分頁取消又打勾的項目沒送出，就照樣留著、還會提醒', () => eq(r, { kept: true, note: false, cloud: false, offer: true }));
    await ctx.close();
  }
  if (want('4')) {
    // z6. Changes are kept for the cloud on this browser: merging a backup file waits until they are saved (or dropped),
    //     and says so; afterwards it merges.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'import-held', { noDb: true, persist: true }, noFocusRefresh);
    await page.fill('#inbox-input', '匯入前留著的句子');
    await page.click('#inbox-form .btn');
    await until(page, () => /匯入前留著的句子/.test(localStorage.getItem('kaikou:held') || ''), null, 4000);
    await page.addInitScript(() => { window.__mockCfg = Object.assign(window.__mockCfg || {}, { noDb: false }); });
    await reloadAfterWrites(page);
    await until(page, () => !!document.querySelector('[data-fk="held-up"]'), null, 6000);
    const file = { app: 'kaikou-practice', v: 1, at: new Date().toISOString(), docs: { inbox: { map: { imp1: { id: 'imp1', text: '備份檔裡的句子', at: 5 } } } } };
    await page.click('#btn-settings');
    await page.setInputFiles('#set-import-file', { name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
    await until(page, () => !!document.querySelector('[data-fk="imp-go"]'), null, 4000);
    await page.click('[data-fk="imp-go"]');
    await until(page, () => /先在今日頁按「存到雲端」/.test(document.querySelector('#toast').textContent), null, 4000).catch(() => {});
    const inCloud = () => page.evaluate(() => window.__kaikouTest.normInbox(window.__store.get('data/users/u_test/inbox')).some(x => x.text === '備份檔裡的句子'));
    const blocked = { toast: await page.evaluate(() => document.querySelector('#toast').textContent), still: await page.evaluate(() => !!document.querySelector('[data-fk="imp-go"]')), merged: await inCloud() };
    await page.click('#set-done');
    await page.click('[data-fk="held-up"]');
    await until(page, () => !window.__kaikouTest.S.uploading && !window.__kaikouTest.S.held, null, 10000);
    await page.click('#btn-settings');
    await page.click('[data-fk="imp-go"]');
    await until(page, () => !window.__kaikouTest.S.importing && !window.__kaikouTest.S.uploading, null, 6000);
    await until(page, () => !window.__kaikouTest.Store.busyDoc('inbox'), null, 6000);
    const after = await inCloud();
    check('這台裝置上還有留著要存到雲端的變更時匯入備份檔：先說明、不合併（檔案還在），存到雲端後再按就合併', () => {
      assert.ok(/先在今日頁按「存到雲端」/.test(blocked.toast), blocked.toast);
      eq([blocked.still, blocked.merged, after], [true, false, true]);
    });
    await ctx.close();
  }
  if (want('4')) {
    // z7. Two tabs cannot reach the cloud. Tab A has this browser's copy of the settings (it knows them); tab B opens
    //     after the copies were removed (it does not know them) and changes the coach level, writing a copy that holds
    //     only the defaults and that change: A keeps the settings it knows.
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    await ctx.clock.install({ time: NOON });
    const A = await addPage(ctx, ARTIFACT, 'part-A', { noDb: true }, noFocusRefresh);
    await A.evaluate(() => localStorage.setItem('kaikou:settings', JSON.stringify({ plan: '20', level: 'B1', about: 'I live in Taipei and work in marketing.', accent: 'en-US', voiceURI: '', rate: 0.95, autoSpeak: false, shRate: 0.85 })));
    await reloadAfterWrites(A);
    const known = await A.evaluate(() => window.__kaikouTest.S.settingsRead);
    await A.evaluate(() => localStorage.removeItem('kaikou:settings'));
    await settle(A);
    const B = await addPage(ctx, ARTIFACT, 'part-B', { noDb: true }, noFocusRefresh);
    await seeWrites(B, () => !localStorage.getItem('kaikou:settings'));
    await B.click('#btn-settings');
    await B.click('[data-fk="slvl-A2"]');
    await B.click('#set-done');
    await until(A, () => !!(JSON.parse(localStorage.getItem('kaikou:settings') || '{}'))._part, null, 6000);
    await A.waitForTimeout(300);
    const r = await A.evaluate(() => ({ read: window.__kaikouTest.S.settingsRead, lost: window.__kaikouTest.S.settingsLost, about: window.__kaikouTest.S.settings.about }));
    check('兩個連不上雲端的分頁：知道設定的分頁，不會因為另一個不知道設定的分頁改了程度（副本只有預設值和那一項）就變成不知道設定', () => eq([known, r], [true, { read: true, lost: false, about: 'I live in Taipei and work in marketing.' }]));
    await ctx.close();
  }
  if (want('4')) {
    // z8. A viewer whose link could not write has this browser's copies but no record of changes (as an earlier version
    //     of the page left them), and the settings copy was written while the settings were not known: 再試一次存到雲端
    //     does not upload that copy (it holds the defaults), so the cloud's settings stay.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'retry-part', { owner: false, readOnlyWrites: true, failReads: { settings: 99 } }, noFocusRefresh);
    await page.fill('#inbox-input', '檢視者記的句子');
    await page.click('#inbox-form .btn');
    await until(page, () => window.__kaikouTest.Store.mode === 'local', null, 6000);
    await page.click('#btn-settings');
    await page.click('[data-fk="slvl-A2"]');
    await until(page, () => !!(JSON.parse(localStorage.getItem('kaikou:settings') || '{}'))._part, null, 4000);
    await page.evaluate(() => { localStorage.removeItem('kaikou:held'); const c = window.__mockCfg; c.readOnlyWrites = false; c.failReads.settings = 0; });
    await page.click('#set-cloud');
    await until(page, () => window.__kaikouTest.Store.mode === 'db' && !window.__kaikouTest.S.uploading, null, 10000);
    await page.waitForTimeout(500);
    const r = await page.evaluate(() => { const st = window.__store.get('data/users/u_test/settings'); return { level: st.level, about: st.about, part: '_part' in st, note: window.__kaikouTest.normInbox(window.__store.get('data/users/u_test/inbox')).some(x => x.text === '檢視者記的句子') }; });
    check('沒有變更紀錄、設定的副本是不知道設定時寫的：再試一次存到雲端不會把它（預設值）存進雲端，其他資料照樣搬上去', () => eq(r, { level: 'B1', about: 'I live in Taipei and work in marketing.', part: false, note: true }));
    await ctx.close();
  }
  if (want('4')) {
    // z4. The settings could not be read, then the cloud stops, and a backup file is merged: its settings are not taken
    //     (what is shown are only the defaults), and the message says so.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'import-settings-unread', { failReads: { settings: 99 }, failWrites: { inbox: { n: 1, code: 'revoked' } } }, noFocusRefresh);
    await page.fill('#inbox-input', '設定讀不到時記的句子');
    await page.click('#inbox-form .btn');
    await until(page, () => window.__kaikouTest.Store.mode === 'local', null, 6000);
    await page.click('#btn-settings');
    const file = { app: 'kaikou-practice', v: 1, at: new Date().toISOString(), docs: { settings: { plan: '60', level: 'A2', about: 'ABOUT FROM AN OLD FILE', accent: 'en-GB', voiceURI: '', rate: 0.8, autoSpeak: true, shRate: 0.85 } } };
    await page.setInputFiles('#set-import-file', { name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
    await until(page, () => !!document.querySelector('[data-fk="imp-go"]'), null, 4000);
    await page.click('[data-fk="imp-go"]');
    await until(page, () => !window.__kaikouTest.S.importing && !window.__kaikouTest.S.uploading, null, 6000);
    const r = await page.evaluate(() => ({ level: window.__kaikouTest.S.settings.level, held: !!(JSON.parse(localStorage.getItem('kaikou:held') || '{}').docs || {}).settings, toast: document.querySelector('#toast').textContent }));
    check('設定讀不到時雲端又停止，這時匯入備份檔：不帶入備份檔裡的設定（畫面上只是預設值），訊息會說明', () => {
      eq([r.level, r.held], ['B1', false]);
      assert.ok(/備份檔裡的設定沒有帶入/.test(r.toast), r.toast);
    });
    await ctx.close();
  }
  if (want('4')) {
    // h2. Another device started a newer chat; before this page reads it, the learner discards the older chat shown
    //     here: the newer chat is not ended. Discarding the chat that is still the stored one ends it.
    const { ctx, page } = await open(ARTIFACT + '#coach', { viewport: { width: 1000, height: 800 } }, 'discard-newer', null, noFocusRefresh);
    await until(page, () => !!document.querySelector('[data-fk="discard"]'), null, 6000);
    const other = () => page.evaluate(() => { const now = Date.now(); window.__store.set('data/users/u_test/chat', { active: true, id: 'Y-on-phone', mode: 'free', level: 'B1', topicZh: '工作', topicEn: 'work', sceneZh: '', sceneEn: '', aiRole: '', meRole: '', startedAt: now - 60000, updatedAt: now, lastAt: now, activeMs: 60000, meCount: 1, turns: [{ r: 'c', t: 'How is work going?', at: now - 60000 }, { r: 'm', t: 'Work is busy this week.', at: now }] }); });
    const discard = async () => { await page.click('[data-fk="discard"]'); await page.waitForTimeout(700); await page.click('[data-fk="discard"]'); await page.waitForTimeout(400); await until(page, () => !window.__kaikouTest.Store.busyDoc('chat'), null, 6000); };
    await other();
    await discard();
    const kept = await page.evaluate(() => { const c = window.__store.get('data/users/u_test/chat'); return [c.active, c.id]; });
    await page.click('#start-btn');
    await notBusy(page);
    await until(page, () => !window.__kaikouTest.Store.busyDoc('chat'), null, 6000);
    const mine = await page.evaluate(() => window.__kaikouTest.S.chat.id);
    await discard();
    const ended = await page.evaluate(() => { const c = window.__store.get('data/users/u_test/chat'); return [c.active, c.endedId]; });
    check('別台裝置已經開了新的對話，這裡放棄舊的對話：不會把新的那個結束掉；放棄的是雲端上的那個對話時，照樣標記結束', () => eq([kept, ended], [[true, 'Y-on-phone'], [false, mine]]));
    await ctx.close();
  }
  if (want('4')) {
    // h3. The chat is discarded while it cannot be read (so its end cannot be written then): the next read that finds it
    //     as it was writes the end, and it does not come back on a later visit. One continued on another device after
    //     this page read it is left as it is: when discarded, and when found by that later read.
    const { ctx, page } = await open(ARTIFACT + '#coach', { viewport: { width: 1000, height: 800 } }, 'discard-unread', { persist: true }, noFocusRefresh);
    await until(page, () => !!document.querySelector('[data-fk="discard"]'), null, 6000);
    const stored = () => page.evaluate(() => { const c = window.__store.get('data/users/u_test/chat'); return [c.active !== false, c.active === false ? c.endedId : c.id]; });
    const failed = () => page.evaluate(() => window.__dbCalls.filter(c => c.op === 'get' && c.name === 'chat' && c.code).length);
    // While reads fail, the discard waits for its read and the one retry of it to have failed.
    const discard = async unread => {
      const n = await failed();
      await pressTwice(page, '[data-fk="discard"]');
      if (unread) await until(page, x => window.__dbCalls.filter(c => c.op === 'get' && c.name === 'chat' && c.code).length >= x + 2, n, 6000);
      await page.waitForTimeout(400);
      await until(page, () => !window.__kaikouTest.Store.busyDoc('chat'), null, 6000);
    };
    const reads = n => page.evaluate(x => { window.__mockCfg.failReads.chat = x; }, n);
    const continued = () => page.evaluate(() => { const c = JSON.parse(JSON.stringify(window.__store.get('data/users/u_test/chat'))); const now = Date.now() + 1000; c.turns.push({ r: 'm', t: 'I kept talking on my phone.', at: now }); c.updatedAt = now; c.lastAt = now; c.meCount = (c.meCount || 0) + 1; window.__store.set('data/users/u_test/chat', c); });
    const start = async () => { await page.click('#start-btn'); await notBusy(page); await until(page, () => !!window.__kaikouTest.S.chat && !window.__kaikouTest.Store.busyDoc('chat'), null, 6000); return page.evaluate(() => window.__kaikouTest.S.chat.id); };
    const id1 = await page.evaluate(() => window.__kaikouTest.S.chat.id);
    await reads(99);
    await discard(true);
    const a = await stored();
    await ff(page, 181000); // read again while it still cannot be read
    await page.waitForTimeout(500);
    const b = await stored();
    await reads(0);
    await ff(page, 181000);
    await until(page, () => window.__store.get('data/users/u_test/chat').active === false, null, 6000).catch(() => {});
    const c = await stored();
    await page.reload();
    await until(page, () => window.__kaikouTest.S.ready && window.__kaikouTest.S.started, null, 10000);
    const back = await page.evaluate(() => !!window.__kaikouTest.S.chat);
    // Continued on the phone after this page read it, then discarded here.
    const id2 = await start();
    await continued();
    await discard(false);
    const d = await stored();
    // The same, discarded while it cannot be read: the read that finds it later leaves it as it is.
    const id3 = await start();
    await reads(99);
    await discard(true);
    await continued();
    await reads(0);
    await ff(page, 181000);
    await page.waitForTimeout(800);
    const e = await stored();
    const pending = await page.evaluate(() => window.__kaikouTest.S.endPending);
    // Discarded while it cannot be read, and the page closed before it could be: the next visit writes the end.
    const id4 = await start();
    await reads(99);
    await discard(true);
    await page.reload();
    await until(page, () => window.__kaikouTest.S.ready && window.__kaikouTest.S.started, null, 10000);
    await until(page, () => window.__store.get('data/users/u_test/chat').active === false, null, 6000).catch(() => {});
    const g = [await stored(), await page.evaluate(() => !!window.__kaikouTest.S.chat || !!localStorage.getItem('kaikou:end-pending'))];
    check('讀不到對話時放棄它：之後讀到它還是原樣就標記結束（頁面先關掉了，下次打開時也一樣），重新打開不會又出現；這裡讀過之後別台裝置接著聊過的，放棄時或之後讀到時都不動它', () => {
      eq([a, b, c, back], [[true, id1], [true, id1], [false, id1], false]);
      eq([d, e, pending], [[true, id2], [true, id3], null]);
      eq(g, [[false, id4], false]);
    });
    await ctx.close();
  }
  if (want('4')) {
    // t2. Two-step confirmations are not passed by a double click (the second click lands on the confirming button,
    //     drawn in the same place): 放棄 and the trash buttons of a note and of a saved phrase.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'double-confirm', null, noFocusRefresh);
    await page.click('#t-coach');
    await until(page, () => !!window.__kaikouTest.S.chat, null, 6000);
    await page.dblclick('[data-fk="discard"]');
    await page.click('#t-today');
    await page.dblclick('#inbox-list [data-fk^="del-"]');
    await page.click('#t-saved');
    await page.dblclick('#saved-list [data-fk^="del-"]');
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => { const S = window.__kaikouTest.S; return { chat: !!S.chat, inbox: S.inbox.length, phrases: S.phrases.length }; });
    await page.waitForTimeout(500);
    await page.click('#saved-list [data-fk^="del-"]'); // a deliberate second press still confirms
    const later = await page.evaluate(() => window.__kaikouTest.S.phrases.length);
    check('要按兩次確認的按鈕（放棄、刪除隨手記、刪除收藏）連點兩下不會直接執行；隔一下再按才確認', () => eq([r, later], [{ chat: true, inbox: 2, phrases: 3 }, 2]));
    await ctx.close();
  }
  if (want('4')) {
    // k2. Claude answers use('sample') only after the page is ready (it may ask the viewer first): the shadowing tool
    //     that is already open offers the coach then (not "連線中…" for good).
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'late-sample', { sampleDelay: 2500 });
    await page.click('[data-fk="go-shadow"]');
    const before = await page.evaluate(() => [window.__kaikouTest.S.sampleState, !!document.querySelector('[data-fk="sh-gen"]')]);
    await until(page, () => window.__kaikouTest.S.sampleState === 'ok', null, 8000);
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => !!document.querySelector('[data-fk="sh-gen"]') && !/連線中/.test(document.querySelector('#today-dyn').textContent));
    check('Claude 晚一點才讓頁面用教練（例如先問過你）：已經打開的跟讀頁面那時就能請教練寫短文', () => eq([before, after], [['loading', false], true]));
    await ctx.close();
  }
  if (want('4')) {
    // m2. A hint does not replace what the learner wrote without asking: the first tap says so, a second tap replaces
    //     it. A hint put there before is replaced at once.
    const { ctx, page } = await open(ARTIFACT + '#coach', { viewport: { width: 1000, height: 800 } }, 'hint-draft', null, noFocusRefresh);
    await until(page, () => !!window.__kaikouTest.S.chat && !document.querySelector('#hint-btn').disabled, null, 6000);
    await page.fill('#msg-input', 'We saw a lot of birds on the way up');
    await page.click('#hint-btn');
    await until(page, () => document.querySelectorAll('#hints .hint').length > 1, null, 6000);
    await page.dblclick('[data-fk="hint-0"]'); // a double click is one tap here
    const first = await page.evaluate(() => ({ box: document.querySelector('#msg-input').value, toast: document.querySelector('#toast').textContent }));
    await page.waitForTimeout(700);
    await page.click('[data-fk="hint-0"]');
    const second = await page.evaluate(() => document.querySelector('#msg-input').value);
    await page.click('[data-fk="hint-1"]');
    const third = await page.evaluate(() => document.querySelector('#msg-input').value);
    const hints = await page.evaluate(() => [...document.querySelectorAll('#hints .hint-en')].map(n => n.textContent));
    check('輸入框裡有自己寫的句子時點提示：第一下先提醒、不會換掉（連點兩下也一樣），隔一下再點才換；換成提示之後再點別的提示就直接換', () => {
      eq(first.box, 'We saw a lot of birds on the way up');
      assert.ok(/再點一次/.test(first.toast), first.toast);
      eq([second, third], [hints[0], hints[1]]);
    });
    await ctx.close();
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
    const flash = await T(() => !!document.querySelector('.time-up')); // time is up: the screen flashes too (a muted iPhone plays no beep)
    await page.click('[data-fk="f432-next"]');
    await ff(page, 181000);
    await until(page, () => window.__kaikouTest.S.f432.state === 'gap' && window.__kaikouTest.S.f432.phase === 2);
    await page.click('[data-fk="f432-next"]');
    await until(page, () => window.__kaikouTest.S.f432.state === 'run');
    await page.click('[data-fk="f432-end"]');
    await until(page, () => window.__kaikouTest.S.f432.state === 'done');
    await until(page, () => !window.__kaikouTest.Store.busyDoc('log-' + window.__mockToday.slice(0, 7)));
    const f = await T(() => ({ ticked: !!window.__store.get('data/users/u_test/log-' + window.__mockToday.slice(0, 7)).days[window.__mockToday].items.f432, title: document.querySelector('.timer-title').textContent, rec: !!document.querySelector('[data-fk="f432-rec"]'), tag: document.querySelector('#today-dyn .tag').textContent }));
    await page.click('[data-fk="f432-again"]');
    const againFocus = await T(() => document.activeElement && document.activeElement.textContent);
    check('4/3/2：教練給重點（想重點時換了主題就不顯示舊的），計時可暫停、進度條報剩下的時間，時間到畫面也閃一下，三次講完自動打勾本週的 4/3/2；換主題再練後焦點到標題', () => {
      eq(stale, { topic: 'trip', points: null, shown: 0 });
      eq([c1, c2], ['3:55', '3:55']);
      assert.ok(bar30[0] >= 10 && bar30[0] <= 20 && /^還剩 3:2\d$/.test(bar30[1]), bar30.join(' '));
      eq([gap, flash], ['第 1 次完成！', true]);
      eq(f, { ticked: true, title: '三次都講完了！', rec: false, tag: '本週 1 / 1' });
      eq(againFocus, '4/3/2 口說');
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

  if (want('5')) {
    // Details on a computer in Claude: 先到這裡 before the last card; a passage that arrives while 教練 is shown; a double
    // click on a star; 4/3/2 talking points that arrive while the learner composes a custom topic with an input method.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 600 } }, 'ui-details', null, noFocusRefresh);
    const T = (f, a) => page.evaluate(f, a);
    await page.click('#t-saved');
    await page.click('[data-fk="drill-start"]');
    await page.click('[data-fk="flip"]');
    await page.click('[data-fk="rate-2"]');
    await page.click('[data-fk="drill-end"]');
    const early = await T(() => ({ title: document.querySelector('#drill h2').textContent, more: (document.querySelector('[data-fk="drill-more"]') || {}).textContent || '' }));
    await page.click('[data-fk="drill-close"]');
    check('句子複習還沒到最後一張就按「先到這裡」：說「先複習到這裡」（不是這一輪完成了），按鈕是繼續複習', () => {
      eq(early.title, '先複習到這裡');
      assert.ok(/^繼續複習（\d+ 句）$/.test(early.more), early.more);
    });

    const n0 = await T(() => window.__kaikouTest.S.phrases.length);
    await page.locator('#starters .icon-btn[aria-pressed="false"][aria-label="收藏"]').first().dblclick();
    await page.waitForTimeout(300);
    const starred = await T(() => window.__kaikouTest.S.phrases.length);
    check('連點兩下收藏的星號：收藏一次（不會收藏了又取消）', () => eq(starred, n0 + 1));

    // A long chat on 教練, scrolled to its end, while the coach writes a passage on 今日.
    await T(() => { const c = window.__kaikouTest.S.chat; for (let i = 0; i < 8; i++) c.turns.push({ r: 'm', t: 'A sentence to make this chat long enough to scroll, number ' + i + '.', at: Date.now() }, { r: 'c', t: 'A reply to make this chat longer, number ' + i + '.', raw: 'Reply ' + i, at: Date.now() }); });
    await T(() => { window.__mockCfg.jsonDelay = 1500; });
    await page.click('#t-today');
    await page.click('[data-fk="go-shadow"]');
    await page.click('[data-fk="sh-gen"]');
    await page.click('#t-coach');
    await T(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const y0 = await T(() => Math.round(window.scrollY));
    await until(page, () => !window.__kaikouTest.S.shGen.busy, null, 8000);
    await page.waitForTimeout(200);
    const scroll = await T(y => ({ moved: Math.round(window.scrollY) !== y, tab: window.__kaikouTest.S.tab, passage: window.__kaikouTest.S.shadow.list.length > 0 }), y0);
    check('在教練分頁時跟讀短文才寫好：教練分頁不會被捲到最上面', () => { assert.ok(y0 > 200, 'scrolled down: ' + y0); eq(scroll, { moved: false, tab: 'coach', passage: true }); });

    // 4/3/2: the learner composes a custom topic with Zhuyin while the points for an earlier topic arrive (dropped), and
    // while the points for this topic arrive (the topic changed meanwhile: the loading row goes once the word is done).
    await page.click('#t-today');
    await page.click('[data-fk="tool-back"]');
    await page.click('[data-fk="go-f432"]');
    const cdp = await ctx.newCDPSession(page);
    const compose = async () => {
      await page.focus('#f432-custom');
      await page.keyboard.press('End');
      await cdp.send('Input.imeSetComposition', { text: 'ㄊㄨㄢˊ', selectionStart: 4, selectionEnd: 4 });
      await T(() => { document.querySelector('#f432-custom').__mine = true; });
    };
    const box = () => T(() => { const i = document.querySelector('#f432-custom'); return { same: !!i.__mine, value: i.value }; });
    await page.click('[data-fk="f432-points"]'); // points for the first topic
    await page.click('#today-dyn [data-fk="chip-custom"]');
    await page.click('#f432-custom');
    await cdp.send('Input.insertText', { text: '我們' });
    await compose();
    await page.waitForTimeout(1800); // the first topic's points arrive (another topic is chosen now: dropped)
    const dropped = await box();
    await cdp.send('Input.insertText', { text: '團' });
    const done1 = await T(() => window.__kaikouTest.S.f432.custom);
    await page.click('[data-fk="f432-points"]'); // points for 我們團
    await compose();
    await page.waitForTimeout(1800); // they arrive while the word is composed (the topic changed meanwhile)
    const waited = await box();
    await cdp.send('Input.insertText', { text: '隊' });
    await page.waitForTimeout(200);
    const done2 = await T(() => ({ custom: window.__kaikouTest.S.f432.custom, loading: window.__kaikouTest.S.f432.points === 'loading' || !!document.querySelector('#today-dyn .hint-loading') }));
    await T(() => { window.__mockCfg.jsonDelay = 30; });
    check('4/3/2 用注音打自訂主題時教練的重點才到：輸入框不會被換掉，選好的字照常打進去（主題換了之後，等字選好才收起「正在想重點」）', () => {
      eq([dropped, done1], [{ same: true, value: '我們ㄊㄨㄢˊ' }, '我們團']);
      eq([waited, done2], [{ same: true, value: '我們團ㄊㄨㄢˊ' }, { custom: '我們團隊', loading: false }]);
    });

    // 跟讀: the coach's passage arrives while the learner composes a word in the box for their own transcript: the box
    // is not drawn again mid-word, and the passage opens once the word is done.
    await page.click('[data-fk="tool-back"]');
    await page.click('[data-fk="go-shadow"]');
    await T(() => { window.__mockCfg.jsonDelay = 1500; });
    const before = await T(() => window.__kaikouTest.S.shadow.list.length);
    await page.click('[data-fk="sh-gen"]');
    await page.click('#sh-own');
    await cdp.send('Input.insertText', { text: 'We ' });
    await cdp.send('Input.imeSetComposition', { text: 'ㄨ', selectionStart: 1, selectionEnd: 1 });
    await T(() => { document.querySelector('#sh-own').__mine = true; });
    await page.waitForTimeout(1800); // the passage arrives while the word is composed
    const midWord = await T(n => { const t = document.querySelector('#sh-own'); return { same: !!(t && t.__mine), value: t && t.value, open: !!window.__kaikouTest.S.sh, added: window.__kaikouTest.S.shadow.list.length - n }; }, before);
    await cdp.send('Input.insertText', { text: '我' });
    await page.waitForTimeout(300);
    const opened = await T(() => ({ open: !!window.__kaikouTest.S.sh && window.__kaikouTest.S.sh.id === window.__kaikouTest.S.shadow.cur && !!document.querySelector('[data-fk="sh-play"]'), own: window.__kaikouTest.S.shGen.own }));
    await T(() => { window.__mockCfg.jsonDelay = 30; });
    check('跟讀短文在用輸入法選字時才寫好：輸入框不會被換掉，字選好之後才打開短文', () => {
      eq(midWord, { same: true, value: 'We ㄨ', open: false, added: 1 });
      eq(opened, { open: true, own: 'We 我' });
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
    await pressTwice(page, '[data-fk="discard"]');
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
  if (want('6')) {
    // A recognition that ends by itself without confirming its words (some versions of Safari never confirm them): the
    // words stay in the box, and 唸一次 checks them instead of saying that nothing was heard.
    const { ctx, page } = await open(base + '#coach', { viewport: { width: 1000, height: 800 }, serviceWorkers: 'block' }, 'interim-only', null, speech);
    await giveKey(page, 'sk-ant-api03-' + 'TESTONLY'.repeat(6) + '-AA');
    await page.route('https://api.anthropic.com/v1/messages', route => sseReply(route, 'Hi! What did you do last weekend?\n###\n{"none": true}'));
    await page.click('#start-btn');
    await notBusy(page);
    await page.evaluate(() => window.__srScript.push({ interimOnly: 'we went to the beach', wait: 200, hold: 900 }));
    await page.click('#mic-btn');
    await until(page, () => window.__srStarts.length === 1 && !window.__kaikouTest.Mic.cur, null, 5000);
    const box = await page.evaluate(() => document.querySelector('#msg-input').value);
    await page.click('#t-saved');
    await page.evaluate(() => window.__srScript.push({ interimOnly: 'sorry could you say that again', wait: 200, hold: 900 }));
    const key = await page.evaluate(() => 'st:' + window.__kaikouTest.phraseId('Sorry, could you say that again?'));
    await page.click('[data-say-btn="' + key + '"]');
    await until(page, () => window.__srStarts.length === 2 && !window.__kaikouTest.Mic.cur, null, 5000);
    await page.waitForTimeout(150);
    const said = await page.evaluate(k => document.querySelector('[data-say="' + k + '"]').textContent, key);
    check('辨識自己結束、但字都沒有確定時：聽寫的字留在輸入框，唸一次照樣比對，不會說沒聽到聲音', () => {
      eq(box, 'we went to the beach');
      assert.ok(/每個字都聽出來了/.test(said) && !/沒有聽到聲音/.test(said), said);
    });
    await ctx.close();
  }

  if (want('6')) {
    // A double click on a tick box, on 唸一次 and on 跟讀's 播放 acts once (it does not undo itself).
    const { ctx, page } = await open(base + '#today', { viewport: { width: 1000, height: 800 }, serviceWorkers: 'block' }, 'double-taps', null, speech);
    const T = (f, a) => page.evaluate(f, a);
    await page.dblclick('[data-fk="ck-ai"]');
    await page.waitForTimeout(200);
    const ticked = await T(() => document.querySelector('[data-fk="ck-ai"]').getAttribute('aria-checked'));
    await page.click('#t-saved');
    const key = await T(() => 'st:' + window.__kaikouTest.phraseId('Sorry, could you say that again?'));
    await T(() => window.__srScript.push({ text: 'sorry could you say that again', wait: 300, hold: 1200 }));
    await page.dblclick('[data-say-btn="' + key + '"]');
    await page.waitForTimeout(150);
    const listening = await T(() => ({ mic: !!window.__kaikouTest.Mic.cur, starts: window.__srStarts.length }));
    await until(page, () => !window.__kaikouTest.Mic.cur, null, 5000);
    await page.waitForTimeout(150);
    const said = await T(k => document.querySelector('[data-say="' + k + '"]').textContent, key);
    await page.click('#t-today');
    await page.click('[data-fk="go-shadow"]');
    await page.fill('#sh-own', 'We went to the beach early in the morning and stayed there until the sun went down. It was a long and happy day for all of us. We want to go back next summer with our friends.');
    await page.click('[data-fk="sh-own-go"]');
    const from = await T(() => window.__speechLog.length);
    await page.dblclick('[data-fk="sh-play"]');
    await page.waitForTimeout(150);
    const play = await T(n => ({ playing: !!window.__kaikouTest.S.sh.playing, log: window.__speechLog.slice(n) }), from);
    check('勾選框、唸一次、跟讀的播放連點兩下只算一下：打勾不會又取消，唸一次照樣在聽、聽完就比對，播放不會馬上停', () => {
      eq(ticked, 'true');
      eq(listening, { mic: true, starts: 1 });
      assert.ok(/每個字都聽出來了/.test(said), said);
      eq(play.playing, true);
      assert.ok(play.log.length >= 1 && /^say:/.test(play.log[0]) && !play.log.includes('cut'), play.log.join(' | '));
    });
    await ctx.close();
  }
  if (want('6')) {
    // 4/3/2 with recording on a computer: 暫停 and 繼續 clicked twice by mistake still pause and go on (once each); a
    // recording that is playing keeps playing when the page redraws in the background (a refresh when the window gets
    // the focus, after this page's own change).
    const { ctx, page } = await open(base + '#today', { viewport: { width: 1000, height: 800 }, serviceWorkers: 'block' }, 'f432-play', null, speech);
    const T = (f, a) => page.evaluate(f, a);
    const state = () => T(() => window.__kaikouTest.S.f432.state);
    await page.click('[data-fk="go-f432"]');
    await page.click('[data-fk="f432-go"]');
    await until(page, () => window.__kaikouTest.S.f432.state === 'run' && !!window.__kaikouTest.Rec.mr && window.__kaikouTest.Rec.mr.state === 'recording', null, 8000);
    await page.dblclick('[data-fk="f432-pause"]');
    await page.waitForTimeout(200);
    const paused = await state();
    await page.dblclick('[data-fk="f432-resume"]');
    await page.waitForTimeout(200);
    const resumed = await state();
    for (let i = 0; i < 3; i++) {
      if (i) { await page.click('[data-fk="f432-next"]'); await until(page, () => window.__kaikouTest.S.f432.state === 'run', null, 8000); }
      await page.waitForTimeout(1200);
      await page.click('[data-fk="f432-end"]');
      await until(page, () => ['gap', 'done'].includes(window.__kaikouTest.S.f432.state), null, 8000);
    }
    await until(page, () => document.querySelectorAll('#today-dyn audio').length === 3, null, 4000);
    const started = await T(() => { const a = document.querySelector('#today-dyn audio'); a.__first = true; a.muted = true; document.querySelector('#today-dyn .recs').__old = true; return a.play().then(() => true, () => false); });
    await page.waitForTimeout(300);
    await ff(page, 16000);
    await T(() => window.dispatchEvent(new Event('focus')));
    await until(page, () => { const r = document.querySelector('#today-dyn .recs'); return !!r && !r.__old; }, null, 6000);
    const after = await T(() => { const a = document.querySelector('#today-dyn audio'); return { same: !!a.__first, paused: a.paused, t: a.currentTime > 0 }; });
    check('4/3/2：連點兩下暫停或繼續只算一下；正在聽的錄音，頁面在背景重新讀取、重畫時不會中斷', () => {
      eq([paused, resumed, started], ['pause', 'run', true]);
      eq(after, { same: true, paused: false, t: true });
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
  if (want('6b')) {
    // During the countdown a short noise is guessed at for a moment and then dropped (no words confirmed): the sentence
    // still goes out, the loop does not count it as silence. And a 換我說 tap that goes down while the coach speaks and
    // comes up just after the microphone opened by itself is not taken for 說完了.
    const KEY = 'sk-ant-api03-' + 'TESTONLY'.repeat(6) + '-AA';
    const voicePage = async (tag, steps) => {
      const { ctx, page } = await open(base + '#coach', { viewport: { width: 1000, height: 800 }, serviceWorkers: 'block' }, tag, null, speech);
      await giveKey(page, KEY);
      const sent = [];
      await page.route('https://api.anthropic.com/v1/messages', route => {
        const msgs = (JSON.parse(route.request().postData() || '{}').messages) || [];
        const last = String((msgs[msgs.length - 1] || {}).content || '');
        if (/^An English learner/.test(last)) return sseReply(route, '[{"en": "Sounds great to me", "zh": "聽起來很棒"}, {"en": "I had a lovely time", "zh": "我玩得很開心"}]');
        if (msgs.length > 1) sent.push(last);
        return sseReply(route, msgs.length > 1 ? 'Great! Tell me more.\n###\n{"none": true}' : 'Hi! What did you do last weekend?\n###\n{"none": true}');
      });
      await page.evaluate(x => window.__srScript.push(...x), steps);
      return { ctx, page, sent };
    };
    const a = await voicePage('voice-noise', [{ text: 'We went to the beach' }, { interimOnly: 'uh', wait: 600, hold: 900, blank: true }]);
    const phases = [];
    await a.page.click('#start-voice');
    for (let i = 0; i < 120 && !a.sent.length; i++) {
      const p = await a.page.evaluate(() => window.__kaikouTest.Voice.phase + '|' + document.querySelector('#voice-bar').textContent);
      if (phases[phases.length - 1] !== p) phases.push(p);
      await a.page.waitForTimeout(100);
    }
    await a.ctx.close();
    // The tap: down on 換我說 while the opening is spoken, up after the microphone has opened by itself.
    const b = await voicePage('voice-tap', [{ text: 'It was sunny', wait: 1500, hold: 2500 }]);
    await b.page.click('#start-voice');
    await until(b.page, () => window.__kaikouTest.Voice.phase === 'speaking', null, 8000);
    const label = await b.page.evaluate(() => document.querySelector('#mic-btn').getAttribute('aria-label'));
    await b.page.dispatchEvent('#mic-btn', 'pointerdown');
    await until(b.page, () => window.__kaikouTest.Voice.phase === 'listening', null, 8000);
    await b.page.dispatchEvent('#mic-btn', 'click');
    await b.page.waitForTimeout(600);
    const tap = await b.page.evaluate(() => ({ phase: window.__kaikouTest.Voice.phase, mic: !!window.__kaikouTest.Mic.cur }));
    await b.ctx.close();
    // A hint tapped during the countdown pauses first: what was said is not sent while the tap only asks whether to
    // replace it; a second tap replaces it.
    const c = await voicePage('voice-hint', []);
    await c.page.click('#start-voice');
    await until(c.page, () => /一直沒有聽到聲音/.test(document.querySelector('#voice-bar').textContent), null, 15000);
    await c.page.click('#hint-btn');
    await until(c.page, () => document.querySelectorAll('#hints .hint').length === 2, null, 8000);
    await c.page.evaluate(() => window.__srScript.push({ text: 'I stayed at home all day' }));
    await c.page.click('[data-fk="vb-go"]');
    await until(c.page, () => window.__kaikouTest.Voice.phase === 'countdown', null, 8000);
    await c.page.click('[data-fk="hint-0"]');
    const asked = await c.page.evaluate(() => ({ phase: window.__kaikouTest.Voice.phase, box: document.querySelector('#msg-input').value, toast: document.querySelector('#toast').textContent }));
    await c.page.waitForTimeout(3200); // longer than the countdown
    const later = await c.page.evaluate(() => ({ phase: window.__kaikouTest.Voice.phase, box: document.querySelector('#msg-input').value }));
    await c.page.click('[data-fk="hint-0"]');
    const replaced = await c.page.evaluate(() => document.querySelector('#msg-input').value);
    const hintSent = c.sent.slice();
    await c.ctx.close();
    check('語音對話：倒數時一個雜音被猜成字又撤回，那句照樣送出（不會當成沒聲音而暫停）；教練說話時按下「換我說」、麥克風剛打開才放開，不會被當成「說完了」', () => {
      eq(a.sent.length === 1 && /^We went to the beach/.test(a.sent[0]), true);
      assert.ok(!phases.some(p => /一直沒有聽到聲音/.test(p)), phases.join(' → '));
      eq(label, '換我說');
      eq(tap, { phase: 'listening', mic: true });
    });
    check('語音對話：倒數時點提示會先暫停，說的那句不會自己送出；隔一下再點才換成提示', () => {
      eq([asked.phase, asked.box], ['paused', 'I stayed at home all day']);
      assert.ok(/再點一次/.test(asked.toast), asked.toast);
      eq([later, replaced, hintSent], [{ phase: 'paused', box: 'I stayed at home all day' }, 'Sounds great to me', []]);
    });
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
    // Saving is not possible in this view (a lifecycle code, or one the page does not know), or this request failed.
    const saveToast = async code => {
      await p2.evaluate(c => { window.__mockCfg.saveFail = c; document.querySelector('#toast').textContent = ''; }, code);
      await p2.click('#set-export');
      await until(p2, () => !window.__kaikouTest.S.exporting && !!document.querySelector('#toast').textContent, null, 8000);
      return p2.evaluate(() => document.querySelector('#toast').textContent);
    };
    const notHere = [await saveToast('not_granted'), await saveToast('unavailable'), await saveToast('some_new_code')];
    const tryAgain = await saveToast('bad_request');
    await p2.evaluate(() => { window.__mockCfg.saveFail = ''; });
    check('Claude 版匯出：不想下載就不多說；還有一個下載在等你確認、這個畫面不能下載、這次沒存成，各有說明', () => {
      eq([declined, waiting], [{ toast: '', files: 2 }, '已經有一個下載在等你確認']);
      eq(notHere, Array(3).fill('這個畫面不能下載檔案'));
      eq(tryAgain, '沒有存成檔案，再試一次');
    });
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

  if (want('7')) {
    // A month that already holds 148 reviews takes only two more from a file: none of its own reviews is pushed out,
    // and the message counts only what was added.
    const m = dayKey(0).slice(0, 7);
    const seed = "window.__mockSeed = (store, P, dk, back) => { const map = {}; for (let i = 0; i < 148; i++) map['old' + i] = { id: 'old' + i, date: dk(back(0)), at: 1000 + i, mode: 'free', label: '舊的', level: 'B1', minutes: 5, count: 3, summary: '舊的複習', strengths: [], patterns: [], phrases: [], next: '' }; store.set(P('sessions-' + dk(back(0)).slice(0, 7)), { map }); };";
    const file = path.join(out, 'backup-month-full.json');
    const map = Object.fromEntries(Array.from({ length: 5 }, (_, i) => ['new' + i, { id: 'new' + i, date: dayKey(0), at: 500 + i, mode: 'free', label: '新的', level: 'B1', minutes: 5, count: 3, summary: '新的複習', strengths: [], patterns: [], phrases: [], next: '' }]));
    fs.writeFileSync(file, JSON.stringify({ app: 'kaikou-practice', v: 1, docs: { ['sessions-' + m]: { map } } }));
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'import-month-full', null, seed);
    await page.click('#btn-settings');
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#set-import')]);
    await fc.setFiles(file);
    await until(page, () => !document.querySelector('#set-import-box').hidden);
    await page.click('[data-fk="imp-go"]');
    await until(page, () => document.querySelector('#toast').textContent.startsWith('已合併'));
    await until(page, mm => !window.__kaikouTest.Store.busyDoc('sessions-' + mm), m, 6000);
    const r = await page.evaluate(mm => {
      const d = window.__store.get('data/users/u_test/sessions-' + mm).map;
      return { old: Object.keys(d).filter(k => /^old/.test(k) && d[k]).length, added: Object.keys(d).filter(k => /^new/.test(k) && d[k]).length, toast: document.querySelector('#toast').textContent };
    }, m);
    check('匯入的對話複習放不下時：只加放得下的，不會把這個月原本的複習擠掉，提示只算真的加進來的', () => {
      eq([r.old, r.added], [148, 2]);
      assert.ok(r.toast.includes('對話複習 2 次') && r.toast.includes('放不下'), r.toast);
    });
    await ctx.close();
  }

  if (want('7')) {
    // At the size limit of a month: a review that would make the month's document too large is not added (also when
    // only its own key tips it over), and none of the month's reviews is pushed out for it.
    const today = dayKey(0), m = today.slice(0, 7), now = NOON.getTime();
    const LIMIT = 200 * 1024 * 0.8, bytes = o => Buffer.byteLength(JSON.stringify(o), 'utf8');
    const review = (id, at, summary) => ({ id, date: today, at, mode: 'free', label: id, level: 'B1', minutes: 5, count: 3, summary, strengths: [], patterns: [], phrases: [], next: '' });
    const incoming = review('EDGE', now, 'x'.repeat(200));
    const docOf = K => ({ map: { old1: review('old1', now - 10 * 86400000, 'kept'), big1: review('big1', now - 86400000, 'y'.repeat(K)) } });
    // The month and the new review add up to just under the limit; with the review's key in the map, just over it.
    const K = LIMIT - bytes(incoming) - bytes(docOf(0)) - 4;
    const seed = 'window.__mockSeed = (store, P) => { store.set(P(' + JSON.stringify('sessions-' + m) + '), ' + JSON.stringify(docOf(K)) + '); };';
    const file = path.join(out, 'backup-month-edge.json');
    fs.writeFileSync(file, JSON.stringify({ app: 'kaikou-practice', v: 1, docs: { ['sessions-' + m]: { map: { EDGE: incoming } } } }));
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'import-month-edge', null, seed);
    await page.click('#btn-settings');
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#set-import')]);
    await fc.setFiles(file);
    await until(page, () => !document.querySelector('#set-import-box').hidden);
    await page.click('[data-fk="imp-go"]');
    await until(page, () => document.querySelector('#toast').textContent.startsWith('已合併'));
    await page.waitForTimeout(600);
    await until(page, mm => !window.__kaikouTest.Store.busyDoc('sessions-' + mm), m, 6000);
    const r = await page.evaluate(mm => {
      const X = window.__kaikouTest, cloud = window.__store.get('data/users/u_test/sessions-' + mm) || {};
      return { ids: X.normSessions(cloud).map(x => x.id).sort(), nulls: Object.keys(cloud.map || {}).filter(k => cloud.map[k] === null), shown: (X.S.sessions[mm] || []).map(x => x.id).sort(), toast: document.querySelector('#toast').textContent };
    }, m);
    check('匯入時剛好卡在一個月的大小上限：放不下的複習不加，這個月原本的複習一則都不會被擠掉', () => {
      eq([r.ids, r.nulls, r.shown], [['big1', 'old1'], [], ['big1', 'old1']]);
      assert.ok(r.toast.includes('放不下'), r.toast);
    });
    await ctx.close();
  }

  if (want('7')) {
    // Changes kept from a visit that could not reach the cloud, not uploaded yet, are in a backup made now.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'export-held', { persist: true, failWrites: { inbox: { n: 1, code: 'revoked' } } });
    await page.fill('#inbox-input', '還沒存到雲端就匯出的句子');
    await page.click('#inbox-form .btn');
    await until(page, () => /還沒存到雲端就匯出的句子/.test(localStorage.getItem('kaikou:held') || ''), null, 6000);
    await page.addInitScript(() => { window.__mockCfg = Object.assign(window.__mockCfg || {}, { failWrites: {} }); });
    await reloadAfterWrites(page);
    await until(page, () => !!document.querySelector('[data-fk="held-up"]'), null, 6000);
    await page.click('#btn-settings');
    await page.click('#set-export');
    await until(page, () => window.__downloads.length === 1, null, 8000);
    const has = await page.evaluate(() => window.__kaikouTest.normInbox(JSON.parse(window.__downloads[0].data).docs.inbox).map(x => x.text));
    // This time the cloud cannot be listed: the file has what this device shows, with those changes laid over it.
    await page.evaluate(() => { window.__mockCfg.failList = 2; });
    await page.click('#set-export');
    await until(page, () => window.__downloads.length === 2, null, 8000);
    const part = await page.evaluate(() => ({ inbox: window.__kaikouTest.normInbox(JSON.parse(window.__downloads[1].data).docs.inbox).map(x => x.text).sort(), toast: document.querySelector('#toast').textContent }));
    check('還沒存到雲端的變更（上次連不上雲端時留下的）也會放進匯出的備份檔（讀不到雲端的清單時，和這台裝置上的資料放在一起）', () => {
      eq(has.includes('還沒存到雲端就匯出的句子') && has.includes('這個功能下週才能上線'), true);
      eq(part.inbox, ['還沒存到雲端就匯出的句子', '這個功能下週才能上線', '我們需要再確認一下預算'].sort());
      assert.ok(/讀不到雲端上較舊的月份/.test(part.toast), part.toast);
    });
    await ctx.close();
  }

  if (want('7')) {
    // A hand-made file cannot pin a day's plan for good (a weight no choice can beat) or bring a huge phrase.
    const d = new Date(NOON); d.setDate(d.getDate() - 21);
    const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const file = path.join(out, 'backup-weird.json');
    fs.writeFileSync(file, JSON.stringify({ app: 'kaikou-practice', v: 1, docs: {
      phrases: { map: { 'not-its-id': { en: '  A phrase from a hand-made file.  ', zh: '大'.repeat(60000), note: '', ex: '', src: 'x', at: 5 } } },
      ['log-' + k.slice(0, 7)]: { days: { [k]: { plans: { '9007199254740993': '60', [String(NOON.getTime() + 10 * 86400000)]: '60', 0: '20' }, items: { shadow: true } } } },
    } }));
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'import-weird');
    await page.click('#btn-settings');
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#set-import')]);
    await fc.setFiles(file);
    await until(page, () => !document.querySelector('#set-import-box').hidden);
    await page.click('[data-fk="imp-go"]');
    await until(page, () => document.querySelector('#toast').textContent.startsWith('已合併'));
    await until(page, kk => !window.__kaikouTest.Store.busyDoc('phrases') && !window.__kaikouTest.Store.busyDoc('log-' + kk.slice(0, 7)), k, 6000);
    const r = await page.evaluate(kk => {
      const X = window.__kaikouTest, get = n => window.__store.get('data/users/u_test/' + n);
      const id = X.phraseId('A phrase from a hand-made file.'), p = (get('phrases').map || {})[id];
      // A choice stored by a device whose clock is ahead still counts here.
      const ahead = X.normDay({ plans: { [String(Date.now() + 2 * 86400000)]: '60', 0: '20' } }).plan;
      return { id: !!p, zh: p ? p.zh.length : -1, bogus: 'not-its-id' in (get('phrases').map || {}), weights: Object.keys(get('log-' + kk.slice(0, 7)).days[kk].plans || {}), plan: X.S.logs[kk.slice(0, 7)].days[kk].plan, ahead };
    }, k);
    check('手做的備份檔：不能用超大或未來的權重把某天的計畫鎖住（別台裝置時鐘較快時存的照樣算），收藏的句子照這裡的規則（同一句同一個 id、欄位長度有上限）', () => eq(r, { id: true, zh: 200, bogus: false, weights: ['0'], plan: '20', ahead: '60' }));
    await ctx.close();
  }

  if (want('7')) {
    // An account that has no settings yet merges a backup file: its settings are taken, and the message says so. A note
    // id longer than 40 characters is kept under its first 40, so merging the same file again adds nothing.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'import-long-id', null, "window.__mockSeed = (store, P) => { store.delete(P('settings')); };");
    const file = path.join(out, 'backup-long-id.json');
    fs.writeFileSync(file, JSON.stringify({ app: 'kaikou-practice', v: 1, docs: { settings: { plan: '60', level: 'B2', about: 'I teach maths.', accent: 'en-GB', voiceURI: '', rate: 1, autoSpeak: true, shRate: 0.85 }, inbox: { map: { ['n'.repeat(45)]: { text: 'A NOTE WITH A LONG ID', at: 5 } } } } }));
    await page.click('#btn-settings');
    const merge = async () => {
      const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#set-import')]);
      await fc.setFiles(file);
      await until(page, () => !!document.querySelector('[data-fk="imp-go"]'), null, 4000);
      await page.click('[data-fk="imp-go"]');
      await until(page, () => !window.__kaikouTest.S.importing && !window.__kaikouTest.S.uploading, null, 6000);
      return page.evaluate(() => document.querySelector('#toast').textContent);
    };
    const t1 = await merge(), t2 = await merge();
    await until(page, () => !window.__kaikouTest.Store.busyDoc('inbox') && !window.__kaikouTest.Store.busyDoc('settings'), null, 6000);
    const r = await page.evaluate(() => ({ shown: window.__kaikouTest.S.inbox.filter(x => x.text === 'A NOTE WITH A LONG ID').length, cloud: window.__kaikouTest.normInbox(window.__store.get('data/users/u_test/inbox')).filter(x => x.text === 'A NOTE WITH A LONG ID').length, level: window.__store.get('data/users/u_test/settings').level }));
    check('匯入備份檔：還沒有設定時帶入檔案裡的設定（訊息會說）；id 很長的隨手記重複匯入不會變成兩則', () => eq([t1, t2, r], ['已合併：新增隨手記 1 則，並帶入備份檔裡的設定', '已合併，沒有新的資料', { shown: 1, cloud: 1, level: 'B2' }]));
    await ctx.close();
  }

  if (want('7')) {
    // A backup file whose settings were written where they were not known (only the defaults and a change): an account
    // that has no settings yet does not take them.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'import-part', null, "window.__mockSeed = (store, P) => { store.delete(P('settings')); };");
    const file = { app: 'kaikou-practice', v: 1, docs: { settings: { plan: '20', level: 'A2', about: '', accent: 'en-US', voiceURI: '', rate: 0.95, autoSpeak: false, shRate: 0.85, _part: true }, inbox: { map: { pt1: { id: 'pt1', text: 'A NOTE NEXT TO PARTIAL SETTINGS', at: 5 } } } } };
    await page.click('#btn-settings');
    await page.setInputFiles('#set-import-file', { name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
    await until(page, () => !!document.querySelector('[data-fk="imp-go"]'), null, 4000);
    await page.click('[data-fk="imp-go"]');
    await until(page, () => !window.__kaikouTest.S.importing && !window.__kaikouTest.S.uploading, null, 6000);
    const r = await page.evaluate(() => ({ toast: document.querySelector('#toast').textContent, level: window.__kaikouTest.S.settings.level, stored: !!window.__store.get('data/users/u_test/settings') }));
    check('匯入的備份檔裡的設定是不知道設定時寫的（只有預設值和一項變更）：還沒有設定的帳號也不帶入', () => eq(r, { toast: '已合併：新增隨手記 1 則', level: 'B1', stored: false }));
    await ctx.close();
  }

  // ---------- 8. Add to home screen (GitHub Pages over http) ----------
  if (want('8')) {
    check('頁面的程式沒有舊版 Safari（iOS 16.4 以前）讀不懂的正規表示式 lookbehind（讀不懂時整個 App 都不會動）', () => {
      const code = [...full.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
      eq(/\(\?<[=!]/.test(code), false);
    });
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
    // The server fails (5xx) or takes very long: the stored page opens (after 4 seconds at most), and the late answer
    // is stored for the next time. A page the site says does not exist (404) is not hidden behind the stored one.
    await page.goto(base);
    await ready();
    srv.status = 503;
    await page.goto(base);
    const err503 = await page.title();
    srv.status = 404;
    await page.goto(base);
    const err404 = await page.title();
    srv.status = 0;
    srv.page = full.replace('<head>', '<head><meta name="test-version" content="v3">');
    srv.delay = 7000;
    const slowT0 = Date.now();
    await page.goto(base);
    await ready();
    const slow = { ms: Date.now() - slowT0, version: await version() };
    await page.waitForTimeout(4000); // the late answer arrives
    srv.delay = 0;
    const late = await page.evaluate(async b => { const r = await caches.match(b); return r ? /test-version" content="v3"/.test(await r.text()) : null; }, base);
    srv.page = null;
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
    check('加到主畫面：伺服器出錯（5xx）時用存下的頁面，網頁不存在（404）就照實顯示；伺服器很慢時 4 秒左右打開存下的頁面，晚到的新版存起來下次用', () => {
      eq([err503, err404], ['開口練習室', 'status 404']);
      assert.ok(slow.ms < 6500 && slow.version !== 'v3', JSON.stringify(slow));
      eq(late, true);
    });
  }
  if (want('8')) {
    // The browser's cache storage stops working once the service worker runs (a full disk, a damaged store): the page
    // and its files still come from the network, so the app opens.
    srv.swHead = "self.addEventListener('activate', () => { self.__broken = true; });"
      + "const __open = caches.open.bind(caches); caches.open = n => (self.__broken ? Promise.reject(new Error('cache storage broken')) : __open(n));";
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    page.on('pageerror', e => errors.push('[pwa-broken] pageerror: ' + e.message));
    await page.addInitScript(() => { window.__kaikouTest = true; });
    const ready = () => page.waitForFunction(() => window.__kaikouTest && window.__kaikouTest.S && window.__kaikouTest.S.ready, null, { timeout: 10000 });
    await page.goto(base);
    await ready();
    await page.evaluate(() => navigator.serviceWorker.ready);
    let r = null;
    try {
      await page.reload();
      await ready();
      r = await page.evaluate(async () => ({ controlled: !!navigator.serviceWorker.controller, title: document.title, manifest: (await fetch(document.querySelector('link[rel="manifest"]').href)).ok }));
    } catch (e) { r = { error: String(e.message).split('\n')[0] }; }
    srv.swHead = '';
    await ctx.close();
    check('加到主畫面：瀏覽器的快取壞了（例如磁碟滿了）時，頁面和 manifest 照樣從網路打開', () => eq(r, { controlled: true, title: '開口練習室', manifest: true }));
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

  // ---------- 10. Corrections by pattern: tiers, a hint before the answer, counts in the review, practising one ----------
  if (want('10')) {
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 400, height: 860 } }, 'patterns-unit');
    const pure = await page.evaluate(() => {
      const T = window.__kaikouTest;
      const fx = s => T.parseCoach(s).fixes.map(f => [f.better, f.code, f.hint]);
      return {
        order: fx('Nice!\n###\n{"you":"a","better":"b","why":"c","code":"b2"}\n{"you":"d","better":"e","why":"f","code":"A1","hint":"提示"}\n{"you":"g","better":"h","why":"i","code":"C3"}'),
        twoA: fx('Hi!\n###\n{"you":"1","better":"x","code":"A1"}\n{"you":"2","better":"y","code":"A6"}\n{"you":"3","better":"z","code":"B1"}'),
        plain: fx('Hi!\n###\n{"you":"1","better":"p","code":"Z9","hint":' + JSON.stringify('很長'.repeat(50)) + '}\n{"you":"2","better":"q"}\n{"you":"3","better":"r"}'),
        speak: [T.parseCoach('Good.\nfinal: I sent it.\nsay: 我們上個月推出了新的精華液。\n###\n{"none": true}').speakText, T.parseCoach('Say: Could you repeat that?\n###\n{"none": true}').speakText],
        codes: [' c10 ', 'a1', 'constructor', '__proto__', 'A10', 7, null].map(T.errCode),
        review: (r => [r.patterns.map(p => p.code || ''), r.errs])(T.normReview({ patterns: [{ code: 'a8', issue: 'x' }, { code: 'Z9', issue: 'y' }, { issue: 'z' }], errs: { A1: 2, a8: '3', Z9: 4, B2: 0, C3: 500, toString: 1 } })),
        chat: (c => [c.pattern, c.turns[0].fx])(T.normChat({ active: true, mode: 'zh', pattern: 'b2', turns: [{ r: 'm', t: 'x', fx: [{ you: 'a', better: 'b', why: 'c', code: 'a1', hint: 'h', open: 1 }, { better: 'z', code: 'nope' }] }] })),
        notZh: T.normChat({ active: true, mode: 'free', pattern: 'A1', turns: [] }).pattern,
        none: [T.knownErrs(null), T.errCounts(null)],
        // Every pattern has a name, a description for the coach and a hint that does not give the answer away.
        catalogue: Object.entries(T.ERR_TYPES).filter(([k, v]) => !/^[ABC]\d{1,2}$/.test(k) || !v.zh || !v.en || !/[？?]/.test(v.hint)).map(([k]) => k),
        size: Object.keys(T.ERR_TYPES).length,
        // The review is told the pattern of each correction the coach gave.
        reviewFix: T.reviewPrompt({ mode: 'free', level: 'B1', topicEn: 'work', turns: [{ r: 'm', t: 'I go there yesterday', fx: [{ you: 'I go', better: 'I went', why: '過去式', code: 'A1' }, { you: 'there', better: 'over there', why: '' }] }] }).split('\n').filter(l => /^\s+Fix/.test(l)),
      };
    });
    check('教練的更正：每輪最多 2 個，會影響意思的（A）放第一個，同一級只留一個；句型代碼不認得就不用', () => {
      eq(pure.order, [['e', 'A1', '提示'], ['b', 'B2', '']]);
      eq(pure.twoA, [['x', 'A1', ''], ['z', 'B1', '']]);
      eq(pure.plain, [['p', '', '很長'.repeat(40)], ['q', '', '']]);
      eq(pure.codes, ['C10', 'A1', '', '', '', '', '']);
    });
    check('練句型時教練給的中文句子（say:）不會被英文的聲音唸出來；英文的 Say: 照唸', () => eq(pure.speak, ['Good.\nI sent it.', 'Say: Could you repeat that?']));
    check('複習的句型代碼與次數、存下的更正（代碼、提示、看過答案）照規則整理', () => {
      eq(pure.review, [['A8', '', ''], { A1: 2, A8: 3, C3: 99 }]);
      eq(pure.chat, ['B2', [{ you: 'a', better: 'b', why: 'c', code: 'A1', hint: 'h', open: true }, { you: '', better: 'z', why: '' }]]);
      eq(pure.notZh, '');
      eq(pure.none, [[], {}]);
      eq([pure.catalogue, pure.size], [[], 31]);
      eq(pure.reviewFix, ['  Fix [A1]: "I go" -> "I went"', '  Fix: "there" -> "over there"']);
    });
    await ctx.close();
  }

  if (want('10')) {
    // Reviews of the last 30 days corrected 過去式 twice and 冠詞 once (one older review does not count). The chat is
    // stored only in the mock's store, so it is still there after a reload.
    const seed = "window.__mockSeed = (store, P, dk, back) => { store.delete(P('chat'));"
      + " const add = (n, s) => { const k = P('sessions-' + dk(back(n)).slice(0, 7)); const d = store.get(k) || {}; d.map = Object.assign({}, d.map, { [s.id]: Object.assign({ date: dk(back(n)), at: back(n).getTime(), mode: 'free', label: '舊的', level: 'B1', minutes: 5, count: 3, summary: '舊的複習', strengths: [], patterns: [], phrases: [], next: '' }, s) }); store.set(k, d); };"
      + " add(3, { id: 'e1', errs: { A1: 2, B2: 1 } }); add(40, { id: 'e2', errs: { C3: 5, A1: 9 } }); };";
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 400, height: 860 }, deviceScaleFactor: 2 }, 'patterns', { persist: true }, seed);
    const T = (fn, arg) => page.evaluate(fn, arg);
    await page.click('#t-coach');
    await page.click('[data-fk="mode-zh"]');
    const menu = await T(() => ({
      counts: window.__kaikouTest.errCounts(null), known: window.__kaikouTest.knownErrs(null),
      chips: [...document.querySelectorAll('.chips[aria-label="練一個句型"] .chip')].map(b => b.textContent),
      pressed: [...document.querySelectorAll('.chips[aria-label="練一個句型"] .chip[aria-pressed="true"]')].map(b => b.textContent),
      inbox: document.querySelectorAll('.pick').length,
    }));
    check('中翻英的選單：最近 30 天改過的句型排前面並標出次數，再列常見的；預設不指定', () => {
      eq(menu.counts, { A1: 2, B2: 1 });
      eq(menu.known, ['A1']);
      eq(menu.chips, ['不指定', '過去式2 次', '冠詞1 次', '問句的語序', '單複數', '第三人稱 -s', '介系詞', '用錯動詞', '客氣地請求']);
      eq([menu.pressed, menu.inbox], [['不指定'], 2]);
    });
    await page.click('[data-fk="pat-pick-B2"]');
    const picked = await T(() => ({ pressed: [...document.querySelectorAll('.chips[aria-label="練一個句型"] .chip[aria-pressed="true"]')].map(b => b.textContent), inbox: document.querySelectorAll('.pick').length, focus: document.activeElement.dataset.fk, help: [...document.querySelectorAll('#coach-dyn .help')].some(p => p.textContent.includes('會用到「冠詞」')) }));
    check('選了句型：說明跟著換，「說不出口的句子」先收起來，焦點留在選的那個', () => eq(picked, { pressed: ['冠詞1 次'], inbox: 0, focus: 'pat-pick-B2', help: true }));

    // A free chat: the coach's first correction is a pattern corrected twice before, so it comes as a hint first.
    await page.click('[data-fk="mode-free"]');
    await page.click('[data-fk="start"]');
    await notBusy(page);
    await page.fill('#msg-input', 'I eat a big lunch and it make me happy');
    await page.click('#send-btn');
    await notBusy(page);
    await shot(page, '10-hint-phone.png');
    const hinted = await T(() => {
      const c = window.__kaikouTest.S.chat, me = c.turns.filter(t => t.r === 'm').pop();
      const rows = [...document.querySelectorAll('#msgs .msg.m')].pop().querySelectorAll('.fix-row');
      return {
        fx: me.fx,
        rows: [...rows].map(r => [r.querySelector('.err') && r.querySelector('.err').textContent, r.querySelector('.fix-hint') && r.querySelector('.fix-hint').textContent, r.querySelector('.fix-better') && r.querySelector('.fix-better').textContent, [...r.querySelectorAll('button')].map(b => b.textContent).filter(Boolean)]),
        hintButtons: rows[0].querySelectorAll('button').length, starred: !!rows[1].querySelector('[aria-label="收藏"]'),
        rules: [window.__lastRules.includes('keeps working on A1. '), /keeps working on[^.]*B2/.test(window.__lastRules), window.__lastRules.includes('C3 direct requests at work')],
      };
    });
    check('改過兩次以上的句型先給提示：先自己說說看，再按「看答案」；其他的照常直接給更好的說法', () => {
      eq(hinted.fx, [{ you: 'I eat a big lunch', better: 'I had a big lunch', why: '吃飯常用 have，過去式 had', code: 'A1', hint: '這是已經過去的事，eat 要怎麼改？' }, { you: 'it make me happy', better: 'it made me happy', why: '過去式' }]);
      eq(hinted.rows, [['重要・過去式', '小提示：這是已經過去的事，eat 要怎麼改？', null, ['看答案']], [null, null, 'it made me happy', []]]);
      eq([hinted.hintButtons, hinted.starred], [1, true]);
      eq(hinted.rules, [true, false, true]);
    });
    const wideHint = await horiz(page);
    // The chat's own write is done first, so only 看答案 itself can store that the answer was opened.
    await until(page, () => !window.__kaikouTest.Store.busyDoc('chat'));
    await page.click('#msgs button:has-text("看答案")');
    await until(page, () => { const d = window.__store.get('data/users/u_test/chat'); const me = d && d.turns.filter(t => t.r === 'm').pop(); return !!(me && me.fx && me.fx[0].open); });
    await until(page, () => document.querySelector('#sr-live').textContent.includes('答案：I had a big lunch'));
    const opened = await T(() => {
      const row = [...document.querySelectorAll('#msgs .msg.m')].pop().querySelector('.fix-row');
      const a = document.activeElement;
      return { better: row.querySelector('.fix-better') && row.querySelector('.fix-better').textContent, hint: !!row.querySelector('.fix-hint'), focusInRow: !!(a && a.closest('.fix-row') === row && a.tagName === 'BUTTON') };
    });
    check('按「看答案」：顯示更好的說法（記在對話裡、唸給螢幕閱讀器），焦點移到那一列的按鈕；手機上沒有左右捲動', () => eq([opened, wideHint], [{ better: 'I had a big lunch', hint: false, focusInRow: true }, false]));
    await page.reload();
    await page.waitForFunction(() => window.__kaikouTest && window.__kaikouTest.S && window.__kaikouTest.S.ready && window.__kaikouTest.S.started, null, { timeout: 10000 });
    await page.click('#t-coach');
    const after = await T(() => {
      const row = [...document.querySelectorAll('#msgs .msg.m')].pop().querySelector('.fix-row');
      return { better: row.querySelector('.fix-better') && row.querySelector('.fix-better').textContent, chip: row.querySelector('.err').textContent, fx: window.__kaikouTest.S.chat.turns.filter(t => t.r === 'm').pop().fx[0] };
    });
    check('重新打開頁面後，看過的答案還是打開的', () => eq(after, { better: 'I had a big lunch', chip: '重要・過去式', fx: { you: 'I eat a big lunch', better: 'I had a big lunch', why: '吃飯常用 have，過去式 had', code: 'A1', hint: '這是已經過去的事，eat 要怎麼改？', open: true } }));

    // Two more sentences, then the review counts the patterns of this chat.
    for (const s of ['I go to the park', 'I see many people there']) {
      await page.fill('#msg-input', s);
      await page.click('#send-btn');
      await notBusy(page);
    }
    await page.click('[data-fk="review"]');
    await until(page, () => !!window.__kaikouTest.S.review && !window.__kaikouTest.S.reviewing, null, 10000);
    await shot(page, '10-review-phone.png', true);
    const wideReview = await horiz(page);
    const rv = await T(() => {
      const S = window.__kaikouTest.S, r = S.review;
      return {
        errs: r.errs, codes: r.patterns.map(p => p.code || ''),
        chips: [...document.querySelectorAll('#coach-dyn .pat')].map(p => [p.querySelector('.err') && p.querySelector('.err').textContent, p.querySelector('.pat-head .help') && p.querySelector('.pat-head .help').textContent, !!p.querySelector('[data-fk^="pat-practice-"]')]),
      };
    });
    await until(page, id => { const d = window.__store.get('data/users/u_test/sessions-' + window.__mockToday.slice(0, 7)); return !!(d && d.map && d.map[id]); }, await T(() => window.__kaikouTest.S.review.id));
    const stored = await T(() => { const S = window.__kaikouTest.S; return window.__store.get('data/users/u_test/sessions-' + S.review.date.slice(0, 7)).map[S.review.id].errs; });
    check('複習：記下這次每個句型被改了幾次，要注意的地方標出句型和次數，可以直接用中翻英練', () => {
      eq(rv.errs, { A1: 3 });
      eq(stored, { A1: 3 });
      eq(rv.codes, ['A1', 'A8', '']);
      eq(rv.chips, [['重要・過去式', '這次改了 3 次', true], ['重要・單複數', null, true], [null, null, false]]);
      eq(wideReview, false);
    });

    // 用中翻英練這個: the coach gives a Chinese sentence to say in English.
    await page.click('[data-fk="pat-practice-0"]');
    await notBusy(page);
    await until(page, () => !!document.querySelector('#msgs .cue'));
    await shot(page, '10-cue-phone.png');
    await until(page, () => !window.__kaikouTest.Store.busyDoc('chat')); // the chat is written once its changes pause
    const cue = await T(() => {
      const S = window.__kaikouTest.S, c = S.chat;
      const sent = window.__calls.filter(x => x.kind === 'sample' && x.roles !== 's');
      return {
        pattern: c.pattern, label: document.querySelector('.chat-title b').textContent, note: c.turns[0].zhNote,
        cue: [...document.querySelectorAll('#msgs .cue')].map(n => [n.querySelector('.cue-k').textContent, n.querySelector('.cue-zh').textContent]),
        roles: sent[sent.length - 1].roles, rules: [window.__lastRules.includes('SPEAKING DRILL on one pattern: A1, past tense'), window.__lastRules.includes('no Chinese except on "say:" lines')],
        mic: document.querySelector('#mic-lang').textContent, placeholder: document.querySelector('#msg-input').placeholder === (window.__kaikouTest.Mic.ok && !window.__kaikouTest.Mic.blocked ? '按麥克風用英文說出上面那句，或打出來…' : '用英文打出上面那句…'),
        stored: window.__store.get('data/users/u_test/chat').pattern, hintBtn: document.querySelector('#hint-btn').hidden,
      };
    });
    check('從複習按「用中翻英練這個」：教練出一句中文請你用英文說，聽寫改成英文', () => eq(cue, {
      pattern: 'A1', label: '中翻英口說・練「過去式」', note: '這次練「過去式」：教練每次出一句中文，你用英文說出來（打字或按麥克風），教練會給精修版，也會幫你改。',
      cue: [['用英文說說看', '我昨天把樣品寄給實驗室了。']], roles: 'uu', rules: [true, true], mic: 'EN', placeholder: true, stored: 'A1', hintBtn: true,
    }));
    await page.fill('#msg-input', 'I send the samples to lab yesterday');
    await page.click('#send-btn');
    await notBusy(page);
    await page.locator('#msgs .msg.c').last().locator('.opt button[aria-label="收藏"]').click();
    await until(page, () => window.__kaikouTest.S.phrases.some(p => p.en === 'I sent the samples to the lab yesterday.'));
    const tried = await T(() => {
      const S = window.__kaikouTest.S, c = S.chat, last = c.turns[c.turns.length - 1], me = c.turns.filter(t => t.r === 'm').pop();
      const box = document.querySelectorAll('#msgs .msg.c');
      const node = box[box.length - 1];
      return {
        fx: me.fx.map(f => [f.better, f.code || '', !!f.hint]),
        opt: [...node.querySelectorAll('.opt')].map(o => [o.querySelector('.opt-k').textContent, o.querySelector('.opt-en').textContent]),
        cue: [...node.querySelectorAll('.cue-zh')].map(n => n.textContent),
        speak: window.__kaikouTest.parseCoach(last.raw).speakText,
        saved: S.phrases.filter(p => p.en === 'I sent the samples to the lab yesterday.').map(p => [p.zh, p.src]),
        chips: [...[...document.querySelectorAll('#msgs .msg.m')].pop().querySelectorAll('.err')].map(n => n.textContent),
      };
    });
    check('練句型：說完給精修版和下一句；更正最多 2 個；收藏的精修版帶著那句中文', () => eq(tried, {
      fx: [['I sent the samples', 'A1', true], ['to the lab', 'B2', false]],
      opt: [['精修版', 'I sent the samples to the lab yesterday.']], cue: ['我們上個月推出了新的精華液。'],
      speak: 'Good, the meaning is clear.\nI sent the samples to the lab yesterday.',
      saved: [['我昨天把樣品寄給實驗室了。', 'zh']], chips: ['重要・過去式', '常見・冠詞'],
    }));
    // A sentence from 說不出口的句子 does not go into a pattern practice that has started.
    await page.click('#t-today');
    await page.click('[data-fk="ask-i1"]');
    await until(page, () => document.querySelector('#toast').textContent === '先結束目前的對話，再把句子帶過來');
    const kept = await T(() => ({ pattern: window.__kaikouTest.S.chat.pattern, inbox: window.__kaikouTest.S.inbox.map(i => i.id), me: window.__kaikouTest.S.chat.turns.filter(t => t.r === 'm').length }));
    check('練句型時，「說不出口的句子」不會塞進這次練習', () => eq(kept, { pattern: 'A1', inbox: ['i1', 'i2'], me: 1 }));
    // 冠詞 was corrected once in the reviews and once in this practice: now it is hinted at too (the coach gave no hint
    // for it, so the page's own is used).
    await page.fill('#msg-input', 'We launch new serum last month');
    await page.click('#send-btn');
    await notBusy(page);
    const second = await T(() => {
      const me = window.__kaikouTest.S.chat.turns.filter(t => t.r === 'm').pop();
      const rows = [...document.querySelectorAll('#msgs .msg.m')].pop().querySelectorAll('.fix-row');
      return { fx: me.fx.map(f => [f.code, f.hint]), hints: [...rows].map(r => r.querySelector('.fix-hint') && r.querySelector('.fix-hint').textContent) };
    });
    check('這次練習裡又改到同一個句型時也先給提示；教練沒給提示時用句型本身的', () => eq(second, {
      fx: [['A1', '這是昨天的事，send 要怎麼改？'], ['B2', '這個名詞前面要不要加 a、an 或 the？']],
      hints: ['小提示：這是昨天的事，send 要怎麼改？', '小提示：這個名詞前面要不要加 a、an 或 the？'],
    }));

    // A practice whose opening fails offers 請教練開場; the menu then counts this review too.
    await pressTwice(page, '[data-fk="discard"]');
    await until(page, () => !window.__kaikouTest.S.chat);
    await page.click('[data-fk="mode-zh"]');
    const again = await T(() => [...document.querySelectorAll('.chips[aria-label="練一個句型"] .chip')].slice(0, 3).map(b => [b.textContent, b.getAttribute('aria-pressed')]));
    await page.click('[data-fk="pat-pick-B2"]');
    await T(() => { window.__mockCfg.sampleCode = 'overloaded'; });
    await page.click('[data-fk="start"]');
    await until(page, () => !!document.querySelector('[data-fk="retry"]'));
    const failed = await T(() => ({ note: document.querySelector('#coach-note').textContent, retry: document.querySelector('[data-fk="retry"]').textContent, label: document.querySelector('.chat-title b').textContent }));
    await T(() => { window.__mockCfg.sampleCode = ''; });
    await page.click('[data-fk="retry"]');
    await notBusy(page);
    await until(page, () => !!document.querySelector('#msgs .cue'));
    const retried = await T(() => ({ cue: document.querySelector('#msgs .cue-zh').textContent, rules: window.__lastRules.includes('SPEAKING DRILL on one pattern: B2, articles') }));
    check('回到選單：剛才的複習也算進次數，選過的句型還選著；開場失敗時可以請教練開場', () => {
      eq(again, [['不指定', 'false'], ['過去式5 次', 'true'], ['冠詞1 次', 'false']]);
      assert.ok(failed.note.startsWith('Claude 現在太忙了'), failed.note);
      eq([failed.retry, failed.label], ['請教練開場', '中翻英口說・練「冠詞」']);
      eq(retried, { cue: '我昨天把樣品寄給實驗室了。', rules: true });
    });
    // The 紀錄 tab shows the patterns of each review.
    await page.click('#t-log');
    await until(page, () => document.querySelectorAll('#log-dyn .sess').length > 0);
    const log = await T(() => [...document.querySelectorAll('#log-dyn .sess .err')].map(n => n.textContent));
    check('紀錄頁的對話複習也標出句型', () => eq(log, ['重要・過去式', '重要・單複數']));

    // 收藏 → 說英文的常見錯誤: every pattern with an example; the ones corrected lately say how often; practise one from there.
    await page.click('#t-saved');
    await page.click('[data-fk="err-group-A"]');
    await shot(page, '10-errs-phone.png', true);
    const list = await T(() => {
      const groups = [...document.querySelectorAll('#errs .err-group')];
      const item = name => [...document.querySelectorAll('#errs .err-item')].find(n => n.querySelector('.err-name b').textContent === name);
      const a1 = item('過去式'), a5 = item('回答 yes／no');
      return {
        sums: groups.map(g => g.querySelector('summary').textContent), open: groups.map(g => g.open), items: document.querySelectorAll('#errs .err-item').length,
        a1: [a1.querySelector('.tag').textContent, a1.querySelector('.fix-you').textContent, a1.querySelector('.fix-better').textContent, !!a1.querySelector('.err-q')],
        a5: [a5.querySelector('.err-q').textContent, a5.querySelector('.fix-you').textContent, a5.querySelector('.fix-better').textContent, !!a5.querySelector('.tag')],
        focus: document.activeElement.dataset.fk, wide: document.documentElement.scrollWidth > window.innerWidth,
      };
    });
    check('收藏的「說英文的常見錯誤」：31 種分三級，最近改過的標出次數，問答的例子先列出問句', () => eq(list, {
      sums: ['重要會影響意思（9 種，最近改過 1 種）', '常見聽得懂但不對（12 種，最近改過 1 種）', '更自然不是錯，是更自然或更有禮貌的說法（10 種）'], open: [true, false, false], items: 31,
      a1: ['最近 30 天改過 5 次', 'Yesterday I send the samples to the lab.', 'Yesterday I sent the samples to the lab.', false],
      a5: ["You didn't get my email?", "Yes, I didn't get it.", "No, I didn't.", false], focus: 'err-group-A', wide: false,
    }));
    // The practice started above has no sentence of the learner yet: it is replaced. One with a sentence is not.
    await page.click('[data-fk="err-practice-A6"]');
    await notBusy(page);
    const fromList = await T(() => ({ tab: window.__kaikouTest.S.tab, pattern: window.__kaikouTest.S.chat.pattern, label: document.querySelector('.chat-title b').textContent }));
    await page.fill('#msg-input', 'Why you did not come?');
    await page.click('#send-btn');
    await notBusy(page);
    await page.click('#t-saved');
    const stillOpen = await T(() => [...document.querySelectorAll('#errs .err-group')].map(g => g.open));
    await page.click('[data-fk="err-practice-A7"]');
    await until(page, () => document.querySelector('#toast').textContent === '先結束目前的對話，再開始練這個句型');
    const guarded = await T(() => ({ tab: window.__kaikouTest.S.tab, pattern: window.__kaikouTest.S.chat.pattern, me: window.__kaikouTest.S.chat.turns.filter(t => t.r === 'm').length }));
    // A pronunciation lesson is shown alone, as before.
    await page.click('#t-saved');
    await page.click('#pron .lesson');
    const inLesson = await T(() => [document.querySelector('#errs').hidden, document.querySelector('#starters').hidden]);
    await page.click('[data-fk="pron-back"]');
    const afterLesson = await T(() => document.querySelector('#errs').hidden);
    check('發音課打開時，常見錯誤清單和救急包一起收起來', () => eq([inLesson, afterLesson], [[true, true], false]));
    check('從清單用中翻英練：換掉還沒開口的練習；已經說過話的對話不會被換掉；展開的分組記得', () => {
      eq(fromList, { tab: 'coach', pattern: 'A6', label: '中翻英口說・練「問句的語序」' });
      eq(stillOpen, [true, false, false]);
      eq(guarded, { tab: 'coach', pattern: 'A6', me: 1 });
    });
    await ctx.close();
  }

  srv.close();
  await browser.close();
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'ERRORS: none');
  const bad = failures.length + errors.length;
  if (!checks) { console.log('沒有跑任何檢查'); process.exit(1); }
  console.log(bad ? '有 ' + failures.length + ' 項檢查失敗、' + errors.length + ' 個頁面錯誤' : '全部 ' + checks + ' 項檢查通過');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('RUN FAILED', e); if (errors.length) console.error('ERRORS:\n' + errors.join('\n')); process.exit(1); });
