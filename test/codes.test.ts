/**
 * Credit codes and invites against a real Postgres (TEST_DATABASE_URL, see
 * app.test.ts): a code adds Watcher days through the payments path, a used or
 * unknown code is refused, an invite is spent once and only by a new account
 * (both people get Watcher days), and ?ref= is first touch.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { Codes, INVITE_DAYS, WATCHER_DAYS } from '../src/codes.ts'
import { codesAdmin } from '../src/codes-admin.ts'
import { Store } from '../src/db.ts'
import { createNotifier, type NotifyConfig } from '../src/notify.ts'
import { planConfig } from '../src/plans.ts'
import { createApp } from '../src/server.ts'
import { sourceConfig } from '../src/sources.ts'

const BASE = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:test@127.0.0.1:55491/postgres'
const db = `ww_codes_${process.pid}_${Date.now()}`
const DAY = 86_400_000
const mails: { to: string; text: string }[] = []
const fakeFetch = (async (input: string, init?: RequestInit) => {
  if (String(input) === 'https://api.resend.com/emails') {
    const m = JSON.parse(String(init!.body))
    mails.push({ to: m.to[0], text: m.text })
    return Response.json({ id: 'm' })
  }
  return new Response('no route', { status: 404 })
}) as unknown as typeof fetch
const notify: NotifyConfig = { resendKey: 're_test', mailFrom: 'watch.wallet <alerts@pit.world>', vapidSubject: 'mailto:alerts@pit.world', callHook: 'https://watch.wallet.pit.world/hooks/telnyx' }
const plans = planConfig({})

let store: Store
let app: ReturnType<typeof createApp>
let codes: Codes

type Browser = { cookies: Map<string, string> }
const browser = (): Browser => ({ cookies: new Map() })
const send = async (b: Browser, path: string, init: RequestInit = {}) => {
  const cookie = [...b.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  const res = await app.request(path, { ...init, headers: { 'x-forwarded-proto': 'https', host: 'watch.wallet.pit.world', ...(cookie ? { cookie } : {}), ...(init.headers as Record<string, string>) } })
  for (const c of res.headers.getSetCookie()) {
    const [kv] = c.split(';')
    const [k, v] = kv!.split('=')
    if (/max-age=0/i.test(c) || v === '') b.cookies.delete(k!)
    else b.cookies.set(k!, v!)
  }
  return res
}
const form = (fields: Record<string, string>): RequestInit => ({ method: 'POST', body: new URLSearchParams(fields), headers: { 'content-type': 'application/x-www-form-urlencoded' } })
const signIn = async (b: Browser, email: string) => {
  await send(b, '/signin', form({ csrf: 'anon', email, next: '/me' }))
  const t = mails.at(-1)!.text.match(/\/auth\/([A-Za-z0-9_-]+)/)![1]!
  expect((await send(b, `/auth/${t}`, form({ next: '/me' }))).status).toBe(302)
  const page = await (await send(b, '/me')).text()
  return page.match(/name="csrf" value="([a-f0-9]{32})"/)![1]!
}
const userOf = async (email: string) => (await store.userByEmail(email))!

beforeAll(async () => {
  const admin = new SQL(BASE)
  await admin.unsafe(`CREATE DATABASE ${db}`)
  await admin.close()
  store = new Store(BASE.replace(/\/[^/]*$/, `/${db}`))
  await store.migrate()
  const notifier = createNotifier(notify, store, fakeFetch, () => {})
  app = createApp({ store, key: 'k'.repeat(40), plans, notifier, notify, sources: sourceConfig({}, fakeFetch), fetch: fakeFetch, secureCookies: false })
  codes = new Codes(store, plans)
})

afterAll(async () => {
  await store?.close()
  const admin = new SQL(BASE)
  await admin.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`)
  await admin.close()
})

describe('credit codes', () => {
  test('a good code adds Watcher days as a settled $0 payment; again, unknown and used-up codes are refused', async () => {
    const b = browser()
    const csrf = await signIn(b, 'redeemer@example.com')
    const { code } = await codes.credits.mint({ grant: { unit: WATCHER_DAYS, amount: 30 }, label: 'test' })
    // Typed loosely: lower case, spaces.
    const ok = await send(b, '/me/redeem', form({ csrf, code: ` ${code.toLowerCase()} ` }))
    expect(ok.status).toBe(302)
    expect(decodeURIComponent(ok.headers.get('location')!)).toContain('30 days of Watcher added')
    const u = await userOf('redeemer@example.com')
    expect(u.plan).toBe('watcher')
    expect(Math.round((u.plan_until!.getTime() - Date.now()) / DAY)).toBe(30)
    const [p] = await store.payments(u.id)
    expect([p!.amount_cents, p!.chain, Boolean(p!.settled_at)]).toEqual([0, 'credit-code', true])
    expect(await codes.credits.balance(u.id, WATCHER_DAYS)).toBe(0)
    expect(await (await send(b, '/me')).text()).toContain('Watcher, until')

    const again = await send(b, '/me/redeem', form({ csrf, code }))
    expect(again.status).toBe(400)
    expect(await again.text()).toContain('You already redeemed that code.')
    const bad = await send(b, '/me/redeem', form({ csrf, code: 'CR-AAAA-BBBB-CCCC-DDDD' }))
    expect(bad.status).toBe(400)
    expect(await bad.text()).toContain('That code is not valid.')

    // A second code stacks on the time left.
    const second = await codes.credits.mint({ grant: { unit: WATCHER_DAYS, amount: 10 } })
    expect(await codes.redeem(u, second.code)).toContain('10 days of Watcher added')
    expect(Math.round(((await userOf(u.email)).plan_until!.getTime() - Date.now()) / DAY)).toBe(40)

    // Single-use: someone else gets used_up.
    const other = await store.ensureUser('other@example.com')
    await expect(codes.redeem(other, second.code)).rejects.toThrow('That code has been used.')
  })

  test('the API redeems with a key', async () => {
    const u = await store.ensureUser('api@example.com')
    const key = await store.newApiKey(u.id)
    const { code } = await codes.credits.mint({ grant: { unit: WATCHER_DAYS, amount: 7 } })
    const call = (c: string) => app.request('/api/v1/redeem', { method: 'POST', body: JSON.stringify({ code: c }), headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' } })
    const r = await call(code)
    expect(r.status).toBe(200)
    expect(((await r.json()) as { plan: string }).plan).toStartWith('Watcher, until')
    expect((await call(code)).status).toBe(400)
    expect((await call('nope-nope')).status).toBe(400)
  })

  test('a server-side grant switches on at /me; the admin CLI mints', async () => {
    const lines: string[] = []
    expect(await codesAdmin(['mint', '5', '--label=cli', '--max=2'], { log: (t) => lines.push(t) }, { DATABASE_URL: BASE.replace(/\/[^/]*$/, `/${db}`) })).toBe(0)
    expect(lines[0]).toMatch(/^CR-/)
    const b = browser()
    await signIn(b, 'granted@example.com')
    const u = await userOf('granted@example.com')
    await codes.credits.grant(u.id, { unit: WATCHER_DAYS, amount: 3 }, 'test')
    expect((await userOf(u.email)).plan).toBe('free')
    expect(await (await send(b, '/me')).text()).toContain('Watcher, until')
  })
})

describe('invites and ?ref=', () => {
  test('an invite is spent once, only by a new account, and gives both people Watcher days', async () => {
    const inviter = browser()
    const csrf = await signIn(inviter, 'inviter@example.com')
    const made = await send(inviter, '/invites', form({ csrf, note: 'for Dan' }))
    const link = (await made.text()).match(/https:\/\/watch\.wallet\.pit\.world\/i\/([A-Za-z0-9-]+)/)![1]!
    const quota = await codes.affiliates.quota((await userOf('inviter@example.com')).id)
    expect(quota).toEqual({ total: 3, used: 1, left: 2 })

    // Someone who already has an account: the invite is not spent.
    const existing = browser()
    await signIn(existing, 'existing@example.com')
    const e2 = browser()
    expect((await send(e2, `/i/${link}`)).status).toBe(200)
    await signIn(e2, 'existing@example.com')
    expect((await codes.affiliates.invites((await userOf('inviter@example.com')).id))[0]!.usedAt).toBeNull()

    // A new account through the link: spent, and both get INVITE_DAYS.
    const dan = browser()
    expect(await (await send(dan, `/i/${link}`)).text()).toContain("You're invited")
    expect(dan.cookies.get('ww_invite')).toBe(link)
    await signIn(dan, 'dan@example.com')
    expect(dan.cookies.has('ww_invite')).toBe(false)
    const d = await userOf('dan@example.com')
    const i = await userOf('inviter@example.com')
    for (const u of [d, i]) {
      expect(u.plan).toBe('watcher')
      expect(Math.round((u.plan_until!.getTime() - Date.now()) / DAY)).toBe(INVITE_DAYS)
    }
    expect(await codes.affiliates.invitedBy(d.id)).toBe(i.id)

    // The same link again, for another new account: nothing.
    const eve = browser()
    await send(eve, `/i/${link}`)
    await signIn(eve, 'eve@example.com')
    expect((await userOf('eve@example.com')).plan).toBe('free')
    expect(Math.round(((await userOf(i.email)).plan_until!.getTime() - Date.now()) / DAY)).toBe(INVITE_DAYS)
  })

  test('three invites each, over the web and the API', async () => {
    const u = await store.ensureUser('quota@example.com')
    const key = await store.newApiKey(u.id)
    const mk = () => app.request('/api/v1/invites', { method: 'POST', body: '{}', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' } })
    for (const left of [2, 1, 0]) expect(((await (await mk()).json()) as { left: number }).left).toBe(left)
    const fourth = await mk()
    expect(fourth.status).toBe(400)
    expect(((await fourth.json()) as { error: string }).error).toBe('You have used all your invites.')
  })

  test('?ref= is remembered first touch and credited to a new account', async () => {
    const a = await store.ensureUser('affiliate@example.com')
    const b = await store.ensureUser('affiliate2@example.com')
    const refA = await codes.affiliates.affiliateCode(a.id)
    const refB = await codes.affiliates.affiliateCode(b.id)
    const visitor = browser()
    await send(visitor, `/?ref=${refA}`)
    await send(visitor, `/plans?ref=${refB}`)
    expect(visitor.cookies.get('ww_ref')).toBe(refA)
    await signIn(visitor, 'newbie@example.com')
    expect(await codes.affiliates.affiliateOf((await userOf('newbie@example.com')).id)).toBe(a.id)
  })
})
