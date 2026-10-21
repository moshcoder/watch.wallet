/**
 * The watch.wallet web server: pages, the JSON API, the worker, and the
 * CoinPay and Telnyx webhooks.
 *
 * watch.wallet is a Moshpit name. Visitors on Moshpit DNS reach
 * https://watch.wallet directly; everyone else comes through the pit.world
 * relay at https://watch.wallet.pit.world, which says so with an
 * x-moshpit-name header. Pages and cookies follow whichever one the visitor
 * used; anything that leaves the box (email links, webhooks) uses the relay,
 * because nobody outside Moshpit can resolve the name.
 */
import { createHmac, createPublicKey, timingSafeEqual, verify } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { assetsOf, CHAIN_INFO, normalizeAddress, normalizeCoin, parseChain, STABLES, type Chain } from './chains.js'
import { Store, type NewWatch, type User, type Watch } from './db.js'
import { describeBalances, formatUnits, toNumber } from './engine.js'
import { ackPage, checkPage, confirmSigninPage, dashboardPage, helpPage, homePage, messagePage, plansPage, signinPage, watchPage, type CheckResult, type Ctx } from './html.js'
import { createNotifier, notifyConfig, telnyxCommand, webhookUrlError, type Notifier, type NotifyConfig, type Resolver } from './notify.js'
import { startPitFooterRefresh } from './pit-footer.js'
import { daysFor, isPaid, limitsFor, planConfig, planLabel, readWebhook, SETTLED, startCheckout, verifyWebhook, type PlanConfig, type Product } from './plans.js'
import { ringDescriptor, startRingFooterRefresh } from './ring-footer.js'
import { RING_PLACEHOLDER, ringBar, startRingRefresh, visitorOnMoshpit } from './ring.js'
import { readAddress, sourceConfig, spotPrice, type SourceConfig } from './sources.js'
import { VERSION } from './version.js'
import { alertForAckToken, startWorker, watchName } from './worker.js'

export { VERSION }

const SELF = 'watch.wallet'
const DIRECT_ORIGIN = 'https://watch.wallet'
export const RELAY_ORIGIN = 'https://watch.wallet.pit.world'
const SESSION = 'ww_session'

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' https://crawlproof.com; img-src 'self' data: blob: https://built.indie.pit.world; connect-src 'self' https://crawlproof.com; worker-src 'self'; manifest-src 'self'; form-action 'self' https://coinpayportal.com; base-uri 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'permissions-policy': 'interest-cohort=(), browsing-topics=(), camera=(), microphone=(), geolocation=()',
  'cross-origin-opener-policy': 'same-origin',
}

export type Deps = {
  store: Store
  key: string
  plans: PlanConfig
  notifier: Notifier
  notify: NotifyConfig
  sources: SourceConfig
  fetch?: typeof fetch
  secureCookies?: boolean
  telnyxPublicKey?: string
  /** DNS for webhook URL checks; tests pass a fake. */
  resolve?: Resolver
}

class Limiter {
  private hits = new Map<string, { n: number; reset: number }>()
  constructor(private readonly max: number, private readonly windowMs: number) {}
  allow(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key)
    if (!h || h.reset < now) {
      if (this.hits.size > 50_000) this.hits.clear()
      this.hits.set(key, { n: 1, reset: now + this.windowMs })
      return true
    }
    h.n += 1
    return h.n <= this.max
  }
}

