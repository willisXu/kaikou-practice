// 開口練習室（GitHub Pages 版）的 service worker：加到主畫面後，沒有網路也能打開頁面。
// - 頁面本身（./ 與 ./index.html）：先向網路拿最新版並存一份；網路斷了、伺服器出錯（5xx），或 4 秒內沒有回應，
//   就先用存下來的那份。網站搬家（轉址）或頁面不在了，照網路的回應走，不會一直停在舊的那份。
// - manifest 與圖示：先用存下來的，同時在背景更新，下次打開就是新的。
// - 其他檔案和其他網站（字型、Claude API）一律不經過這裡。
// - 存不了、讀不到存下的檔案時（磁碟滿了、快取壞了），照樣向網路拿，不會讓頁面打不開。
// 練習資料存在瀏覽器的 localStorage，和這裡的快取無關。
const CACHE = 'kaikou-v1';
const SHELL = ['./', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png'];
const PAGE = new URL('./', self.location).href;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('kaikou-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const scope = new URL(self.registration.scope).pathname;
  if (!url.pathname.startsWith(scope)) return;
  const rest = url.pathname.slice(scope.length);
  if (rest === '' || rest === 'index.html') e.respondWith(page(e));
  else if (/^(manifest\.webmanifest|icons\/[\w.-]+\.png)$/.test(rest)) e.respondWith(asset(e));
});

// A stored answer, or null when there is none or the store cannot be used (a full disk, a damaged cache).
const stored = key => caches.open(CACHE).then(c => c.match(key)).catch(() => null);
// Stores an answer (a copy, taken at once: the page reads the original); a store that cannot be used is left alone.
function keep(e, key, res) {
  const copy = res.clone();
  e.waitUntil(caches.open(CACHE).then(c => c.put(key, copy)).catch(() => {}));
}

// The app page is stored under one key, and only when the answer really is the HTML page.
async function page(e) {
  const network = fetch(e.request).then(res => {
    if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) keep(e, PAGE, res);
    return res;
  });
  const saved = await stored(PAGE);
  if (!saved) return network;
  e.waitUntil(network.catch(() => {}));
  const late = new Promise(r => setTimeout(() => r(saved), 4000));
  // A redirect (a navigation sees it as "opaqueredirect") or any other real answer is followed; only a server error
  // falls back to the stored page.
  return Promise.race([network.then(res => (res.status >= 500 ? saved : res), () => saved), late]);
}

async function asset(e) {
  const fresh = fetch(e.request).then(res => { if (res.ok) keep(e, e.request, res); return res; });
  const hit = await stored(e.request);
  if (!hit) return fresh;
  e.waitUntil(fresh.catch(() => {}));
  return hit;
}
