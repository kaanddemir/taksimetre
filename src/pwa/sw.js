/* Taksimetre service worker (template). The build (vite.config.ts → pwaPlugin) prepends
 *   const VERSION = "<content hash>"; const ASSETS = [<every file in dist>];
 * and writes it to dist/sw.js. One cache per build, so code, styles and the bundled tariff
 * registry always come from the same version and are never mixed.
 *
 * - Precache only: the app shell and static assets. Nothing is cached at runtime, so no user data,
 *   location or journey state can end up here (journeys live in sessionStorage only).
 * - No skipWaiting on install: a new version waits until the page says the meter is idle
 *   (src/pwa/register.ts), or until every tab of the old version is closed.
 * - Old caches in this registration scope are deleted on activation.
 * - Forced activation requires the requesting page to be the only in-scope window.
 */
/* global VERSION, ASSETS */
// CacheStorage is shared by the whole origin, even across service-worker scopes.
const PREFIX = "taksimetre:" + encodeURIComponent(self.registration.scope) + ":";
const CACHE = PREFIX + VERSION;
const SHELL = "./"; // the scope URL itself: every host serves it (unlike /index.html on some hosts)

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      // cache: "reload" bypasses the HTTP cache so a stale file never enters a new version.
      await cache.addAll(ASSETS.map((u) => new Request(u, { cache: "reload" })));
      const shell = await fetch(new Request(SHELL, { cache: "reload" }));
      if (!shell.ok) throw new Error("app shell unavailable");
      // A redirected response cannot answer a navigation; store a clean copy.
      await cache.put(SHELL, shell.redirected ? new Response(await shell.blob(), shell) : shell);
    }),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()), // first install: control the open page so it works offline at once
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") {
    // Conservative multi-window policy: never force takeover while another app
    // window is open, even if that window looks idle. The requesting page retries.
    event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const scoped = clients.filter((c) => c.url.startsWith(self.registration.scope));
      if (scoped.length === 1 && scoped[0].id === event.source?.id) return self.skipWaiting();
    }));
  }
  else if (event.data === "version") event.ports[0]?.postMessage(VERSION); // shown in the info panel
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      // Single-page app: every navigation in scope gets this version's shell (query strings such as ?diag included).
      // ignoreVary: the server may send "Vary: Origin", and module scripts carry an Origin header
      // that the precache requests did not; every precached file is fixed for this version anyway.
      const hit = req.mode === "navigate" ? await cache.match(SHELL) : await cache.match(req, { ignoreSearch: true, ignoreVary: true });
      return hit ?? fetch(req); // not precached (or evicted): network, never stored
    }),
  );
});
