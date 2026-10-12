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
    page.on('console', m => { if (m.type() === 'error' && !/ERR_FAILED|net::/.test(m.text())) errors.push('[' + tag + '] console: ' + m.text()); });
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
    const dlg = await page.evaluate(() => ({ open: document.querySelector('#settings').open, clear: document.querySelector('#set-clear').hidden }));
    check('放棄對話回到選單；設定可開啟，雲端模式不顯示清除按鈕', () => eq(dlg, { open: true, clear: true }));
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
    const clear = await page.evaluate(() => !document.querySelector('#set-clear').hidden);
    check('網頁版：設定裡有清除資料的按鈕', () => eq(clear, true));
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
