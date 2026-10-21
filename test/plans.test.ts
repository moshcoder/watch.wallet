import { describe, expect, test } from 'bun:test'
import { daysFor, FREE, isPaid, limitsFor, planConfig, verifyWebhook, WATCHER } from '../src/plans.ts'
import { privateAddress, signWebhook, webhookUrlError } from '../src/notify.ts'
import { parseWatch } from '../src/server.ts'
import { initialState, onKey } from '../src/tui.ts'

const now = Date.parse('2026-10-21T00:00:00Z')
const user = (o: object = {}) => ({ email: 'a@example.com', plan: 'free' as const, plan_until: null as Date | null, ...o })

describe('plan limits', () => {
  test('free: 3 watches every 15 minutes, no calls, webhooks or thresholds', () => {
    expect(FREE).toEqual({ watches: 3, everyMs: 15 * 60_000, calls: false, webhooks: false, thresholds: false })
    expect(WATCHER.watches).toBe(50)
    expect(WATCHER.everyMs).toBe(60_000)
  })
  test('watcher counts until plan_until, then lapses to free', () => {
    const cfg = planConfig({})
    const paid = user({ plan: 'watcher', plan_until: new Date(now + 1000) })
    expect(isPaid(cfg, paid, now)).toBe(true)
    expect(limitsFor(cfg, paid, now)).toBe(WATCHER)
    expect(limitsFor(cfg, paid, now + 2000)).toBe(FREE)
  })
  test('ADMIN_EMAILS get Watcher free', () => {
    expect(isPaid(planConfig({ ADMIN_EMAILS: 'A@example.com, b@x.io' }), user(), now)).toBe(true)
  })
  test('30 days or a year', () => {
    expect(daysFor('month')).toBe(30)
    expect(daysFor('year')).toBe(365)
  })
})

describe('watch input', () => {
  test('an address watch; paid-only fields are dropped on free', () => {
    const b = { chain: 'eth', address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', label: 'Cold', min_usd: '500', call: '1' }
    expect(parseWatch(b, false)).toEqual({ kind: 'address', label: 'Cold', chain: 'ethereum', address: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045', min_usd: 0, call: false })
    expect(parseWatch(b, true)).toMatchObject({ min_usd: 500, call: true })
    expect(parseWatch({ ...b, address: '0x123' }, true)).toBe('That is not a Ethereum address.')
    expect(parseWatch({ ...b, chain: 'doge' }, true)).toContain('Pick a chain')
  })
  test('a price watch', () => {
    expect(parseWatch({ kind: 'price', coin: 'btc', direction: 'below', level_usd: '60000' }, false)).toEqual({ kind: 'price', label: '', coin: 'BTC', direction: 'below', level_usd: 60000, call: false })
    expect(parseWatch({ kind: 'price', coin: 'btc', direction: 'sideways', level_usd: 1 }, false)).toBe('Say above or below.')
  })
})

describe('webhooks', () => {
  test('our signature verifies with the same scheme as CoinPay', () => {
    const body = '{"event":"watch.alert"}'
    expect(verifyWebhook('whsec_x', body, signWebhook('whsec_x', body))).toBe(true)
    expect(verifyWebhook('whsec_y', body, signWebhook('whsec_x', body))).toBe(false)
  })
  test('private and local targets are refused', async () => {
    expect(privateAddress('10.1.2.3')).toBe(true)
    expect(privateAddress('172.20.0.1')).toBe(true)
    expect(privateAddress('::ffff:127.0.0.1')).toBe(true)
    expect(privateAddress('100.64.0.1')).toBe(true)
    expect(privateAddress('93.184.216.34')).toBe(false)
    const pub = async () => ['93.184.216.34']
    expect(await webhookUrlError('https://hooks.example/x', pub)).toBeNull()
    expect(await webhookUrlError('http://hooks.example/x', pub)).toBe('Use an https:// URL.')
    expect(await webhookUrlError('https://localhost/x', pub)).not.toBeNull()
    expect(await webhookUrlError('https://169.254.169.254/latest', pub)).toBe('That host points at a private address.')
    expect(await webhookUrlError('https://evil.example/x', async () => ['127.0.0.1'])).toBe('That host points at a private address.')
  })
})

describe('tui keys', () => {
  test('a acknowledges the selected watch, A all, q quits', () => {
    const s = initialState()
    expect(onKey(s, { name: 'a', key: 'a', char: 'a' })).toBeNull() // nothing loaded
    s.me = { email: '', name: '', plan: '', paid: false, limits: { watches: 3, everyMs: 0 }, watches: [{} as any, {} as any] }
    expect(onKey(s, { name: 'down', key: 'down' })).toBeNull()
    expect(s.at).toBe(1)
    expect(onKey(s, { name: 'a', key: 'a', char: 'a' })).toBe('ack')
    expect(onKey(s, { name: 'A', key: 'A', char: 'A' })).toBe('ack-all')
    expect(onKey(s, { name: 'q', key: 'q', char: 'q' })).toBe('quit')
  })
})
