// watch.wallet service worker: installs the app, shows alerts, and
// acknowledges one straight from the notification's button.
// Watches and alerts are private, so pages are never cached.
const CACHE = 'ww-shell-v1'
const SHELL = ['/offline.html', '/style.css', '/app.js', '/favicon.svg', '/icon-192.png', '/manifest.webmanifest']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()))
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/offline.html')))
    return
  }
  const path = new URL(req.url).pathname
  if (SHELL.includes(path)) event.respondWith(fetch(req).catch(() => caches.match(path)))
})

self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title || 'watch.wallet alert', {
      body: data.body || '',
      tag: 'alert',
      renotify: true,
      requireInteraction: true,
      data: { url: data.url || '/me', ack: data.ack || '' },
      actions: data.ack ? [{ action: 'ack', title: 'It was me' }] : [],
      icon: '/icon-192.png',
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  const { url, ack } = event.notification.data || {}
  event.notification.close()
  if (event.action === 'ack' && ack) {
    event.waitUntil(
      fetch(`/a/${encodeURIComponent(ack)}`, { method: 'POST', headers: { accept: 'application/json', 'x-via': 'push' } })
        .then((r) => r.json())
        .then(() => self.registration.showNotification('Acknowledged', { body: 'We keep watching.', tag: 'alert', icon: '/icon-192.png' }))
        .catch(() => self.clients.openWindow(url)),
    )
    return
  }
  event.waitUntil(self.clients.openWindow(url || '/me'))
})
