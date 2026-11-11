// 開口練習室的教練伺服器：網頁版（GitHub Pages）的 AI 教練經過這裡呼叫 Claude API，API 金鑰只放在伺服器上。
// 在 Render 用 render.yaml 建立（步驟見 README 的「教練伺服器」）。沒有用任何套件，只用 Node.js 內建的模組。
//
// 環境變數：
//   ANTHROPIC_API_KEY  Claude Console 的 API 金鑰（sk-ant-api 開頭），只存在伺服器上。
//   ACCESS_CODE        存取碼（至少 16 個英數字或符號、沒有空白；Render 會自動產生一組）。網頁版在設定裡填同一組才能用。
//   ALLOWED_ORIGINS    可以呼叫的網站，逗號分隔（預設 https://willisxu.github.io）。
//   RATE_PER_MIN / RATE_PER_DAY  每分鐘、每天（UTC）最多幾次教練的請求（預設 30、600），存取碼外流時限制損失。
//                      次數記在記憶體裡，伺服器重新啟動（免費方案每次休眠後醒來都算）就重新計算，所以真正的上限要靠
//                      Claude Console 的花費上限。
//   PORT               Render 會自己設定。
//
// 網址：
//   GET  /health        { ok: true, ready, site }：伺服器醒著（ready：金鑰和存取碼都設定好了；site：呼叫的網站在不在
//                       ALLOWED_ORIGINS 裡）。不用存取碼，任何網站都讀得到。
//   GET  /v1/check      存取碼對、設定好了就回 204（網頁版的設定用來確認）。
//   POST /v1/messages   和 Claude API 的 Messages 一樣（串流也照樣傳回），只接受網頁版用的模型和欄位。
// 錯誤和 Claude API 同一個格式：{ type: 'error', error: { type, message } }；伺服器自己的錯誤 type 是 kaikou_ 開頭，
// Claude API 的錯誤（額度、太忙…）照原樣傳回。紀錄只寫方法、路徑、狀態碼和時間，不寫內容、金鑰或存取碼。
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');

// The models the page uses (API_MODELS in docs/index.html) and the most tokens it asks of each. test/run.js checks that
// the two lists match.
const MODELS = { 'claude-haiku-5-5': 2048, 'claude-sonnet-5-5': 8192 };
// The fields the page sends (apiSample in docs/index.html). Anything else (tools, web search, …) is refused, so a code
// that leaks cannot be used for more than the coach's own kind of request.
const FIELDS = new Set(['model', 'max_tokens', 'messages', 'stream', 'thinking', 'system', 'temperature', 'stop_sequences']);
const MAX_BODY = 256 * 1024; // a long chat with its review is well under 200 KB
const MIN_CODE = 16;
// Letters, digits and signs only (an HTTP header cannot carry anything else; a space or a character pasted by mistake
// would make the page's request fail before it is sent). docs/index.html checks the same (SRV_CODE_RE).
const CODE_RE = /^[\x21-\x7e]{16,}$/;
const API_VERSION = '2023-06-01';
// The same check as the page's (saveKey): a Claude Console API key, never a Claude account's sign-in token.
const KEY_RE = /^sk-ant-api[A-Za-z0-9_-]{20,}$/;

