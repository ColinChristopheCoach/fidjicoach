/* FidjiCoach — service worker (PWA, 5 nov. 2026)
   1. Hors ligne minimal : la page d'accueil, les icônes et les bibliothèques sont gardées en réserve; sans réseau, l'app s'ouvre quand même.
   2. Jamais de vieille version coincée : la page index.html est toujours demandée au réseau d'abord (la réserve ne sert qu'hors ligne).
   3. Notifications poussées : affichage, et ouverture au bon endroit quand on touche la notification (?n=<avis>).
   Les appels à Supabase (comptes, réservations, messages…) ne passent jamais par la réserve. */
const VERSION = 'fc-pwa-2026-11-05';
const CACHE = VERSION;
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/fidjicoach-logo.png', '/icon-192.png', '/icon-512.png', '/icon-512-maskable.png', '/apple-touch-icon.png', '/badge-96.png'];
const LIBS = [
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',
  'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/dist/umd/supabase.js',
  'https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=Figtree:wght@400;500;600;700&display=swap',
];
const CDN = /^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;
const NEVER = /supabase\.(co|in)\/|\/functions\/v1\/|stripe\.com|router\.project-osrm\.org|openstreetmap\.org|nominatim|api\.|\/rest\/v1\/|\/auth\/v1\/|\/storage\/v1\/|\/realtime\//;

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => null)));
    await Promise.all(LIBS.map((u) => fetch(new Request(u, { mode: 'no-cors' })).then((r) => c.put(u, r)).catch(() => null)));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type === 'SKIP_WAITING') self.skipWaiting();
  if (d.type === 'VERSION' && e.source) e.source.postMessage({ type: 'VERSION', version: VERSION });
});

/* --- réserve --- */
async function networkFirstPage(req) {
  const c = await caches.open(CACHE);
  try {
    const r = await fetch(new Request(req, { cache: 'no-cache' }));   // revalidé auprès du serveur : jamais une vieille copie du cache HTTP
    if (r && r.ok) { c.put('/index.html', r.clone()); c.put('/', r.clone()); }
    return r;
  } catch (_) {
    return (await c.match('/index.html')) || (await c.match('/')) || new Response('<!doctype html><meta charset="utf-8"><title>FidjiCoach</title><p style="font-family:sans-serif;padding:24px">Vous êtes hors ligne. Ouvrez FidjiCoach de nouveau quand le réseau sera revenu.</p>', { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
}
async function staleWhileRevalidate(req) {
  const c = await caches.open(CACHE);
  const hit = await c.match(req);
  const net = fetch(req).then((r) => { if (r && (r.ok || r.type === 'opaque')) c.put(req, r.clone()); return r; }).catch(() => null);
  return hit || (await net) || Response.error();
}
async function cacheFirst(req) {
  const c = await caches.open(CACHE);
  const hit = await c.match(req, { ignoreVary: true });
  if (hit) return hit;
  try { const r = await fetch(req); if (r && (r.ok || r.type === 'opaque')) c.put(req, r.clone()); return r; } catch (_) { return Response.error(); }
}
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = req.url;
  if (NEVER.test(url)) return;                                   // données en ligne : toujours le réseau, jamais la réserve
  if (req.mode === 'navigate') { e.respondWith(networkFirstPage(req)); return; }
  const same = url.startsWith(self.location.origin);
  if (same) {
    if (/\/sw\.js(\?|$)/.test(url)) return;                      // le service worker lui-même : jamais en réserve
    if (/\.(txt|png|jpg|jpeg|webp|svg|gif|json|webmanifest|css|js|woff2?)(\?|$)/i.test(url) || /\/index\.html(\?|$)/.test(url)) { e.respondWith(staleWhileRevalidate(req)); }
    return;
  }
  if (CDN.test(url)) { e.respondWith(cacheFirst(req)); return; }
});

/* --- notifications poussées --- */
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  const title = d.title || 'FidjiCoach';
  const opts = {
    body: d.body || '', icon: d.icon || '/icon-192.png', badge: d.badge || '/badge-96.png', lang: d.lang || 'fr-CA',
    tag: d.tag || undefined, renotify: !!d.tag, timestamp: d.at ? Date.parse(d.at) || Date.now() : Date.now(),
    data: { url: d.url || '/', n: d.n || null, kind: d.kind || '' },
  };
  e.waitUntil((async () => {
    // l'app est ouverte et visible : la bulle et la cloche s'en chargent déjà (pas de doublon sur l'écran)
    try {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const live = wins.find((c) => c.visibilityState === 'visible' && c.focused);
      if (live && d.kind !== 'Essai') { live.postMessage({ type: 'fc-push-live', n: d.n || null }); return; }
    } catch (_) { /* rien */ }
    await self.registration.showNotification(title, opts);
  })());
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  const target = new URL(data.url || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = all.find((c) => c.url.startsWith(self.location.origin));
    if (win) {
      try { await win.focus(); } catch (_) { /* rien */ }
      win.postMessage({ type: 'fc-notif', n: data.n, url: target, kind: data.kind });
      return;
    }
    await self.clients.openWindow(target);
  })());
});
self.addEventListener('pushsubscriptionchange', (e) => {
  // l'abonnement a été renouvelé par le navigateur : le site le réenregistre à sa prochaine ouverture (pushSync)
  e.waitUntil(Promise.resolve());
});
