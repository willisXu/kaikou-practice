// A stand-in for the Claude runtime (window.claude) used by test/run.js: an in-memory db with the platform's
// update/merge rules and size limit (plus listing a user's documents), a user, a sample() that streams canned
// coach replies and answers the JSON prompts, and a downloads.save() that keeps each file in window.__downloads.
// Each test page can set window.__mockCfg before load:
//   owner: false            the viewer is not the artifact's owner
//   readOnly: true          the viewer may not write (reads see nothing, writes reject invalid_argument)
//   readOnlyWrites: true    a member moved down to Viewer: their own documents still read, every write rejects
//                           invalid_argument (db.d.ts: a call below the minimum level)
//   window.__mockSeed(store, P, dk, back)   an init script may define this to change the seeded cloud
//   failWrites: { name: { n, code } }   the next n writes to that document reject with that code
//   failReads: { name: n }               the next n reads of that document reject "unavailable"
//   refuse: 'text'          sample() rejects "refused" when the learner's last message contains this text
//   slowMs: 600             each streamed chunk of a coach reply takes this long (to test Stop)
//   persist: true           the cloud store survives a reload of the tab (kept in sessionStorage)
//   noDb: true              use('db') resolves null (the cloud could not be loaded on this visit)
//   noUser: true            use('user') resolves null (Claude does not say who is viewing)
//   failUse: ['db']         use() rejects for these capabilities
//   failList: n             the next n listings of the user's documents reject "unavailable"
//   jsonDelay: 800          JSON answers (hints, review, passage, 4/3/2 points) take this long
//   sampleCode: 'not_granted'   every sample() call rejects with this code (the viewer declined the coach)
//   permsPanel: 'stay' | 'fail' the Permissions panel (permissions.manage) leaves the coach off, or does not open;
//                           by default the viewer switches the coach back on there
//   refuseTask: true        a single-prompt call (hints, review, translation, passage, points) rejects "refused"
//   noSample: true          use('sample') resolves null (this view cannot run the coach)
//   noDownloads: true       use('downloads') resolves null
//   saveFail: 'declined'    downloads.save() rejects with this code ('declined', 'rate_limited'…)
//   settings: { plan: '60' }  fields that replace the seeded settings
//   noToday: true           the cloud has no record of today yet
//   writeDelay: { name: ms }  writes to that document take this long before they land or fail
//   writeLandsFirst: true   a write is stored at once and only its answer takes writeDelay (the host carries it out
//                           even if the page closes before the answer comes)
//   readDelay: { name: ms | [ms, ms…] }  reads of that document take this long (a list: the first read, the second…,
//                           then the usual 20 ms); window.__readStarts[name] counts the reads started
window.__kaikouTest = true;
(function () {
  const cfg = Object.assign({ owner: true, readOnly: false, readOnlyWrites: false, failWrites: {}, failReads: {}, refuse: '', slowMs: 0, persist: false, noDb: false, noUser: false, failUse: [], failList: 0, jsonDelay: 30,
    sampleCode: '', refuseTask: false, noSample: false, noDownloads: false, saveFail: '', settings: null, noToday: false, writeDelay: {}, readDelay: {}, writeLandsFirst: false }, window.__mockCfg || {});
  window.__mockCfg = cfg; // tests may change it while the page runs
  const store = new Map();
  const pad = n => String(n).padStart(2, '0');
  const dk = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const today = new Date();
  window.__mockToday = dk(today);
  const back = n => new Date(today.getFullYear(), today.getMonth(), today.getDate() - n);
  const uid = 'u_test';
  const P = name => 'data/users/' + uid + '/' + name;
  const clone = o => JSON.parse(JSON.stringify(o));
  // db.d.ts: nested plain objects merge recursively; anything else (arrays, null) replaces the field.
  function merge(a, b) {
    const out = Object.assign({}, a);
    for (const [k, v] of Object.entries(b)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = merge(out[k], v);
      else out[k] = v;
    }
    return out;
  }
  const logs = {};
  function put(k, plan, items) { const m = k.slice(0, 7); (logs[m] = logs[m] || { days: {}, monthRecord: false }).days[k] = { plan, items }; }
  for (const n of [1, 2, 3, 4]) put(dk(back(n)), '20', { shadow: true, ai: true, listen: true });
  put(dk(back(6)), '20', { shadow: true });
  put(dk(back(9)), '20', { shadow: true, ai: true, tutor: true });
  put(dk(back(12)), '60', { shadow: true, ai: true, chunk: true, listen: true });
  if (!cfg.noToday) put(dk(today), '20', { shadow: true });
  for (const [m, doc] of Object.entries(logs)) store.set(P('log-' + m), doc);
  store.set(P('settings'), Object.assign({ plan: '20', level: 'B1', about: 'I live in Taipei and work in marketing.', accent: 'en-US', voiceURI: '', rate: 0.95, autoSpeak: false }, cfg.settings || {}));
  store.set(P('phrases'), { items: [
    { id: 'p1', en: 'I went hiking with my friends.', zh: '', note: '過去式；hiking 不加 to', ex: '', src: 'fix', at: 3 },
    { id: 'p2', en: "I'll get back to you on that.", zh: '這個我再回覆你。', note: '工作場合', ex: '', src: 'starter', at: 2 },
    { id: 'p3', en: 'It slipped my mind.', zh: '我一時忘了', note: '', ex: 'Sorry, it totally slipped my mind.', src: 'review', at: 1 },
  ] });
  store.set(P('inbox'), { items: [
    { id: 'i1', text: '這個功能下週才能上線', at: 2 },
    { id: 'i2', text: '我們需要再確認一下預算', at: 1 },
  ] });
  const t0 = Date.now() - 6 * 60000;
  store.set(P('chat'), { active: true, id: 'c1', mode: 'free', level: 'B1', topicZh: '這個週末', topicEn: "the learner's weekend", sceneZh: '', sceneEn: '', aiRole: '', meRole: '', startedAt: t0, updatedAt: t0 + 240000, turns: [
    { r: 'c', t: 'Hi! How was your weekend? Did you do anything fun?', raw: 'Hi! How was your weekend? Did you do anything fun?\n###\n{"none": true}', at: t0 },
    { r: 'm', t: 'I go to hiking with my friend on saturday', at: t0 + 60000, fx: [{ you: 'I go to hiking', better: 'I went hiking', why: '過去的事用過去式；hiking 不加 to' }, { you: 'my friend', better: 'my friends', why: '不只一位朋友用複數' }] },
    { r: 'c', t: 'Nice! Where did you go hiking? Was the weather good?', raw: 'Nice! Where did you go hiking? Was the weather good?\n###\n{"none": true}', at: t0 + 90000 },
    { r: 'm', t: 'We went to Yangmingshan. The weather was really nice.', at: t0 + 180000, ok: true },
    { r: 'c', t: 'Yangmingshan sounds lovely. What did you see up there?', raw: 'Yangmingshan sounds lovely. What did you see up there?\n###\n{"none": true}', at: t0 + 240000 },
  ] });
  const curM = dk(today).slice(0, 7);
  store.set(P('sessions-' + curM), { items: [{ id: 's1', date: dk(back(2)), at: Date.now() - 2 * 86400000, mode: 'role', label: '角色扮演・向主管報告進度', level: 'B1', minutes: 12, count: 9, summary: '你能清楚說出專案進度，句子越說越完整。下次可以多用連接詞把原因和結果串起來。', strengths: ['主動說明風險'], patterns: [{ issue: '時態混用', example: 'Yesterday we finish the test', fix: 'Yesterday we finished the test' }], phrases: [{ en: "We're on track to launch next week.", zh: '我們預計下週可以如期上線。', example: "We're on track to launch next Friday." }], next: '練習用英文說明延遲的原因與補救方案' }] });
  if (typeof window.__mockSeed === 'function') window.__mockSeed(store, P, dk, back);

  if (cfg.persist) {
    try { const saved = JSON.parse(sessionStorage.getItem('__mockStore') || 'null'); if (saved) { store.clear(); for (const [k, v] of saved) store.set(k, v); } } catch (_) { /* fresh store */ }
  }
  const save = () => { if (cfg.persist) try { sessionStorage.setItem('__mockStore', JSON.stringify([...store.entries()])); } catch (_) { /* ignore */ } };
  window.__store = store;
  window.__saveStore = save;
  window.__dbCalls = [];
  const err = (code, message) => ({ code, message });
  const bytes = o => new TextEncoder().encode(JSON.stringify(o)).length;
  function snap(path) {
    const has = store.has(path) && !cfg.readOnly;
    const data = has ? Object.freeze(clone(store.get(path))) : undefined;
    return { id: path.split('/').pop(), exists: has, data: () => data, metadata: { fromCache: false, hasPendingWrites: false } };
  }
  function write(op, path, fn) {
    const name = path.split('/').pop();
    const f = cfg.failWrites[name];
    let code = '';
    if (cfg.readOnly || cfg.readOnlyWrites) code = 'invalid_argument';
    else if (f && f.n > 0) { f.n--; code = f.code || 'unavailable'; }
    window.__dbCalls.push({ op, name, code });
    if (code) throw err(code, 'injected');
    fn();
    save();
  }
  const db = {
    doc(path) {
      if (!/^data\/users\/u_test\/[A-Za-z0-9_-]+$/.test(path)) throw err('invalid_argument', 'bad path ' + path);
      return {
        id: path.split('/').pop(), path,
        get: async () => {
          const name = path.split('/').pop();
          const starts = window.__readStarts = window.__readStarts || {};
          const nth = starts[name] = (starts[name] || 0) + 1;
          const d = (cfg.readDelay || {})[name];
          await new Promise(r => setTimeout(r, (Array.isArray(d) ? d[nth - 1] : d) || 20));
          if (cfg.failReads[name] > 0) { cfg.failReads[name]--; window.__dbCalls.push({ op: 'get', name, code: 'unavailable' }); throw err('unavailable', 'injected'); }
          window.__dbCalls.push({ op: 'get', name, code: '' });
          return snap(path);
        },
        set: async d => {
          const wait = () => new Promise(r => setTimeout(r, cfg.writeDelay[path.split('/').pop()] || 10));
          const run = () => write('set', path, () => { if (bytes(d) > 262144) throw err('invalid_argument', 'too large'); store.set(path, clone(d)); });
          if (cfg.writeLandsFirst) { run(); await wait(); } else { await wait(); run(); }
        },
        update: async d => {
          const wait = () => new Promise(r => setTimeout(r, cfg.writeDelay[path.split('/').pop()] || 10));
          const run = () => write('update', path, () => {
            if (!store.has(path)) throw err('invalid_argument', 'missing');
            const next = merge(store.get(path), d);
            if (bytes(next) > 262144) throw err('invalid_argument', 'too large');
            store.set(path, next);
          });
          if (cfg.writeLandsFirst) { run(); await wait(); } else { await wait(); run(); }
        },
        delete: async () => { store.delete(path); },
      };
    },
    // Only what the page uses: every document directly under one user's folder.
    collection(path) {
      if (!/^data\/users\/u_test$/.test(path)) throw err('invalid_argument', 'bad collection ' + path);
      const q = {
        limit: () => q,
        get: async () => {
          await new Promise(r => setTimeout(r, 20));
          if (cfg.failList > 0) { cfg.failList--; window.__dbCalls.push({ op: 'list', name: path, code: 'unavailable' }); throw err('unavailable', 'injected'); }
          window.__dbCalls.push({ op: 'list', name: path, code: '' });
          const docs = cfg.readOnly ? [] : [...store.keys()].filter(k => k.startsWith(path + '/') && k.split('/').length === 4).sort().map(snap);
          return { docs, size: docs.length, empty: !docs.length };
        },
      };
      return q;
    },
  };
  // downloads.d.ts: save() resolves once the viewer accepts; here every save is accepted and kept for the test
  // (unless saveFail is set: the viewer declined, another save is waiting…).
  window.__downloads = [];
  const downloads = { save: async req => {
    await new Promise(r => setTimeout(r, 20));
    if (cfg.saveFail) throw err(cfg.saveFail, 'injected');
    window.__downloads.push({ filename: req.filename, data: String(req.data) });
    return { status: 'saved' };
  } };
  const user = { id: async () => uid, isOwner: async () => !!cfg.owner, canEdit: async () => !!cfg.owner, can: async () => null };
  window.__calls = [];
  // Streams in two chunks; an aborted signal rejects "cancelled" with the text received so far (sample.d.ts).
  async function stream(text, opts) {
    const wait = () => new Promise(r => setTimeout(r, cfg.slowMs || 40));
    const stop = sofar => { if (opts && opts.signal && opts.signal.aborted) throw Object.assign(err('cancelled', 'aborted'), sofar ? { text: sofar } : {}); };
    if (opts && opts.onText) {
      const half = Math.ceil(text.length / 2);
      await wait(); stop('');
      opts.onText({ text: text.slice(0, half), delta: text.slice(0, half) });
      await wait(); stop(text.slice(0, half));
      opts.onText({ text, delta: text.slice(half) });
    }
    return { text, truncated: false, modelTierApplied: (opts && opts.modelTier) || 'default' };
  }
  const JSON_PROMPTS = /Suggest 3 different replies|Review this English speaking practice session|practise shadowing|talk about one topic three times/;
  function answerJson(prompt) {
    if (/Suggest 3 different replies/.test(prompt)) return [{ en: 'The view from the top was amazing.', zh: '山頂的景色很棒。' }, { en: 'We had a picnic by the lake.', zh: '我們在湖邊野餐。' }, { en: 'Honestly, my legs still hurt!', zh: '老實說，我的腿到現在還在痛！' }];
    if (/practise shadowing/.test(prompt)) return { title: 'A Slow Saturday', sentences: [
      { en: "I didn't have any plans last Saturday.", zh: '上週六我沒有任何計畫。' },
      { en: 'So I slept in until about ten.', zh: '所以我睡到大概十點。' },
      { en: 'Then I grabbed a coffee near my place.', zh: '然後我在家附近買了杯咖啡。' },
      { en: "It was sunny, so I went for a walk by the river.", zh: '天氣很好，所以我去河邊散步。' },
      { en: 'In the evening, I cooked pasta for my sister.', zh: '晚上我煮了義大利麵給我妹妹吃。' },
      { en: 'It was a simple day, but I really needed it.', zh: '很簡單的一天，但我真的很需要。' },
    ] };
    if (/talk about one topic three times/.test(prompt)) return { points: ['What do you do at work?', 'Where do you live?', 'What do you enjoy on weekends?'], phrases: [{ en: 'I work in marketing.', zh: '我在做行銷。' }, { en: "I'm based in Taipei.", zh: '我住在台北。' }, { en: "In my free time, I'm into hiking.", zh: '有空的時候我喜歡爬山。' }] };
    return { summary: '你能把週末的經過說得很完整，回答也越來越長。過去式還不穩，是下次的重點。', strengths: ['會主動補充細節', '敢用新的單字'], patterns: [{ issue: '過去的事常用現在式', example: 'I go to hiking', fix: 'I went hiking' }, { issue: '可數名詞忘了加 s', example: 'my friend', fix: 'my friends' }], phrases: [{ en: 'The view was breathtaking.', zh: '景色美得令人屏息。', example: 'The view from the top was breathtaking.' }, { en: 'We called it a day.', zh: '我們就收工了。', example: 'We got tired, so we called it a day.' }, { en: 'It was worth the climb.', zh: '爬上去很值得。', example: 'It was hard, but it was worth the climb.' }, { en: 'I could use a rest.', zh: '我需要休息一下。', example: 'After that hike, I could use a rest.' }, { en: 'Do you hike a lot?', zh: '你常爬山嗎？', example: 'Do you hike a lot on weekends?' }], next: '試著用過去式描述上一次出遊的完整經過' };
  }
  const sample = async (input, opts) => {
    const call = { kind: 'sample', n: Array.isArray(input) ? input.length : 1, roles: Array.isArray(input) ? input.map(t => t.role[0]).join('') : 's', tier: opts && opts.modelTier, cache: opts && opts.cache };
    window.__calls.push(call);
    // sample.d.ts: a turn array starts and ends with a user turn.
    if (Array.isArray(input) && (!input.length || input[0].role !== 'user' || input[input.length - 1].role !== 'user')) throw err('invalid_request', 'turns must start and end with a user turn');
    if (cfg.sampleCode) { await new Promise(r => setTimeout(r, 30)); throw err(cfg.sampleCode, 'injected'); }
    if (typeof input === 'string') {
      call.head = input.slice(0, 40);
      if (cfg.refuseTask) { await new Promise(r => setTimeout(r, 30)); throw err('refused', 'declined'); }
      if (JSON_PROMPTS.test(input)) {
        const v = answerJson(input);
        // Stopped while thinking (取消): rejects "cancelled", as sample() does.
        await new Promise((r, j) => {
          const t = setTimeout(r, cfg.jsonDelay);
          if (opts && opts.signal) opts.signal.addEventListener('abort', () => { clearTimeout(t); j(err('cancelled', 'aborted')); });
        });
        // vary the wrapping so the page's JSON extraction gets exercised
        const text = Array.isArray(v) ? '```json\n' + JSON.stringify(v, null, 1) + '\n```' : 'Here is the review:\n' + JSON.stringify(v, null, 1) + '\nHope this helps!';
        return { text, truncated: false, modelTierApplied: (opts && opts.modelTier) || 'default' };
      }
      return stream('我很好，謝謝！你這個週末過得怎麼樣？', opts);
    }
    const rules = input[0].content;
    const last = input[input.length - 1].content;
    if (cfg.refuse && last.includes(cfg.refuse)) { await new Promise(r => setTimeout(r, 30)); throw err('refused', 'declined'); }
    if (/CHINESE-TO-ENGLISH/.test(rules) && /[㐀-鿿]/.test(last)) return stream("casual: This feature won't be out until next week.\nneutral: This feature will launch next week.\nwork: We're scheduled to release this feature next week.\nPick one, say it out loud, then type what you said.\n###\n{\"none\": true}", opts);
    if (/^Begin/.test(last)) return stream("Hi! Let's talk about your weekend. What did you do on Saturday?\n###\n{\"none\": true}", opts);
    return stream('That sounds fun! What was the best part of the day?\n###\n{"you": "I eat a big lunch", "better": "I had a big lunch", "why": "吃飯常用 have，過去式 had"}\n{"you": "it make me happy", "better": "it made me happy", "why": "過去式"}', opts);
  };
  sample.limits = async () => ({ maxPromptBytes: 65536 });
  // permissions.d.ts: manage() opens Claude's Permissions panel; here the viewer switches the coach back on there
  // (permsPanel: 'stay' leaves it off, 'fail' means the panel did not open).
  window.__permsOpened = 0;
  const permissions = {
    state: async name => (name === 'sample' && cfg.sampleCode === 'not_granted' ? 'denied' : 'granted'),
    request: async names => Object.fromEntries((names || ['sample']).map(n => [n, n === 'sample' && cfg.sampleCode === 'not_granted' ? 'denied' : 'granted'])),
    manage: async () => {
      await new Promise(r => setTimeout(r, 30));
      if (cfg.permsPanel === 'fail') throw err('unavailable', 'the panel did not open');
      window.__permsOpened++;
      if (cfg.permsPanel !== 'stay' && cfg.sampleCode === 'not_granted') cfg.sampleCode = '';
    },
  };
  window.claude = { use: async name => {
    await new Promise(r => setTimeout(r, 30));
    if (cfg.failUse.includes(name)) throw err('unavailable', 'injected');
    if ((name === 'db' && cfg.noDb) || (name === 'user' && cfg.noUser) || (name === 'sample' && cfg.noSample) || (name === 'downloads' && cfg.noDownloads)) return null;
    return ({ db, user, sample, downloads, permissions })[name] || null;
  } };
})();
