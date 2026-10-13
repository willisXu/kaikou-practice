// 開口練習室（GitHub Pages 版）的 service worker：加到主畫面後，沒有網路也能打開頁面。
// - 頁面本身（./ 與 ./index.html）：先向網路拿最新版並存一份；網路斷了、伺服器出錯（5xx），或 4 秒內沒有回應，
//   就先用存下來的那份。網站搬家（轉址）或頁面不在了，照網路的回應走，不會一直停在舊的那份。
// - manifest 與圖示：先用存下來的，同時在背景更新，下次打開就是新的。
// - 其他檔案和其他網站（字型、Claude API）一律不經過這裡。
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

// The app page is stored under one key, and only when the answer really is the HTML page.
async function page(e) {
  const cache = await caches.open(CACHE);
  const network = fetch(e.request).then(res => {
    if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) e.waitUntil(cache.put(PAGE, res.clone()));
    return res;
  });
  const saved = await cache.match(PAGE);
  if (!saved) return network;
  e.waitUntil(network.catch(() => {}));
  const late = new Promise(r => setTimeout(() => r(saved), 4000));
  // A redirect (a navigation sees it as "opaqueredirect") or any other real answer is followed; only a server error
  // falls back to the stored page.
  return Promise.race([network.then(res => (res.status >= 500 ? saved : res), () => saved), late]);
}

async function asset(e) {
  const cache = await caches.open(CACHE);
  const fresh = fetch(e.request).then(res => { if (res.ok) e.waitUntil(cache.put(e.request, res.clone())); return res; });
  const hit = await cache.match(e.request);
  if (!hit) return fresh;
  e.waitUntil(fresh.catch(() => {}));
  return hit;
}