const posInt = (v, d) => (/^\d+$/.test(String(v || '').trim()) && Number(v) > 0 ? Number(v) : d);
function config(env) {
  const origin = x => { try { const o = new URL(x).origin; return o === 'null' ? '' : o; } catch (_) { return ''; } };
  const given = String(env.ALLOWED_ORIGINS === undefined ? 'https://willisxu.github.io' : env.ALLOWED_ORIGINS).split(',').map(x => x.trim()).filter(Boolean);
  return {
    port: posInt(env.PORT, 10000),
    key: String(env.ANTHROPIC_API_KEY || '').trim(),
    code: String(env.ACCESS_CODE || '').trim(),
    origins: given.map(origin).filter(Boolean),
    ignored: given.filter(x => !origin(x)), // not a whole address (https://…): told at start
    // Only the tests point this elsewhere (a stand-in for the API on this computer).
    upstream: String(env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').trim().replace(/\/+$/, ''),
    perMin: posInt(env.RATE_PER_MIN, 30),
    perDay: posInt(env.RATE_PER_DAY, 600),
  };
}
// What keeps the server from working ('' when nothing): names the setting to fix, never its value.
function problem(cfg) {
  if (!CODE_RE.test(cfg.code)) return 'ACCESS_CODE 沒有設定，或少於 ' + MIN_CODE + ' 個字（或有空白、英數字和符號以外的字）';
  if (!KEY_RE.test(cfg.key)) return 'ANTHROPIC_API_KEY 沒有設定，或不是 Claude Console 的 API 金鑰（要 sk-ant-api 開頭）';
  if (!cfg.origins.length) return 'ALLOWED_ORIGINS 裡沒有完整的網址（要像 https://willisxu.github.io）';
  if (!/^https:\/\/[^/]+$/.test(cfg.upstream) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(cfg.upstream)) return 'ANTHROPIC_BASE_URL 不是 https:// 的網址';
  return '';
}
const digest = s => crypto.createHash('sha256').update(String(s)).digest();
const sameCode = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));
// Fixed windows: so many requests a minute and a (UTC) day. Kept in memory (a restart starts them again).
function limiter(perMin, perDay) {
  let min = { t: -1, n: 0 }, day = { d: '', n: 0 };
  return now => {
    const t = Math.floor(now / 60000), d = new Date(now).toISOString().slice(0, 10);
    if (min.t !== t) min = { t, n: 0 };
    if (day.d !== d) day = { d, n: 0 };
    if (day.n >= perDay) return Math.ceil((Date.parse(d + 'T00:00:00Z') + 86400000 - now) / 1000);
    if (min.n >= perMin) return Math.ceil(((t + 1) * 60000 - now) / 1000);
    min.n++; day.n++;
    return 0;
  };
}
const fail = (type, message) => ({ type: 'error', error: { type, message } });
function send(res, status, obj, extra) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, extra || {}));
  res.end(obj === undefined ? undefined : JSON.stringify(obj));
}
// The body, up to the limit (null when it is bigger).
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, over = false;
    req.on('data', c => { if (over) return; size += c.length; if (size > limit) { over = true; resolve(null); } else chunks.push(c); });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}
// What the page sent and is not read is let through (up to a point: far too much ends the connection).
function drain(req) {
  let n = 0;
  req.on('data', c => { n += c.length; if (n > 16 * MAX_BODY) req.destroy(); });
  req.resume();
}
function checkBody(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return '內容要是 JSON 物件';
  for (const k of Object.keys(o)) if (!FIELDS.has(k)) return '不接受 ' + k + ' 這個欄位';
  if (typeof o.model !== 'string' || !Object.hasOwn(MODELS, o.model)) return '不接受這個模型';
  if (!Number.isInteger(o.max_tokens) || o.max_tokens < 1 || o.max_tokens > MODELS[o.model]) return 'max_tokens 要是 1 到 ' + MODELS[o.model] + ' 的整數';
  if (!Array.isArray(o.messages) || !o.messages.length) return 'messages 要是有內容的陣列';
  if ('stream' in o && typeof o.stream !== 'boolean') return 'stream 要是 true 或 false';
  return '';
}