const EMAIL = /^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[a-z]{2,}$/i
const safeNext = (n: unknown) => (typeof n === 'string' && /^\/[a-z0-9/_#-]*$/i.test(n) ? n : '/me')
const truthy = (v: unknown) => v === true || v === '1' || v === 'on' || v === 'true'
const money = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return 0
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 && n < 1e12 ? n : null
}

/** A watch from a form or a JSON body, or the reason it is not one. Paid-only fields are dropped on free plans. */
export function parseWatch(b: Record<string, unknown>, paid: boolean): NewWatch | string {
  const label = String(b.label ?? '').trim().slice(0, 60)
  const call = paid && truthy(b.call)
  if ((b.kind ?? 'address') === 'price' || (b.coin && !b.address)) {
    const coin = normalizeCoin(b.coin)
    if (!coin) return 'Name a coin by its ticker, like BTC or ETH.'
    const direction = b.direction === 'above' ? 'above' : b.direction === 'below' ? 'below' : null
    if (!direction) return 'Say above or below.'
    const level = Number(b.level_usd ?? b.level)
    if (!Number.isFinite(level) || level <= 0) return 'Give a price in USD, like 60000.'
    return { kind: 'price', label, coin, direction, level_usd: level, call }
  }
  const chain = parseChain(b.chain)
  if (!chain) return 'Pick a chain: bitcoin, ethereum, base, polygon or solana.'
  const address = normalizeAddress(chain, b.address)
  if (!address) return `That is not a ${CHAIN_INFO[chain].label} address.`
  const min = money(b.min_usd)
  if (min === null) return 'The dollar threshold must be a number.'
  return { kind: 'address', label, chain, address, min_usd: paid ? min : 0, call }
}

/** One look at an address: balances and their USD value. Used by /check and the public API. */
export async function lookupAddress(sources: SourceConfig, chain: Chain, address: string): Promise<CheckResult> {
  const r = await readAddress(sources, chain, address)
  const native = CHAIN_INFO[chain].native
  const price = await spotPrice(sources, native).catch(() => null)
  const rows = assetsOf(chain).map((a) => {
    const v = BigInt(r.balances[a.symbol] ?? '0')
    const p = STABLES.has(a.symbol) ? 1 : a.symbol === native ? price : null
    return { asset: a.symbol, amount: formatUnits(v, a.decimals), usd: p === null ? null : toNumber(v, a.decimals) * p }
  })
  return { chain, address, rows, pending: r.pending }
}

export function createApp(deps: Deps) {
  const { store, plans, notifier } = deps
  const nowMs = () => store.now().getTime()
  const app = new Hono()
  const signinLimit = new Limiter(10, 60 * 60_000)
  const apiLimit = new Limiter(120, 60_000)
  const checkLimit = new Limiter(10, 60_000)
  const checkGlobal = new Limiter(300, 60_000)

  const direct = (c: Context) => visitorOnMoshpit(SELF, c.req.header('host'), c.req.header('x-moshpit-name'))
  const https = (c: Context) => (c.req.header('x-forwarded-proto') ?? 'https') === 'https'
  const origin = (c: Context) => (direct(c) && https(c) ? DIRECT_ORIGIN : RELAY_ORIGIN)
  const ip = (c: Context) => c.req.header('x-real-ip') ?? 'local'
  const sessionId = (c: Context) => getCookie(c, SESSION)
  const csrfFor = (sid: string | undefined) => (sid ? createHmac('sha256', deps.key).update(`csrf:${sid}`).digest('hex').slice(0, 32) : 'anon')
  const csrfOk = (c: Context, given: unknown) => {
    const g = Buffer.from(String(given ?? ''))
    const e = Buffer.from(csrfFor(sessionId(c)))
    return g.length === e.length && timingSafeEqual(g, e)
  }
  const ctxOf = async (c: Context): Promise<Ctx> => ({ user: await store.session(sessionId(c)), csrf: csrfFor(sessionId(c)), origin: origin(c) })
  const page = (c: Context, html: string, status = 200) => c.html(html.replace(RING_PLACEHOLDER, ringBar(SELF, direct(c))), status as 200)
  const form = async (c: Context) => (await c.req.parseBody()) as Record<string, string>
  const checkAllowed = (c: Context) => checkLimit.allow(`check:${ip(c)}`) && checkGlobal.allow('check')

  app.use('*', async (c, next) => {
    // Forms only from our own pages: a cross-site POST is refused before it reaches a handler.
    if (c.req.method === 'POST' && !c.req.path.startsWith('/api/') && !c.req.path.startsWith('/hooks/') && c.req.header('sec-fetch-site') === 'cross-site') {
      return c.text('cross-site request refused', 403)
    }
    await next()
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.header(k, v)
  })

  app.get('/health', (c) => c.json({ ok: true, version: VERSION }))
  app.get('/.well-known/openwebring.json', (c) => c.json(ringDescriptor(), 200, { 'access-control-allow-origin': '*' }))

  const TYPES: Record<string, string> = { css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', webmanifest: 'application/manifest+json', html: 'text/html; charset=utf-8', crt: 'application/x-x509-ca-cert' }
  app.get('/:file{(style\\.css|app\\.js|sw\\.js|favicon\\.svg|icon-192\\.png|icon-512\\.png|manifest\\.webmanifest|offline\\.html|moshpit-root-ca\\.crt)}', async (c) => {
    const name = c.req.param('file')
    const file = Bun.file(new URL(`../public/${name}`, import.meta.url))
    const cache = name === 'sw.js' ? 'no-cache' : 'public, max-age=86400'
    return c.body(await file.arrayBuffer(), 200, { 'content-type': TYPES[name.split('.').pop()!]!, 'cache-control': cache })
  })

  app.get('/', async (c) => page(c, homePage(await ctxOf(c))))
  app.get('/help', async (c) => page(c, helpPage(await ctxOf(c))))

  // ---- the free lookup -------------------------------------------------------------

  app.get('/check', async (c) => {
    const ctx = await ctxOf(c)
    const chainIn = c.req.query('chain')
    const addressIn = c.req.query('address')
    if (!addressIn) return page(c, checkPage(ctx, { ...(chainIn ? { chain: chainIn } : {}) }))
    const chain = parseChain(chainIn)
    const view = { chain: chainIn ?? '', address: addressIn }
    if (!chain) return page(c, checkPage(ctx, { ...view, error: 'Pick a chain from the list.' }), 400)
    const address = normalizeAddress(chain, addressIn)
    if (!address) return page(c, checkPage(ctx, { ...view, error: `That is not a ${CHAIN_INFO[chain].label} address.` }), 400)
    if (!checkAllowed(c)) return page(c, checkPage(ctx, { ...view, error: 'Too many lookups. Try again in a minute.' }), 429)
    try {
      return page(c, checkPage(ctx, { ...view, result: await lookupAddress(deps.sources, chain, address) }))
    } catch {
      return page(c, checkPage(ctx, { ...view, error: `We could not read ${CHAIN_INFO[chain].label} just now. Try again in a minute.` }), 502)
    }
  })

  // ---- signing in -------------------------------------------------------------

  app.get('/signin', async (c) => {
    const ctx = await ctxOf(c)
    if (ctx.user) return c.redirect(safeNext(c.req.query('next')))
    return page(c, signinPage(ctx, { next: safeNext(c.req.query('next')) }))
  })

  app.post('/signin', async (c) => {
    const ctx = await ctxOf(c)
    const f = await form(c)
    const email = String(f.email ?? '').trim().toLowerCase()
    if (!csrfOk(c, f.csrf)) return page(c, signinPage(ctx, { error: 'That form went stale. Try again.' }), 400)
    if (!EMAIL.test(email)) return page(c, signinPage(ctx, { error: 'That does not look like an email address.' }), 400)
    if (!signinLimit.allow(`ip:${ip(c)}`) || (await store.recentLoginLinks(email, 60 * 60_000)) >= 5) {
      return page(c, signinPage(ctx, { error: 'Too many sign-in emails. Try again in an hour.' }), 429)
    }
    const t = await store.newLoginLink(email)
    const next = safeNext(f.next)
    await notifier.mail({
      to: email,
      subject: 'Your watch.wallet sign-in link',
      text: `Sign in to watch.wallet:\n\n${origin(c)}/auth/${t}?next=${encodeURIComponent(next)}\n\nIt works once, for 20 minutes. If you didn't ask for this, ignore it.\n`,
    })
    return page(c, signinPage(ctx, { sent: email }))
  })

  app.get('/auth/:token', async (c) => page(c, confirmSigninPage(await ctxOf(c), c.req.param('token'), safeNext(c.req.query('next')))))

  app.post('/auth/:token', async (c) => {
    const f = await form(c)
    const email = await store.takeLoginLink(c.req.param('token'))
    if (!email) return page(c, messagePage(await ctxOf(c), { title: 'That link is used up', message: 'Sign-in links work once, for 20 minutes.', link: { href: '/signin', label: 'Send a new one' } }), 400)
    const user = await store.ensureUser(email)
    const sid = await store.newSession(user.id)
    setCookie(c, SESSION, sid, { httpOnly: true, secure: deps.secureCookies ?? https(c), sameSite: 'Lax', path: '/', maxAge: 60 * 86400 })
    return c.redirect(safeNext(f.next))
  })

  app.post('/auth/logout', async (c) => {
    const f = await form(c)
    if (csrfOk(c, f.csrf)) await store.endSession(sessionId(c))
    deleteCookie(c, SESSION, { path: '/' })
    return c.redirect('/')
  })

  // ---- the owner's pages ------------------------------------------------------

  const signedIn = async (c: Context): Promise<{ ctx: Ctx; user: User } | null> => {
    const ctx = await ctxOf(c)
    return ctx.user ? { ctx, user: ctx.user } : null
  }

  const dashboard = async (c: Context, ctx: Ctx, extra: { apiKey?: string; flash?: string; error?: string } = {}, status = 200) => {
    const user = ctx.user!
    return page(
      c,
      dashboardPage(ctx, { watches: await store.watches(user.id), alerts: await store.alerts(user.id, 20), limits: limitsFor(plans, user, nowMs()), plan: planLabel(plans, user, nowMs()), paid: isPaid(plans, user, nowMs()), callsEnabled: notifier.callsEnabled, vapid: notifier.vapidPublic, now: Date.now(), ...extra }),
      status,
    )
  }
  const back = (c: Context, flash: string, hash = '') => c.redirect(`/me?flash=${encodeURIComponent(flash)}${hash}`)

  app.get('/me', async (c) => {
    const s = await signedIn(c)
    if (!s) return c.redirect('/signin?next=/me')
    return dashboard(c, s.ctx, c.req.query('flash') ? { flash: c.req.query('flash')! } : {})
  })

  app.post('/me/:action{(phone|name|webhook|webhook-secret|key|delete)}', async (c) => {
    const s = await signedIn(c)
    if (!s) return c.redirect('/signin?next=/me')
    const f = await form(c)
    if (!csrfOk(c, f.csrf)) return dashboard(c, s.ctx, { error: 'That form went stale. Try again.' }, 400)
    switch (c.req.param('action')) {
      case 'phone': {
        const phone = String(f.phone ?? '').replace(/[\s().-]/g, '')
        if (phone && !/^\+[1-9]\d{7,14}$/.test(phone)) return dashboard(c, s.ctx, { error: 'Use international format, like +15551234567.' }, 400)
        await store.updateUser(s.user.id, { phone })
        return back(c, phone ? 'Number saved.' : 'Number removed.', '#phone')
      }
      case 'name':
        await store.updateUser(s.user.id, { name: String(f.name ?? '').trim() })
        return back(c, 'Saved.', '#account')
      case 'webhook': {
        const url = String(f.webhook_url ?? '').trim()
        const bad = url ? await webhookUrlError(url, deps.resolve) : null
        if (bad) return dashboard(c, s.ctx, { error: bad }, 400)
        await store.updateUser(s.user.id, { webhook_url: url })
        return back(c, url ? 'Webhook saved.' : 'Webhook removed.', '#webhook')
      }
      case 'webhook-secret':
        await store.rotateWebhookSecret(s.user.id)
        return back(c, 'New signing secret made. The old one stops working now.', '#webhook')
      case 'key':
        return dashboard(c, s.ctx, { apiKey: await store.newApiKey(s.user.id) })
      case 'delete':
        if (f.sure !== '1') return dashboard(c, s.ctx, { error: 'Tick the box to delete.' }, 400)
        await store.deleteUser(s.user.id)
        deleteCookie(c, SESSION, { path: '/' })
        return page(c, messagePage(await ctxOf(c), { title: 'Deleted', message: 'Your account, watches and alerts are gone. We stopped watching.' }))
    }
    return c.redirect('/me')
  })

  app.post('/push', async (c) => {
    const s = await signedIn(c)
    if (!s) return c.json({ error: 'sign in first' }, 401)
    if (!csrfOk(c, c.req.header('x-csrf'))) return c.json({ error: 'stale page, reload' }, 403)
    const body = (await c.req.json().catch(() => null)) as { endpoint?: string; keys?: { p256dh?: string; auth?: string } } | null
    const endpoint = body?.endpoint
    if (!endpoint || !/^https:\/\//.test(endpoint) || !body?.keys?.p256dh || !body.keys.auth) return c.json({ error: 'not a push subscription' }, 400)
    await store.addPush(s.user.id, { endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth })
    return c.json({ ok: true })
  })

  app.post('/w', async (c) => {
    const s = await signedIn(c)
    if (!s) return c.redirect('/signin?next=/me')
    const f = await form(c)
    if (!csrfOk(c, f.csrf)) return dashboard(c, s.ctx, { error: 'That form went stale. Try again.' }, 400)
    const limits = limitsFor(plans, s.user, nowMs())
    if ((await store.countWatches(s.user.id)) >= limits.watches) return dashboard(c, s.ctx, { error: `Your plan holds ${limits.watches} watches.` }, 402)
    const parsed = parseWatch(f, isPaid(plans, s.user, nowMs()))
    if (typeof parsed === 'string') return dashboard(c, s.ctx, { error: parsed }, 400)
    const w = await store.createWatch(s.user.id, parsed)
    return c.redirect(`/w/${w.id}?flash=${encodeURIComponent('Watching. The first read, within a minute, is the baseline; any change after that alerts you.')}`)
  })

  const ownWatch = async (c: Context): Promise<{ ctx: Ctx; user: User; w: Watch } | Response> => {
    const s = await signedIn(c)
    if (!s) return c.redirect(`/signin?next=${encodeURIComponent(c.req.path)}`)
    const w = await store.watchOf(s.user.id, c.req.param('id')!)
    if (!w) return page(c, messagePage(s.ctx, { title: 'Not found', message: 'No watch of yours has that address.', link: { href: '/me', label: 'My watches' } }), 404)
    return { ...s, w }
  }

  const showWatch = async (c: Context, ctx: Ctx, w: Watch, extra: { flash?: string; error?: string } = {}, status = 200) =>
    page(c, watchPage(ctx, { w, alerts: await store.alertsFor(w.id), paid: isPaid(plans, ctx.user!, nowMs()), now: Date.now(), ...extra }), status)

  app.get('/w/:id', async (c) => {
    const r = await ownWatch(c)
    if (r instanceof Response) return r
    return showWatch(c, r.ctx, r.w, c.req.query('flash') ? { flash: c.req.query('flash')! } : {})
  })

  /** Pause, resume, delete or edit; shared by the web and the API. Returns an error message or null. */
  const act = async (user: User, w: Watch, action: string, b: Record<string, unknown>): Promise<string | null> => {
    const paid = isPaid(plans, user, nowMs())
    switch (action) {
      case 'pause':
        await store.setWatchState(w.id, 'paused')
        return null
      case 'resume': {
        const limits = limitsFor(plans, user, nowMs())
        if (w.state === 'active') return null
        if ((await store.countWatches(user.id, true)) >= limits.watches) return `Your plan runs ${limits.watches} watches at once.`
        await store.setWatchState(w.id, 'active')
        return null
      }
      case 'delete':
        await store.deleteWatch(w.id)
        return null
      case 'edit': {
        const min = money(b.min_usd)
        if (min === null) return 'The dollar threshold must be a number.'
        const level = b.level_usd === undefined || b.level_usd === '' ? undefined : Number(b.level_usd)
        if (level !== undefined && !(Number.isFinite(level) && level > 0)) return 'Give a price in USD, like 60000.'
        const direction = b.direction === 'above' || b.direction === 'below' ? b.direction : undefined
        await store.updateWatch(w, {
          ...(b.label !== undefined ? { label: String(b.label).trim().slice(0, 60) } : {}),
          ...(b.min_usd !== undefined && paid ? { min_usd: min } : {}),
          ...(b.call !== undefined ? { call: paid && truthy(b.call) } : {}),
          ...(w.kind === 'price' && level !== undefined ? { level_usd: level } : {}),
          ...(w.kind === 'price' && direction ? { direction } : {}),
        })
        return null
      }
    }
    return 'unknown action'
  }

  const watchAction = async (c: Context, action: string) => {
    const r = await ownWatch(c)
    if (r instanceof Response) return r
    const f = await form(c)
    if (!csrfOk(c, f.csrf)) return showWatch(c, r.ctx, r.w, { error: 'That form went stale. Try again.' }, 400)
    // A web form leaves an unticked checkbox out; say so explicitly.
    const err = await act(r.user, r.w, action, action === 'edit' ? { call: '', ...f } : f)
    if (err) return showWatch(c, r.ctx, r.w, { error: err }, 400)
    if (action === 'delete') return back(c, 'Deleted.')
    const flash = { edit: 'Saved.', pause: 'Paused. We stop reading it until you resume.', resume: 'Resumed.' }[action] ?? ''
    return c.redirect(`/w/${r.w.id}?flash=${encodeURIComponent(flash)}`)
  }
  app.post('/w/:id', (c) => watchAction(c, 'edit'))
  app.post('/w/:id/:action{(pause|resume|delete)}', (c) => watchAction(c, c.req.param('action')))

  app.post('/alerts/ack', async (c) => {
    const s = await signedIn(c)
    if (!s) return c.redirect('/signin?next=/me')
    const f = await form(c)
    const n = csrfOk(c, f.csrf) ? await store.ackAll(s.user.id, 'web') : 0
    return back(c, `Acknowledged ${n}.`, '#alerts')
  })

  app.post('/alerts/:id/ack', async (c) => {
    const s = await signedIn(c)
    if (!s) return c.redirect('/signin?next=/me')
    const f = await form(c)
    const a = await store.alertById(c.req.param('id'))
    if (csrfOk(c, f.csrf) && a && a.user_id === s.user.id) await store.ack(a.id, 'web')
    return c.redirect(String(c.req.header('referer') ?? '').includes('/w/') && a ? `/w/${a.watch_id}` : '/me#alerts')
  })

  // ---- one-tap acknowledge (email link, push button) -----------------------------

  app.get('/a/:token', async (c) => {
    const ctx = await ctxOf(c)
    const alertId = alertForAckToken(deps.key, c.req.param('token'))
    const a = alertId ? await store.alertById(alertId) : null
    if (!a) return page(c, messagePage(ctx, { title: 'Nothing here', message: 'That link does not match an alert. It may have been deleted.' }), 404)
    return page(c, ackPage(ctx, c.req.param('token'), a))
  })

  app.post('/a/:token', async (c) => {
    const ctx = await ctxOf(c)
    const alertId = alertForAckToken(deps.key, c.req.param('token'))
    const done = alertId ? await store.ack(alertId, c.req.header('x-via') === 'push' ? 'push' : 'link') : false
    if (c.req.header('accept')?.includes('application/json')) return c.json({ ok: done })
    return page(c, messagePage(ctx, { title: done ? 'Acknowledged' : 'Already acknowledged', message: 'Thanks. We keep watching.', link: { href: '/me', label: 'My watches' } }))
  })

  // ---- plans -------------------------------------------------------------------

  const plansView = async (c: Context, ctx: Ctx, error?: string, status = 200) =>
    page(c, plansPage(ctx, { chains: plans.chains, plan: ctx.user ? planLabel(plans, ctx.user, nowMs()) : 'Free', paid: ctx.user ? isPaid(plans, ctx.user, nowMs()) : false, payments: ctx.user ? await store.payments(ctx.user.id) : [], enabled: Boolean(plans.coinpay), ...(error ? { error } : {}) }), status)

  app.get('/plans', async (c) => plansView(c, await ctxOf(c)))

  app.post('/plans/checkout', async (c) => {
    const s = await signedIn(c)
    if (!s) return c.redirect('/signin?next=/plans')
    const f = await form(c)
    if (!csrfOk(c, f.csrf)) return plansView(c, s.ctx, 'That form went stale. Try again.', 400)
    try {
      const out = await startCheckout(plans, store, { user: s.user, product: (f.product === 'year' ? 'year' : 'month') as Product, chain: String(f.chain ?? ''), successUrl: `${origin(c)}/me?flash=${encodeURIComponent('Payment sent. Watcher starts as soon as CoinPay confirms it.')}`, cancelUrl: `${origin(c)}/plans` }, deps.fetch)
      return c.redirect(out.checkoutUrl)
    } catch (e) {
      return plansView(c, s.ctx, e instanceof Error ? e.message : String(e), 502)
    }
  })

  app.post('/hooks/coinpay', async (c) => {
    const raw = await c.req.text()
    if (!plans.coinpay || !verifyWebhook(plans.coinpay.webhookSecret, raw, c.req.header('x-coinpay-signature') ?? c.req.header('coinpay-signature'))) return c.json({ error: 'bad signature' }, 401)
    let payload: unknown
    try {
      payload = JSON.parse(raw)
    } catch {
      return c.json({ error: 'bad json' }, 400)
    }
    const { ref, status } = readWebhook(payload)
    // Only payments we started count; the account comes from our row, never from the payload.
    const known = ref ? await store.payment(String(ref)) : null
    if (!known) return c.json({ ok: true, ignored: 'unknown payment' })
    const r = await store.settlePayment(known.ref, status, payload, SETTLED.has(status), daysFor)
    if (r.granted) {
      const u = await store.user(known.user_id)
      if (u) {
        // Watches a lapsed plan paused come back now, not on the next worker pass.
        await store.resumePlanPaused(u.id, limitsFor(plans, u, nowMs()).watches - (await store.countWatches(u.id, true)))
        await notifier.mail({ to: u.email, subject: 'Watcher is on', text: `Thanks for paying. Your plan: ${planLabel(plans, u, nowMs())}.\n\nEvery watch is now checked every minute, and phone calls, webhooks and dollar thresholds are on.\n\n${RELAY_ORIGIN}/me\n` })
      }
    }
    return c.json({ ok: true, status, granted: r.granted })
  })

  // Telnyx Call Control: answered -> say what moved, ask for 1 -> 1 acknowledges.
  app.post('/hooks/telnyx', async (c) => {
    const raw = await c.req.text()
    if (!telnyxSignatureOk(deps.telnyxPublicKey, raw, c.req.header('telnyx-signature-ed25519'), c.req.header('telnyx-timestamp'))) return c.json({ error: 'bad signature' }, 401)
    const event = JSON.parse(raw)?.data
    const callId = event?.payload?.call_control_id
    const alertId = callId ? await store.callAlert(callId) : null
    if (!alertId) return c.json({ ok: true })
    const a = await store.alertById(alertId)
    const doFetch = deps.fetch ?? fetch
    const say = (payload: string) => telnyxCommand(deps.notify, callId, 'speak', { payload, voice: 'female', language: 'en-US' }, doFetch)
    switch (event.event_type) {
      case 'call.answered':
        await telnyxCommand(deps.notify, callId, 'gather_using_speak', {
          payload: `watch dot wallet alert: ${a?.speech ?? 'one of your watches moved'}. Press 1 to acknowledge.`,
          voice: 'female', language: 'en-US', minimum_digits: 1, maximum_digits: 1, valid_digits: '1', timeout_millis: 15000,
        }, doFetch)
        break
      case 'call.gather.ended':
        if (event.payload?.digits === '1' && a) {
          await store.ack(a.id, 'phone')
          await say('Acknowledged. We keep watching. Goodbye.')
        } else await say('We did not get a 1. The details are in your email. Goodbye.')
        break
      case 'call.speak.ended':
        await telnyxCommand(deps.notify, callId, 'hangup', {}, doFetch)
        break
    }
    return c.json({ ok: true })
  })

  // ---- the JSON API (Bearer ww_…) ----------------------------------------------

  const api = new Hono<{ Variables: { user: User } }>()
  api.get('/check', async (c) => {
    const chain = parseChain(c.req.query('chain'))
    if (!chain) return c.json({ error: 'chain must be bitcoin, ethereum, base, polygon or solana' }, 400)
    const address = normalizeAddress(chain, c.req.query('address'))
    if (!address) return c.json({ error: `not a ${CHAIN_INFO[chain].label} address` }, 400)
    if (!checkAllowed(c)) return c.json({ error: 'slow down: 10 lookups a minute' }, 429)
    try {
      return c.json(await lookupAddress(deps.sources, chain, address), 200, { 'access-control-allow-origin': '*' })
    } catch {
      return c.json({ error: `could not read ${CHAIN_INFO[chain].label} just now` }, 502)
    }
  })
  api.use('*', async (c, next) => {
    if (!apiLimit.allow(`api:${ip(c)}`)) return c.json({ error: 'slow down: 120 requests a minute' }, 429)
    const key = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
    const user = key ? await store.userByApiKey(key) : null
    if (!user) return c.json({ error: 'send Authorization: Bearer ww_… (make a key at /me)' }, 401)
    c.set('user', user)
    await next()
  })

  const view = (w: Watch) => ({
    id: w.id, kind: w.kind, label: w.label, name: watchName(w), state: w.state, paused_reason: w.paused_reason,
    chain: w.chain, address: w.address, coin: w.coin, direction: w.direction, level_usd: w.level_usd, min_usd: w.min_usd, call: w.call,
    balances: w.balances, balances_text: w.kind === 'address' ? describeBalances(w.chain as Chain, w.balances) : null,
    price: w.price, armed: w.armed, last_checked_at: w.last_checked_at, last_change_at: w.last_change_at, next_check_at: w.next_check_at,
    fail_count: w.fail_count, last_error: w.last_error, created_at: w.created_at, url: `${RELAY_ORIGIN}/w/${w.id}`,
  })
  const alertView = (a: { id: string; watch_id: string; at: Date; kind: string; summary: string; usd: number | null; detail: unknown; acked_at: Date | null; acked_via: string }) => ({
    id: a.id, watch_id: a.watch_id, at: a.at, kind: a.kind, summary: a.summary, usd: a.usd, detail: a.detail, acked_at: a.acked_at, acked_via: a.acked_via,
  })

  api.get('/me', async (c) => {
    const u = c.get('user')
    return c.json({ email: u.email, name: u.name, plan: planLabel(plans, u, nowMs()), paid: isPaid(plans, u, nowMs()), limits: limitsFor(plans, u, nowMs()), webhook_url: u.webhook_url, watches: (await store.watches(u.id)).map(view) })
  })
  api.get('/watches', async (c) => c.json({ watches: (await store.watches(c.get('user').id)).map(view) }))
  api.post('/watches', async (c) => {
    const u = c.get('user')
    const b = ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
    const limits = limitsFor(plans, u, nowMs())
    if ((await store.countWatches(u.id)) >= limits.watches) return c.json({ error: `your plan holds ${limits.watches} watches` }, 402)
    const parsed = parseWatch(b, isPaid(plans, u, nowMs()))
    if (typeof parsed === 'string') return c.json({ error: parsed }, 400)
    return c.json(view(await store.createWatch(u.id, parsed)), 201)
  })
  const apiWatch = async (c: Context<{ Variables: { user: User } }>) => store.watchOf(c.get('user').id, c.req.param('id')!)
  api.get('/watches/:id', async (c) => {
    const w = await apiWatch(c)
    return w ? c.json({ ...view(w), alerts: (await store.alertsFor(w.id, 20)).map(alertView) }) : c.json({ error: 'not found' }, 404)
  })
  api.patch('/watches/:id', async (c) => {
    const w = await apiWatch(c)
    if (!w) return c.json({ error: 'not found' }, 404)
    const b = ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
    const err = await act(c.get('user'), w, 'edit', b)
    return err ? c.json({ error: err }, 400) : c.json(view((await store.watchById(w.id))!))
  })
  api.delete('/watches/:id', async (c) => {
    const w = await apiWatch(c)
    if (!w) return c.json({ error: 'not found' }, 404)
    await store.deleteWatch(w.id)
    return c.json({ ok: true })
  })
  api.post('/watches/:id/:action{(pause|resume)}', async (c) => {
    const w = await apiWatch(c)
    if (!w) return c.json({ error: 'not found' }, 404)
    const err = await act(c.get('user'), w, c.req.param('action'), {})
    return err ? c.json({ error: err }, 402) : c.json(view((await store.watchById(w.id))!))
  })
  api.get('/alerts', async (c) => c.json({ alerts: (await store.alerts(c.get('user').id, Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 20) || 20)))).map(alertView) }))
  api.post('/alerts/ack', async (c) => {
    const b = ((await c.req.json().catch(() => ({}))) ?? {}) as { watch_id?: string; via?: string }
    const via = ['cli', 'mcp', 'tui', 'api'].includes(String(b.via)) ? String(b.via) : 'api'
    return c.json({ acknowledged: await store.ackAll(c.get('user').id, via, b.watch_id) })
  })
  api.post('/alerts/:id/ack', async (c) => {
    const a = await store.alertById(c.req.param('id'))
    if (!a || a.user_id !== c.get('user').id) return c.json({ error: 'not found' }, 404)
    const b = ((await c.req.json().catch(() => ({}))) ?? {}) as { via?: string }
    return c.json({ acknowledged: (await store.ack(a.id, ['cli', 'mcp', 'tui'].includes(String(b.via)) ? String(b.via) : 'api')) ? 1 : 0 })
  })
  app.route('/api/v1', api)

  app.notFound(async (c) => page(c, messagePage(await ctxOf(c), { title: 'Not found', message: 'Nothing lives at this address.' }), 404))
  return app
}

