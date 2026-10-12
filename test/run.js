// 開口練習室的瀏覽器測試。
// - 「在 Claude 裡」的情境：把 docs/index.html 轉成 Artifact 片段（tools/artifact.js），包上和 Claude 一樣的外框，
//   再用 test/mock.js 模擬 window.claude（雲端資料庫與 AI 教練）。
// - 「GitHub Pages／直接開檔」的情境：原封不動打開 docs/index.html，用手機模擬。
// 每一項檢查失敗都會印出 FAIL，最後以非 0 結束碼結束；全部通過時印出 "ERRORS: none"。
// 執行：npm install、npx playwright install chromium、npm test。截圖存到 test/shots/。
'use strict';
const { chromium } = require('playwright');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { toArtifact } = require('../tools/artifact');

const dir = __dirname;
const out = path.join(dir, 'shots');
fs.mkdirSync(out, { recursive: true });
const full = fs.readFileSync(path.join(dir, '..', 'docs', 'index.html'), 'utf8');
const mock = fs.readFileSync(path.join(dir, 'mock.js'), 'utf8');
// Claude publishes the page inside a skeleton like this one; the mock stands in for window.claude.
const skeleton = body => '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style></head><body>' + body + '</body></html>';
const ARTIFACT = path.join(dir, 'harness.html');
fs.writeFileSync(ARTIFACT, skeleton('<script>' + mock + '</script>' + toArtifact(full)));
const PAGES = path.join(dir, '..', 'docs', 'index.html');

const failures = [];
const errors = [];
function check(name, fn) {
  try { fn(); console.log('ok   ' + name); }
  catch (e) { failures.push(name); console.log('FAIL ' + name + '\n     ' + String(e.message).split('\n').join('\n     ')); }
}
const eq = (actual, expected) => assert.deepStrictEqual(actual, expected);