function createApp(cfg, log) {
  log = log || (line => console.log(line));
  const bad = problem(cfg);
  const allow = limiter(cfg.perMin, cfg.perDay);
  // Who may call (the access code), in this order: a server without a usable code cannot check one; a wrong code is
  // told before the rest of the setup (which /health tells anyone anyway).
  function denied(req, res) {
    const m = /^Bearer (\S+)$/.exec(String(req.headers.authorization || ''));
    const no = !CODE_RE.test(cfg.code) ? [503, 'kaikou_config', '教練伺服器還沒設定好：' + bad]
      : !m || !sameCode(m[1], cfg.code) ? [401, 'kaikou_code', '存取碼不對']
      : bad ? [503, 'kaikou_config', '教練伺服器還沒設定好：' + bad] : null;
    if (!no) return false;
    send(res, no[0], fail(no[1], no[2]));
    drain(req);
    return true;
  }
  async function messages(req, res) {
    if (denied(req, res)) return;
    const wait = allow(Date.now());
    if (wait) { send(res, 429, fail('kaikou_busy', '教練的請求次數到上限了，等一下再試'), { 'retry-after': String(wait) }); drain(req); return; }
    if (Number(req.headers['content-length']) > MAX_BODY) { send(res, 413, fail('kaikou_too_large', '內容太長')); drain(req); return; }
    const raw = await readBody(req, MAX_BODY);
    if (raw === null) { send(res, 413, fail('kaikou_too_large', '內容太長')); drain(req); return; }
    let body;
    try { body = JSON.parse(raw); } catch (_) { send(res, 400, fail('kaikou_request', '內容不是 JSON')); return; }
    const why = checkBody(body);
    if (why) { send(res, 400, fail('kaikou_request', why)); return; }
    // The page stopping (or going away) stops the API's answer too: what it has not written yet is not billed.
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });
    let up;
    try {
      up = await fetch(cfg.upstream + '/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': cfg.key, 'anthropic-version': API_VERSION },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } catch (_) {
      if (!ac.signal.aborted) send(res, 502, fail('kaikou_upstream', '連不上 Claude API'));
      return;
    }
    if (!up.ok && !/json/i.test(up.headers.get('content-type') || '')) {
      try { await up.body.cancel(); } catch (_) { /* gone */ }
      send(res, 502, fail('kaikou_upstream', 'Claude API 回了不是它平常的錯誤（狀態 ' + up.status + '）'));
      return;
    }
    // no-transform: a proxy in front (Render compresses answers) should pass the stream on as it comes, not hold it to pack it.
    res.writeHead(up.status, { 'content-type': up.headers.get('content-type') || 'application/json', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    try {
      // Each piece goes on as it comes (the coach's reply streams to the page word by word).
      if (up.body) for await (const chunk of up.body) res.write(chunk);
      res.end();
    } catch (_) {
      res.destroy(); // cut off on the way: the page sees its answer end early and says so
    }
  }
  const server = http.createServer((req, res) => {
    const started = Date.now();
    const path = String(req.url || '').split('?')[0];
    res.on('close', () => log(req.method + ' ' + path + ' ' + res.statusCode + ' ' + (Date.now() - started) + 'ms' + (res.writableFinished ? '' : ' (cut off)')));
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('vary', 'Origin');
    const origin = req.headers.origin;
    const fromSite = !!origin && cfg.origins.includes(origin);
    if (fromSite) res.setHeader('access-control-allow-origin', origin);
    // A web page other than the allowed ones never gets an answer (its browser would not show it anyway).
    if (origin && !fromSite && path !== '/health') { send(res, 403, fail('kaikou_origin', '這個網站不能使用教練伺服器')); drain(req); return; }
    if (req.method === 'OPTIONS') {
      send(res, 204, undefined, { 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'authorization, content-type', 'access-control-max-age': '600' });
      return;
    }
    const known = { '/': 'GET', '/health': 'GET', '/v1/check': 'GET', '/v1/messages': 'POST' };
    if (!known[path]) { send(res, 404, fail('kaikou_not_found', '沒有這個網址')); drain(req); return; }
    if (req.method !== known[path]) { send(res, 405, fail('kaikou_method', '不接受 ' + req.method), { allow: known[path] }); drain(req); return; }
    if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('開口練習室的教練伺服器' + (bad ? '：還沒設定好（' + bad + '）。' : '在運作中。') + '\n');
      return;
    }
    if (path === '/health') {
      // Any page may read it: a page on an address the server does not serve learns that (instead of a server that seems
      // to sleep), and nothing else.
      if (origin && !fromSite) res.setHeader('access-control-allow-origin', '*');
      send(res, 200, { ok: true, ready: !bad, site: origin ? fromSite : null });
      return;
    }
    if (path === '/v1/check') { if (!denied(req, res)) send(res, 204); return; }
    messages(req, res).catch(() => send(res, 500, fail('kaikou_error', '教練伺服器出錯了')));
  });
  // Longer than the load balancer in front keeps an idle connection, so it never reuses one this end has closed.
  server.keepAliveTimeout = 120000;
  server.headersTimeout = 125000;
  return server;
}

if (require.main === module) {
  const cfg = config(process.env);
  const app = createApp(cfg);
  const bad = problem(cfg);
  app.listen(cfg.port, '0.0.0.0', () => {
    console.log('教練伺服器開在 port ' + cfg.port + (bad ? '，但還不能用：' + bad : '，可以使用了'));
    if (cfg.ignored.length) console.log('ALLOWED_ORIGINS 裡這些不是完整的網址（要 https:// 開頭），沒有用到：' + cfg.ignored.join(', '));
  });
  // Render stops the old server when a new version starts: answers on their way get a moment to finish.
  process.on('SIGTERM', () => {
    app.close(() => process.exit(0));
    // Idle connections close now, and each one that an answer leaves idle closes within a second.
    app.closeIdleConnections();
    setInterval(() => app.closeIdleConnections(), 1000).unref();
    setTimeout(() => process.exit(0), 28000).unref();
  });
}

module.exports = { createApp, config, problem, MODELS, FIELDS, MAX_BODY, MIN_CODE, CODE_RE, KEY_RE };