/** Telnyx signs `${timestamp}|${body}` with Ed25519; the portal shows the bare 32-byte key in base64. */
export function telnyxSignatureOk(publicKey: string | undefined, raw: string, signature: string | undefined, timestamp: string | undefined, nowSeconds = Date.now() / 1000): boolean {
  if (!publicKey || !signature || !timestamp || Math.abs(nowSeconds - Number(timestamp)) > 300) return false
  try {
    const bare = Buffer.from(publicKey, 'base64')
    const der = bare.length === 32 ? Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), bare]) : bare
    return verify(null, Buffer.from(`${timestamp}|${raw}`), createPublicKey({ key: der, format: 'der', type: 'spki' }), Buffer.from(signature, 'base64'))
  } catch {
    return false
  }
}

export async function serve(opts: { port?: number } = {}) {
  const env = process.env
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set (postgres://…)')
  if (!env.WATCHWALLET_SECRET || env.WATCHWALLET_SECRET.length < 32) throw new Error('WATCHWALLET_SECRET must be at least 32 characters')
  const store = new Store(env.DATABASE_URL)
  await store.migrate()
  const plans = planConfig(env)
  const notify = notifyConfig(env, RELAY_ORIGIN)
  const notifier = createNotifier(notify, store)
  const sources = sourceConfig(env)
  const app = createApp({ store, key: env.WATCHWALLET_SECRET, plans, notifier, notify, sources, ...(env.TELNYX_PUBLIC_KEY ? { telnyxPublicKey: env.TELNYX_PUBLIC_KEY } : {}) })
  // The relay hostname, so pit.world serves the Moshpit footer template.
  startPitFooterRefresh('watch.wallet.pit.world')
  startRingFooterRefresh()
  startRingRefresh()
  if (env.WORKER !== 'off') startWorker({ store, notifier, plans, key: env.WATCHWALLET_SECRET, origin: RELAY_ORIGIN, sources, log: console.log })
  const port = opts.port ?? Number(env.PORT ?? 8805)
  return Bun.serve({ port, hostname: env.HOST ?? '127.0.0.1', fetch: app.fetch, idleTimeout: 30 })
}

if (import.meta.main) {
  const s = await serve()
  console.log(`watch.wallet ${VERSION} listening on http://${s.hostname}:${s.port}`)
}