(async () => {
  const browser = await chromium.launch();
  const now = new Date();
  const NOON = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
  async function open(file, opts, tag, init) {
    const ctx = await browser.newContext(opts);
    await ctx.clock.install({ time: NOON }); // time keeps flowing from noon, so no check runs across midnight
    const page = await addPage(ctx, file, tag, init);
    return { ctx, page };
  }
  async function addPage(ctx, file, tag, init) {
    const page = await ctx.newPage();
    await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    // The browser logs the deliberate 401 of the API key scenario as an error; anything else counts.
    const expected = t => /ERR_FAILED|net::/.test(t) || (/^apikey/.test(tag) && /status of 401/.test(t));
    page.on('console', m => { if (m.type() === 'error' && !expected(m.text())) errors.push('[' + tag + '] console: ' + m.text()); });
    page.on('pageerror', e => errors.push('[' + tag + '] pageerror: ' + e.message));
    await page.addInitScript(c => { window.__kaikouTest = true; if (c) window.__mockCfg = c; }, init || null);
    await page.goto('file://' + file);
    await page.waitForFunction(() => window.__kaikouTest && window.__kaikouTest.S && window.__kaikouTest.S.ready, null, { timeout: 10000 });
    return page;
  }
  const until = (page, fn, arg, timeout) => page.waitForFunction(fn, arg, { timeout: timeout || 8000 });
  const sync = page => page.evaluate(() => document.querySelector('#sync').textContent);
  const shot = (p, name, fullPage) => p.screenshot({ path: path.join(out, name), fullPage: !!fullPage });
  const horiz = p => p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  const notBusy = p => until(p, () => !window.__kaikouTest.S.busy && !window.__kaikouTest.S.reviewing, null, 10000);

  // ---------- 1. In Claude, on a phone: the whole daily flow ----------
  {
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
      };
    });
    check('送出一句：教練回覆並附上 2 個更自然的說法', () => { eq(chat.turns, 7); eq(chat.fixes, 2); eq(chat.chatCall, [['uuauauau', false]]); });
    check('提示與翻譯', () => { eq(chat.hintButtons, 3); eq(chat.hintCall, [false]); eq(chat.zh, '我很好，謝謝！你這個週末過得怎麼樣？'); });

    await page.click('.chat-acts .btn.primary');
    await until(page, () => !!window.__kaikouTest.S.review && !window.__kaikouTest.S.reviewing, null, 10000);
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
  }

  // ---------- 2. In Claude, on a desktop in dark mode ----------
  {
    const { page } = await open(ARTIFACT + '#coach', { viewport: { width: 1200, height: 900 }, colorScheme: 'dark' }, 'desk');
    await until(page, () => document.querySelector('#sync').textContent === '已同步');
    await shot(page, '7-coach-desk-dark.png');
    await page.click('.chat-acts .btn:not(.primary)');
    await page.click('.chat-acts .btn:not(.primary)');
    await until(page, () => !!document.querySelector('#start-btn'));
    await page.click('.mode:nth-child(2)');
    await shot(page, '8-coach-start-desk-dark.png', true);
    await page.click('#btn-settings');
    const dlg = await page.evaluate(() => ({ open: document.querySelector('#settings').open, clear: document.querySelector('#set-clear').hidden, key: document.querySelector('#set-api-field').hidden }));
    check('放棄對話回到選單；設定可開啟，雲端模式不顯示清除按鈕，也不顯示 API 金鑰欄位', () => eq(dlg, { open: true, clear: true, key: true }));
    await shot(page, '9-settings-desk-dark.png');
  }

  // ---------- 3. GitHub Pages / a local file, on a phone ----------
  {
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
    await shot(page, '10-pages-phone.png', true);

    // Two tabs of the same browser: each keeps the other's changes.
    const page2 = await addPage(ctx, PAGES, 'pages-2');
    await page2.tap('#today-dyn .list .item:nth-child(2) .check');
    await until(page, () => { const m = window.__kaikouTest.S.logs; const k = window.__kaikouTest.S.lastToday; const L = m[k.slice(0, 7)]; return !!(L && L.days[k] && L.days[k].items.ai); });
    await page.tap('#today-dyn .list .item:nth-child(4) .check');
    await page.waitForTimeout(700);
    const stored = await page.evaluate(() => { const k = window.__kaikouTest.S.lastToday; return JSON.parse(localStorage.getItem('kaikou:log-' + k.slice(0, 7))).days[k].items; });
    check('網頁版：同一個瀏覽器開兩個分頁不會互相蓋掉', () => eq(stored, { ai: true, listen: true }));
    await page.click('#btn-settings');
    await page.locator('#set-api-field').scrollIntoViewIfNeeded();
    const sett = await page.evaluate(() => {
      const d = document.querySelector('#settings'), f = document.querySelector('#set-api-field');
      return { clear: !document.querySelector('#set-clear').hidden, key: !f.hidden, wide: d.scrollWidth > d.clientWidth || f.getBoundingClientRect().right > window.innerWidth };
    });
    check('網頁版：設定裡有清除資料的按鈕與 API 金鑰欄位，手機上不超出畫面', () => eq(sett, { clear: true, key: true, wide: false }));
    await shot(page, '10b-pages-settings-phone.png');
    await ctx.close();
  }

  // ---------- 3b. GitHub Pages with the viewer's own Claude API key ----------
  {
    // A made-up key: api.anthropic.com is answered by the route below, nothing leaves the test.
    const KEY = 'sk-ant-api03-' + 'TESTONLY'.repeat(6) + '-AA';
    const REVIEW = { summary: '今天說得很順。', strengths: ['敢開口'], patterns: [{ issue: '過去式', example: 'I go to park yesterday', fix: 'I went to the park yesterday' }], phrases: [{ en: 'We had a picnic', zh: '我們去野餐', example: 'We had a picnic by the river.' }], next: '再聊一次週末' };
    const sse = text => {
      const ev = (type, data) => 'event: ' + type + '\ndata: ' + JSON.stringify(Object.assign({ type }, data)) + '\n\n';
      return ev('message_start', { message: { id: 'msg_test', type: 'message', role: 'assistant', content: [], stop_reason: null } })
        + ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
        + ev('ping', {})
        + (text.match(/[\s\S]{1,9}/g) || []).map(t => ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: t } })).join('')
        + ev('content_block_stop', { index: 0 })
        + ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } })
        + ev('message_stop', {});
    };
    const api = { calls: [], fail: null };
    const { ctx, page } = await open(PAGES + '#coach', { viewport: { width: 1000, height: 800 }, colorScheme: 'light' }, 'apikey');
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
    const again = await page.evaluate(() => document.querySelector('#coach-note').textContent);
    await page.click('#coach-note [data-fk="retry"]');
    await notBusy(page);
    const back = await page.evaluate(() => { const c = window.__kaikouTest.S.chat; return c.turns.length && c.turns[0].t; });
    check('網頁版金鑰：金鑰無效時說明清楚、不提供重送；換一把之後可以請教練開場', () => {
      eq([bad.note.startsWith('Claude API 金鑰無效或已停用，請到設定重新輸入。'), bad.retry, bad.toKey], [true, false, true]);
      eq(again.startsWith('對話還沒開始。'), true);
      eq(back, 'Hi! What did you do last weekend?');
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

    // Removing the key turns the coach off again; another tab notices at once.
    const page2 = await addPage(ctx, PAGES + '#coach', 'apikey-2');
    const tab2Before = await page2.evaluate(() => window.__kaikouTest.S.sampleState);
    await page.click('#btn-settings');
    await page.click('#set-api-clear');
    await page.click('#set-api-clear');
    await until(page, () => !localStorage.getItem('kaikou:api-key'), null, 3000);
    await until(page2, () => window.__kaikouTest.S.sampleState === 'none', null, 3000);
    const off = await page.evaluate(() => ({ state: window.__kaikouTest.S.sampleState, openKey: !!document.querySelector('#coach-dyn [data-fk="open-key"]'), toast: document.querySelector('#toast').textContent, text: document.querySelector('#set-api-state').textContent, remove: !document.querySelector('#set-api-clear').hidden }));
    const off2 = await page2.evaluate(() => !!document.querySelector('#coach-dyn [data-fk="open-key"]'));
    check('網頁版金鑰：移除後教練停用，另一個分頁也立刻跟著停用', () => {
      eq(tab2Before, 'ok');
      eq(off, { state: 'none', openKey: true, toast: '已移除金鑰', text: '還沒有儲存金鑰。', remove: false });
      eq(off2, true);
    });
    await ctx.close();
  }

  // ---------- 4. Failure paths in Claude ----------
  {
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
  {
    // b. A viewer whose link cannot write keeps working from this browser, also after a reload.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'readonly', { readOnly: true, owner: false });
    await page.fill('#inbox-input', '唯讀連結的句子');
    await page.click('#inbox-form .btn');
    await until(page, () => document.querySelector('#sync').textContent === '只存在這個瀏覽器', null, 6000);
    await until(page, () => (localStorage.getItem('kaikou:inbox') || '').includes('唯讀連結的句子'), null, 3000);
    const a = await page.evaluate(() => ({ toast: document.querySelector('#toast').textContent, ls: localStorage.getItem('kaikou:inbox') || '', flag: localStorage.getItem('kaikou:no-cloud') }));
    await page.reload();
    await page.waitForFunction(() => window.__kaikouTest && window.__kaikouTest.S && window.__kaikouTest.S.ready, null, { timeout: 10000 });
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
  {
    // The owner's cloud access stops mid-visit; the next visit offers to upload what was kept in this browser.
    const { ctx, page } = await open(ARTIFACT, { viewport: { width: 1000, height: 800 } }, 'held', { persist: true, failWrites: { inbox: { n: 1, code: 'revoked' } } });
    await page.fill('#inbox-input', '同步停止後記的句子');
    await page.click('#inbox-form .btn');
    await until(page, () => document.querySelector('#sync').textContent === '只存在這個瀏覽器' && !!localStorage.getItem('kaikou:held'), null, 6000);
    // Meanwhile the phone deletes an older sentence; the upload must not bring it back.
    await page.evaluate(() => { const k = 'data/users/u_test/inbox'; const d = window.__store.get(k); d.map = Object.assign({}, d.map || {}, { i2: null }); window.__store.set(k, d); window.__saveStore(); });
    await page.reload();
    await page.waitForFunction(() => window.__kaikouTest && window.__kaikouTest.S && window.__kaikouTest.S.ready, null, { timeout: 10000 });
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
  {
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
  {
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
  {
    // e. Cloud storage full: shown once, not retried in a loop, sent again after a deletion.
    const { ctx, page } = await open(ARTIFACT + '#saved', { viewport: { width: 1000, height: 800 } }, 'quota', { failWrites: { phrases: { n: 99, code: 'quota_exceeded' } } });
    await page.click('#starters .icon-btn[aria-pressed="false"][aria-label="收藏"]');
    await until(page, () => document.querySelector('#sync').textContent === '有資料存不進雲端', null, 6000);
    const n1 = await page.evaluate(() => window.__dbCalls.filter(c => c.name === 'phrases' && c.op !== 'get').length);
    await page.waitForTimeout(4000);
    const n2 = await page.evaluate(() => window.__dbCalls.filter(c => c.name === 'phrases' && c.op !== 'get').length);
    await page.evaluate(() => { window.__mockCfg.failWrites.phrases.n = 0; });
    const del = '#saved-list .phrase:last-child [data-fk^="del-"]';
    await page.click(del);
    await page.click(del);
    await until(page, () => document.querySelector('#sync').textContent === '已同步', null, 6000);
    check('雲端空間已滿：不會一直重試，刪掉東西後自動再存', () => eq(n2, n1));
    await ctx.close();
  }

  await browser.close();
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'ERRORS: none');
  const bad = failures.length + errors.length;
  console.log(bad ? '有 ' + failures.length + ' 項檢查失敗、' + errors.length + ' 個頁面錯誤' : '全部檢查通過');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('RUN FAILED', e); process.exit(1); });
