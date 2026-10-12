window.__kaikouTest = true;
(function () {
  const store = new Map();
  const pad = n => String(n).padStart(2, '0');
  const dk = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const today = new Date();
  const back = n => new Date(today.getFullYear(), today.getMonth(), today.getDate() - n);
  const uid = 'u_test';
  const P = name => 'data/users/' + uid + '/' + name;
  const clone = o => JSON.parse(JSON.stringify(o));
  function merge(a, b) {
    const out = Object.assign({}, a);
    for (const [k, v] of Object.entries(b)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') out[k] = merge(out[k], v);
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
  put(dk(today), '20', { shadow: true });
  for (const [m, doc] of Object.entries(logs)) store.set(P('log-' + m), doc);
  store.set(P('settings'), { plan: '20', level: 'B1', about: 'I am from Taiwan and I work as a product manager.', accent: 'en-US', voiceURI: '', rate: 0.95, autoSpeak: false });
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

  window.__store = store;
  const err = (code, message) => ({ code, message });
  function snap(path) {
    const has = store.has(path);
    const data = has ? Object.freeze(clone(store.get(path))) : undefined;
    return { id: path.split('/').pop(), exists: has, data: () => data, metadata: { fromCache: false, hasPendingWrites: false } };
  }
  const db = {
    doc(path) {
      return {
        id: path.split('/').pop(), path,
        get: async () => { await new Promise(r => setTimeout(r, 20)); return snap(path); },
        set: async d => { store.set(path, clone(d)); },
        update: async d => { if (!store.has(path)) throw err('invalid_argument', 'missing'); store.set(path, merge(store.get(path), d)); },
        delete: async () => { store.delete(path); },
      };
    },
  };
  const user = { id: async () => uid, isOwner: async () => true, canEdit: async () => true };
  window.__calls = [];
  async function stream(text, opts) {
    if (opts && opts.onText) {
      const half = Math.ceil(text.length / 2);
      await new Promise(r => setTimeout(r, 40));
      opts.onText({ text: text.slice(0, half), delta: text.slice(0, half) });
      await new Promise(r => setTimeout(r, 40));
      opts.onText({ text, delta: text.slice(half) });
    }
    return { text, truncated: false, modelTierApplied: (opts && opts.modelTier) || 'default' };
  }
  const sample = async (input, opts) => {
    window.__calls.push({ kind: 'sample', n: Array.isArray(input) ? input.length : 1, roles: Array.isArray(input) ? input.map(t => t.role[0]).join('') : 's', tier: opts && opts.modelTier, cache: opts && opts.cache });
    if (typeof input === 'string') {
      window.__calls[window.__calls.length - 1].head = input.slice(0, 40);
      if (/Suggest 3 different replies/.test(input) || /Review this English speaking practice session/.test(input)) {
        const v = await sample.json(input, opts);
        await new Promise(r => setTimeout(r, 30));
        // vary the wrapping so the page's JSON extraction gets exercised
        const text = Array.isArray(v) ? '```json\n' + JSON.stringify(v, null, 1) + '\n```' : 'Here is the review:\n' + JSON.stringify(v, null, 1).replace(/"next"/, '“next”'.replace(/[“”]/g, '"')) + '\nHope this helps!';
        return { text, truncated: false, modelTierApplied: (opts && opts.modelTier) || 'default' };
      }
      return stream('我很好，謝謝！你這個週末過得怎麼樣？', opts);
    }
    const rules = input[0].content;
    const last = input[input.length - 1].content;
    if (/CHINESE-TO-ENGLISH/.test(rules) && /[㐀-鿿]/.test(last)) return stream("casual: This feature won't be out until next week.\nneutral: This feature will launch next week.\nwork: We're scheduled to release this feature next week.\nPick one, say it out loud, then type what you said.\n###\n{\"none\": true}", opts);
    if (/^Begin/.test(last)) return stream("Hi! Let's talk about your weekend. What did you do on Saturday?\n###\n{\"none\": true}", opts);
    return stream('That sounds fun! What was the best part of the day?\n###\n{"you": "I eat a big lunch", "better": "I had a big lunch", "why": "吃飯常用 have，過去式 had"}\n{"you": "it make me happy", "better": "it made me happy", "why": "過去式"}', opts);
  };
  sample.json = async (input, opts) => {
    window.__calls.push({ kind: 'json', head: String(input).slice(0, 40), tier: opts && opts.modelTier });
    await new Promise(r => setTimeout(r, 60));
    if (/Suggest 3 different replies/.test(input)) return [{ en: 'The view from the top was amazing.', zh: '山頂的景色很棒。' }, { en: 'We had a picnic by the lake.', zh: '我們在湖邊野餐。' }, { en: 'Honestly, my legs still hurt!', zh: '老實說，我的腿到現在還在痛！' }];
    if (/Review this English speaking practice session/.test(input)) return { summary: '你能把週末的經過說得很完整，回答也越來越長。過去式還不穩，是下次的重點。', strengths: ['會主動補充細節', '敢用新的單字'], patterns: [{ issue: '過去的事常用現在式', example: 'I go to hiking', fix: 'I went hiking' }, { issue: '可數名詞忘了加 s', example: 'my friend', fix: 'my friends' }], phrases: [{ en: 'The view was breathtaking.', zh: '景色美得令人屏息。', example: 'The view from the top was breathtaking.' }, { en: 'We called it a day.', zh: '我們就收工了。', example: 'We got tired, so we called it a day.' }, { en: 'It was worth the climb.', zh: '爬上去很值得。', example: 'It was hard, but it was worth the climb.' }, { en: 'I could use a rest.', zh: '我需要休息一下。', example: 'After that hike, I could use a rest.' }, { en: 'Do you hike a lot?', zh: '你常爬山嗎？', example: 'Do you hike a lot on weekends?' }], next: '試著用過去式描述上一次出遊的完整經過' };
    return [];
  };
  sample.limits = async () => ({ maxPromptBytes: 65536 });
  window.claude = { use: async name => { await new Promise(r => setTimeout(r, 30)); return ({ db, user, sample })[name] || null; } };
})();
