/**
 * The whole flow against a real Postgres, with a fake network: sign in, add
 * watches, the worker reads balances and alerts once per move, a failed read
 * never alerts, price alerts fire and re-arm, a CoinPay webhook grants once,
 * our own webhook is signed, and a lapsed plan pauses (never deletes) the
 * extra watches. Needs TEST_DATABASE_URL (a server we may create databases on):
 *
 *   docker run -d --name ww-test-pg -e POSTGRES_PASSWORD=test -p 127.0.0.1:55491:5432 postgres:16-alpine
 *   TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55491/postgres bun test
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { SQL } from 'bun'
import { Store } from '../src/db.ts'
import { createNotifier, type NotifyConfig } from '../src/notify.ts'
import { planConfig, verifyWebhook } from '../src/plans.ts'
import { createApp } from '../src/server.ts'
import { Backoff, sourceConfig } from '../src/sources.ts'
import { tick, type WorkerDeps } from '../src/worker.ts'

const BASE = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:test@127.0.0.1:55491/postgres'
const KEY = 'k'.repeat(40)
const db = `ww_test_${process.pid}_${Date.now()}`
const MIN = 60_000
const DAY = 86_400_000
const ETH = 10n ** 18n
const A = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045'
const B = '0x000000000000000000000000000000000000dead'

// ---- the fake world --------------------------------------------------------------
let clock = Date.now()
const world = { eth: new Map<string, { ETH: bigint; USDC: bigint }>([[A, { ETH: 2n * ETH, USDC: 0n }]]), rpcDown: false, prices: { BTC: 80_000, ETH: 2_000 } as Record<string, number> }
const mails: { to: string; subject: string; text: string }[] = []
const hooks: { url: string; body: string; signature: string }[] = []
let payN = 0

const fakeFetch = (async (input: string, init?: RequestInit) => {
  const url = String(input)
  const body = init?.body ? String(init.body) : ''
  if (url === 'https://api.resend.com/emails') {
    const m = JSON.parse(body)
    mails.push({ to: m.to[0], subject: m.subject, text: m.text })
    return Response.json({ id: 'm' })
  }
  if (url.startsWith('https://hooks.example/')) {
    hooks.push({ url, body, signature: (init!.headers as Record<string, string>)['x-watchwallet-signature']! })
    return new Response('ok')
  }
  if (url.endsWith('/api/payments/create')) return Response.json({ success: true, payment: { id: `pay_${++payN}` } })
  if (url.startsWith('https://cb.test/v2/prices/')) {
    const coin = url.split('/').at(-2)!.replace('-USD', '')
    return world.prices[coin] ? Response.json({ data: { amount: String(world.prices[coin]), base: coin, currency: 'USD' } }) : Response.json({ message: 'not found' }, { status: 404 })
  }
  if (url.startsWith('https://rpc.test/')) {
    if (world.rpcDown && url.endsWith('/eth')) return new Response('Your access is limited.', { status: 403 })
    const rpc = JSON.parse(body)
    const hex = (n: bigint) => Response.json({ jsonrpc: '2.0', id: 1, result: `0x${n.toString(16)}` })
    if (rpc.method === 'eth_getBalance') return hex(world.eth.get(rpc.params[0])?.ETH ?? 0n)
    if (rpc.method === 'eth_call') {
      const holder = `0x${rpc.params[0].data.slice(-40)}`
      const usdc = rpc.params[0].to.toLowerCase() === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
      return hex(usdc ? (world.eth.get(holder)?.USDC ?? 0n) : 0n)
    }
  }
  return new Response('no route', { status: 404 })
}) as unknown as typeof fetch

const sources = sourceConfig({ WATCHWALLET_RPC_ETHEREUM: 'https://rpc.test/eth', WATCHWALLET_RPC_BASE: 'https://rpc.test/base', WATCHWALLET_RPC_POLYGON: 'https://rpc.test/poly', WATCHWALLET_RPC_SOLANA: 'https://rpc.test/sol', MEMPOOL_URL: 'https://mempool.test', COINBASE_URL: 'https://cb.test' }, fakeFetch)
const resolve = async () => ['93.184.216.34']
const plans = planConfig({ COINPAY_API_KEY: 'cp_key', COINPAY_BUSINESS_ID: 'biz', COINPAY_WEBHOOK_SECRET: 'whsec', COINPAY_API_URL: 'https://coinpay.test' })
const notify: NotifyConfig = { resendKey: 're_test', mailFrom: 'watch.wallet <alerts@pit.world>', vapidSubject: 'mailto:alerts@pit.world', callHook: 'https://watch.wallet.pit.world/hooks/telnyx' }

let store: Store
let app: ReturnType<typeof createApp>
let worker: WorkerDeps

describe('watch.wallet end to end', () => {
  let cookie = ''
  let csrf = ''
  let watchA = ''
  let priceW = ''
  let apiKey = ''

  const req = (path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { 'x-forwarded-proto': 'https', host: 'watch.wallet.pit.world', 'x-moshpit-name': 'watch.wallet', ...(cookie ? { cookie } : {}), ...(init.headers as Record<string, string>) } })
  const post = (path: string, fields: Record<string, string>) => req(path, { method: 'POST', body: new URLSearchParams({ csrf, ...fields }), headers: { 'content-type': 'application/x-www-form-urlencoded' } })
  const api = (path: string, init: RequestInit = {}) => req(path, { ...init, headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', ...(init.headers as Record<string, string>) } })
  const run = (at = clock) => tick(worker, at)
  const alertCount = async (watchId: string) => (await store.alertsFor(watchId)).length
  const owner = async () => (await store.userByEmail('owner@example.com'))!
  const signCoinpay = (raw: string) => {
    const t = Math.floor(Date.now() / 1000)
    return `t=${t},v1=${createHmac('sha256', 'whsec').update(`${t}.${raw}`).digest('hex')}`
  }
  const settle = async (ref: string) => {
    const body = JSON.stringify({ id: `evt_${ref}`, type: 'payment.confirmed', data: { payment_id: ref, status: 'confirmed' } })
    return (await req('/hooks/coinpay', { method: 'POST', body, headers: { 'x-coinpay-signature': signCoinpay(body) } })).json()
  }

  beforeAll(async () => {
    const admin = new SQL(BASE)
    await admin.unsafe(`CREATE DATABASE ${db}`)
    await admin.close()
    store = new Store(BASE.replace(/\/[^/]*$/, `/${db}`), () => new Date(clock))
    await store.migrate()
    await store.migrate() // twice: idempotent
    const notifier = createNotifier(notify, store, fakeFetch, () => {}, resolve)
    app = createApp({ store, key: KEY, plans, notifier, notify, sources, fetch: fakeFetch, secureCookies: false, resolve })
    worker = { store, notifier, plans, key: KEY, origin: 'https://watch.wallet.pit.world', sources, backoff: new Backoff(), log: () => {} }
  })

  afterAll(async () => {
    await store?.close()
    const admin = new SQL(BASE)
    await admin.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`)
    await admin.close()
  })

  test('sign in by email link, one click, one use', async () => {
    const res = await req('/signin', { method: 'POST', body: new URLSearchParams({ csrf: 'anon', email: 'Owner@Example.com', next: '/me' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    expect(res.status).toBe(200)
    const t = mails.at(-1)!.text.match(/\/auth\/([A-Za-z0-9_-]+)/)![1]!
    expect((await req(`/auth/${t}`)).status).toBe(200) // GET only shows a button
    const ok = await req(`/auth/${t}`, { method: 'POST', body: new URLSearchParams({ next: '/me' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    expect(ok.status).toBe(302)
    cookie = ok.headers.get('set-cookie')!.split(';')[0]!
    expect((await req(`/auth/${t}`, { method: 'POST', body: new URLSearchParams({}) })).status).toBe(400)
    const page = await (await req('/me')).text()
    expect(page).toContain('owner@example.com')
    csrf = page.match(/name="csrf" value="([a-f0-9]{32})"/)![1]!
  })

  test('cross-site form posts are refused', async () => {
    const res = await req('/me/name', { method: 'POST', body: new URLSearchParams({ csrf, name: 'x' }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'cross-site' } })
    expect(res.status).toBe(403)
  })

  test('add watches: bad addresses refused, free plan holds three', async () => {
    const bad = await post('/w', { kind: 'address', chain: 'ethereum', address: '0x1234' })
    expect(bad.status).toBe(400)
    expect(await bad.text()).toContain('That is not a Ethereum address.')
    const res = await post('/w', { kind: 'address', chain: 'ethereum', address: A.toUpperCase().replace('0X', '0x'), label: 'Cold', min_usd: '500', call: '1' })
    expect(res.status).toBe(302)
    watchA = res.headers.get('location')!.match(/\/w\/([^?]+)/)![1]!
    const w = (await store.watchById(watchA))!
    // Free plan: no threshold, no call.
    expect([w.address, w.min_usd, w.call]).toEqual([A, 0, false])
    const p = await post('/w', { kind: 'price', coin: 'btc', direction: 'above', level_usd: '100000' })
    priceW = p.headers.get('location')!.match(/\/w\/([^?]+)/)![1]!
    expect((await post('/w', { kind: 'address', chain: 'base', address: B })).status).toBe(302)
    const fourth = await post('/w', { kind: 'address', chain: 'base', address: A })
    expect(fourth.status).toBe(402)
    expect(await fourth.text()).toContain('Your plan holds 3 watches.')
  })

  test('the first read is the baseline; a move alerts exactly once, even with two workers', async () => {
    expect(await run()).toEqual({ checked: 3, alerts: 0, failed: 0 })
    expect((await store.watchById(watchA))!.baseline).toEqual({ ETH: (2n * ETH).toString(), USDC: '0', USDT: '0' })
    world.eth.set(A, { ETH: (3n * ETH) / 2n, USDC: 0n })
    // Free plan: not due again for 15 minutes.
    expect((await run()).checked).toBe(0)
    clock += 15 * MIN
    mails.length = 0
    const [r1, r2] = await Promise.all([run(), run()])
    expect(r1!.alerts + r2!.alerts).toBe(1)
    expect(await alertCount(watchA)).toBe(1)
    const mail = mails.find((m) => m.subject.includes('moved'))!
    expect(mail.subject).toBe('watch.wallet: Cold moved: 0.5 ETH out (~$1,000)')
    expect(mail.text).toContain('https://etherscan.io/address/' + A)
    const t = mail.text.match(/\/a\/([A-Za-z0-9_.-]+)/)![1]!
    expect(await (await req(`/a/${t}`)).text()).toContain('Was this you?')
    expect(await (await req(`/a/${t}`, { method: 'POST', headers: { accept: 'application/json' } })).json()).toEqual({ ok: true })
    expect(await (await req(`/a/${t}`, { method: 'POST', headers: { accept: 'application/json' } })).json()).toEqual({ ok: false })
    expect((await store.alertsFor(watchA))[0]!.acked_via).toBe('link')
    expect((await req(`/a/${t.slice(0, -2)}xx`)).status).toBe(404)
  })

  test('a failed read never alerts and keeps the baseline; the next good read does', async () => {
    world.rpcDown = true
    world.eth.set(A, { ETH: ETH, USDC: 0n })
    clock += 15 * MIN
    const r = await run()
    expect(r.alerts).toBe(0)
    expect(r.failed).toBe(1)
    let w = (await store.watchById(watchA))!
    expect(w.fail_count).toBe(1)
    expect(w.last_error).toContain('403')
    expect(w.baseline!.ETH).toBe(((3n * ETH) / 2n).toString())
    world.rpcDown = false
    clock += 15 * MIN
    expect((await run()).alerts).toBe(1)
    w = (await store.watchById(watchA))!
    expect([w.fail_count, w.last_error, w.baseline!.ETH]).toEqual([0, '', ETH.toString()])
  })

  test('regression: a timestamp written by SQL with microseconds is still picked up', async () => {
    // JS Dates carry milliseconds, Postgres microseconds: compare-and-set must not depend on a timestamp.
    await store.sql`UPDATE watches SET next_check_at = ${new Date(clock - MIN)}::timestamptz + interval '123 microseconds' WHERE id = ${watchA}`
    const r = await run()
    expect(r.checked).toBe(1)
    expect((await store.watchById(watchA))!.last_checked_at!.getTime()).toBe(clock)
  })

  test('price watch: fires once at the level, re-arms when it crosses back', async () => {
    world.prices.BTC = 100_500
    clock += 15 * MIN
    await run()
    expect(await alertCount(priceW)).toBe(1)
    expect((await store.alertsFor(priceW))[0]!.summary).toBe('BTC is above $100,000: now $100,500')
    clock += 15 * MIN
    await run()
    expect(await alertCount(priceW)).toBe(1)
    world.prices.BTC = 99_000
    clock += 15 * MIN
    await run()
    expect((await store.watchById(priceW))!.armed).toBe(true)
    world.prices.BTC = 101_000
    clock += 15 * MIN
    await run()
    expect(await alertCount(priceW)).toBe(2)
  })

  test('paying: checkout records the payment, a signed webhook grants 30 days once', async () => {
    const res = await post('/plans/checkout', { product: 'month', chain: 'USDC_SOL' })
    expect(res.headers.get('location')).toBe('https://coinpay.test/pay/pay_1')
    const body = JSON.stringify({ data: { payment_id: 'pay_1', status: 'confirmed' } })
    expect((await req('/hooks/coinpay', { method: 'POST', body, headers: { 'x-coinpay-signature': 't=1,v1=00' } })).status).toBe(401)
    expect((await settle('pay_1')).granted).toBe(true)
    expect((await settle('pay_1')).granted).toBe(false)
    const u = await owner()
    expect(u.plan).toBe('watcher')
    expect(Math.round((u.plan_until!.getTime() - clock) / DAY)).toBe(30)
  })

  test('Watcher: a dollar threshold adds up small moves, and every alert is a signed webhook', async () => {
    expect((await post('/me/webhook', { webhook_url: 'http://hooks.example/ww' })).status).toBe(400)
    expect((await post('/me/webhook', { webhook_url: 'https://hooks.example/ww' })).status).toBe(302)
    const secret = (await owner()).webhook_secret
    expect(secret).toStartWith('whsec_')
    expect((await post(`/w/${watchA}`, { label: 'Cold', min_usd: '100', call: '1' })).status).toBe(302)
    expect((await store.watchById(watchA))!).toMatchObject({ min_usd: 100, call: true })
    clock += 15 * MIN
    await run() // picks up the paid one-minute cadence
    hooks.length = 0
    world.eth.set(A, { ETH: ETH - ETH / 100n, USDC: 0n }) // 0.01 ETH = $20
    clock += MIN
    expect((await run()).alerts).toBe(0)
    world.eth.set(A, { ETH: ETH - (6n * ETH) / 100n, USDC: 0n }) // 0.06 ETH since the last alert = $120
    clock += MIN
    expect((await run()).alerts).toBe(1)
    expect(hooks).toHaveLength(1)
    const h = hooks[0]!
    expect(verifyWebhook(secret, h.body, h.signature)).toBe(true)
    const payload = JSON.parse(h.body)
    expect(payload.event).toBe('watch.alert')
    expect(payload.watch).toMatchObject({ id: watchA, label: 'Cold', chain: 'ethereum', address: A })
    expect(payload.alert.summary).toBe('Cold moved: 0.06 ETH out (~$120)')
  })

  test('API: key, watches, alerts, acknowledge; the public check needs no key', async () => {
    const page = await (await post('/me/key', {})).text()
    apiKey = page.match(/(ww_[A-Za-z0-9_-]+)/)![1]!
    expect((await req('/api/v1/me')).status).toBe(401)
    const me = await (await api('/api/v1/me')).json()
    expect(me.paid).toBe(true)
    expect(me.watches).toHaveLength(3)
    const created = await api('/api/v1/watches', { method: 'POST', body: JSON.stringify({ kind: 'price', coin: 'ETH', direction: 'below', level_usd: 1500 }) })
    expect(created.status).toBe(201)
    expect((await api('/api/v1/watches', { method: 'POST', body: JSON.stringify({ kind: 'address', chain: 'solana', address: 'nope' }) })).status).toBe(400)
    const alerts = (await (await api('/api/v1/alerts')).json()).alerts
    expect(alerts.length).toBeGreaterThanOrEqual(4)
    const { acknowledged } = await (await api('/api/v1/alerts/ack', { method: 'POST', body: JSON.stringify({ via: 'cli' }) })).json()
    expect(acknowledged).toBeGreaterThan(0)
    const patched = await (await api(`/api/v1/watches/${watchA}`, { method: 'PATCH', body: JSON.stringify({ label: 'Cold storage' }) })).json()
    expect([patched.label, patched.call]).toEqual(['Cold storage', true])
    cookie = ''
    const check = await (await req(`/api/v1/check?chain=eth&address=${A}`)).json()
    expect(check.rows.find((r: any) => r.asset === 'ETH')).toEqual({ asset: 'ETH', amount: '0.94', usd: 1880 })
    expect((await req('/api/v1/check?chain=eth&address=0x12')).status).toBe(400)
    expect(await (await req(`/check?chain=ethereum&address=${A}`)).text()).toContain('0.94')
  })

  test('a lapsed plan pauses the extra watches, never deletes; paying again brings them back', async () => {
    await api('/api/v1/watches', { method: 'POST', body: JSON.stringify({ kind: 'price', coin: 'SOL', direction: 'above', level_usd: 500 }) })
    const u = await owner()
    expect(await store.countWatches(u.id, true)).toBe(5)
    clock += 31 * DAY
    await run()
    const ws = await store.watches(u.id)
    expect(ws).toHaveLength(5)
    expect(ws.filter((w) => w.state === 'active').map((w) => w.id).slice(0, 2)).toEqual([watchA, priceW])
    expect(ws.filter((w) => w.paused_reason === 'plan')).toHaveLength(2)
    // The lapsed plan reads at the free cadence and ignores the threshold.
    expect((await store.watchById(watchA))!.next_check_at.getTime()).toBeGreaterThanOrEqual(clock + 15 * MIN - 1)
    cookie = `ww_session=${await store.newSession(u.id)}`
    csrf = (await (await req('/me')).text()).match(/name="csrf" value="([a-f0-9]{32})"/)![1]!
    await post('/plans/checkout', { product: 'year', chain: 'BTC' })
    expect((await settle('pay_2')).granted).toBe(true)
    expect(await store.countWatches(u.id, true)).toBe(5)
    expect(Math.round(((await owner()).plan_until!.getTime() - clock) / DAY)).toBe(365)
  })

  test('deleting the account removes every watch and alert', async () => {
    expect((await post('/me/delete', { sure: '1' })).status).toBe(200)
    const [r] = await store.sql`SELECT (SELECT count(*)::int FROM watches) AS w, (SELECT count(*)::int FROM alerts) AS a`
    expect(r).toEqual({ w: 0, a: 0 })
  })
})
