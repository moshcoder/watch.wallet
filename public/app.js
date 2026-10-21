// watch.wallet in the browser: register the service worker and turn on push alerts.
(() => {
  'use strict'
  const $ = (id) => document.getElementById(id)
  const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})
  const pushBtn = $('push-on')
  if (!pushBtn) return
  const status = $('push-status')
  if (!('PushManager' in window)) {
    pushBtn.disabled = true
    status.textContent = 'This browser cannot do push. On iPhone, add this site to your home screen first.'
    return
  }
  const csrf = document.querySelector('input[name=csrf]')?.value || ''
  pushBtn.addEventListener('click', async () => {
    try {
      if ((await Notification.requestPermission()) !== 'granted') { status.textContent = 'Notifications are blocked for this site.'; return }
      const reg = await navigator.serviceWorker.ready
      const v = pushBtn.dataset.vapid
      const key = unb64(v.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (v.length % 4)) % 4))
      const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }))
      const res = await fetch('/push', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf': csrf }, body: JSON.stringify(sub) })
      status.textContent = res.ok ? 'On. Alerts will show up on this device.' : 'Could not save it; reload and try again.'
    } catch (e) { status.textContent = e.message || String(e) }
  })
})()
