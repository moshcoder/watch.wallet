/**
 * Plans, limits and paying for them. Money goes through CoinPay, crypto only:
 * write the payment down as pending before the buyer leaves, verify the
 * webhook over the raw bytes, and only a settled status grants.
 *
 * Watcher is one-time payments that extend `plan_until` (30 days or a year).
 * A lapsed plan never deletes anything: watches keep running at the free
 * cadence on free channels, and any beyond the free three are paused (not
 * removed) until the plan is back.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Store, User } from './db.js'

export type Limits = { watches: number; everyMs: number; calls: boolean; webhooks: boolean; thresholds: boolean }
export const FREE: Limits = { watches: 3, everyMs: 15 * 60_000, calls: false, webhooks: false, thresholds: false }
export const WATCHER: Limits = { watches: 50, everyMs: 60_000, calls: true, webhooks: true, thresholds: true }

export type Product = 'month' | 'year'
export const PRODUCTS: Record<Product, { label: string; cents: number; days: number }> = {
  month: { label: 'Watcher, 30 days', cents: Math.round(Number(process.env.PRICE_MONTH_USD ?? 5) * 100), days: 30 },
  year: { label: 'Watcher, one year', cents: Math.round(Number(process.env.PRICE_YEAR_USD ?? 39) * 100), days: 365 },
}
export const daysFor = (product: string) => PRODUCTS[product as Product]?.days ?? 30

export type CoinPay = { baseUrl: string; apiKey: string; businessId: string; webhookSecret: string }
export type PlanConfig = { coinpay: CoinPay | null; chains: string[]; admins: Set<string> }

export const DEFAULT_CHAINS = ['USDC_SOL', 'USDC_POL', 'USDC_ETH', 'USDT_POL', 'BTC', 'ETH', 'SOL', 'POL', 'DOGE', 'BCH', 'XRP', 'ADA', 'BNB']
export const CHAIN_LABELS: Record<string, string> = {
  USDC_POL: 'USDC on Polygon', USDC_SOL: 'USDC on Solana', USDC_ETH: 'USDC on Ethereum', USDT_POL: 'USDT on Polygon',
  BTC: 'Bitcoin', ETH: 'Ether', SOL: 'Solana', POL: 'Polygon', DOGE: 'Dogecoin', BCH: 'Bitcoin Cash', XRP: 'XRP', ADA: 'Cardano', BNB: 'BNB',
}

export function planConfig(env: Record<string, string | undefined> = process.env): PlanConfig {
  const chains = (env.COINPAY_CHAINS ?? '').split(/[\s,]+/).filter(Boolean)
  return {
    coinpay:
      env.COINPAY_API_KEY && env.COINPAY_BUSINESS_ID
        ? {
            baseUrl: (env.COINPAY_API_URL ?? 'https://coinpayportal.com').replace(/\/+$/, '').replace(/\/api$/, ''),
            apiKey: env.COINPAY_API_KEY,
            businessId: env.COINPAY_BUSINESS_ID,
            webhookSecret: env.COINPAY_WEBHOOK_SECRET ?? '',
          }
        : null,
    chains: chains.length ? chains : DEFAULT_CHAINS,
    admins: new Set((env.ADMIN_EMAILS ?? '').split(/[\s,]+/).map((e) => e.trim().toLowerCase()).filter(Boolean)),
  }
}

export function isPaid(cfg: PlanConfig, user: Pick<User, 'email' | 'plan' | 'plan_until'>, now = Date.now()): boolean {
  if (cfg.admins.has(user.email)) return true
  return user.plan === 'watcher' && Boolean(user.plan_until && user.plan_until.getTime() > now)
}

export const limitsFor = (cfg: PlanConfig, user: Pick<User, 'email' | 'plan' | 'plan_until'>, now = Date.now()) => (isPaid(cfg, user, now) ? WATCHER : FREE)

export function planLabel(cfg: PlanConfig, user: User, now = Date.now()): string {
  if (cfg.admins.has(user.email)) return 'Watcher (admin)'
  if (isPaid(cfg, user, now)) return `Watcher, until ${user.plan_until!.toISOString().slice(0, 10)}`
  return 'Free'
}

export const dollars = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`

/** Start a crypto payment; returns CoinPay's checkout page. */
export async function startCheckout(
  cfg: PlanConfig,
  store: Store,
  args: { user: User; product: Product; chain: string; successUrl: string; cancelUrl: string },
  fetcher: typeof fetch = fetch,
): Promise<{ checkoutUrl: string; ref: string }> {
  if (!cfg.coinpay) throw new Error('payments are not set up on this server yet')
  if (!cfg.chains.includes(args.chain)) throw new Error('pick a currency from the list')
  const product = PRODUCTS[args.product]
  if (!product) throw new Error('pick a plan')
  const res = await fetcher(`${cfg.coinpay.baseUrl}/api/payments/create`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.coinpay.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      business_id: cfg.coinpay.businessId,
      amount: product.cents / 100,
      currency: 'USD',
      blockchain: args.chain,
      payment_method: 'crypto',
      description: `watch.wallet ${product.label}`,
      metadata: { user_id: args.user.id, product: args.product },
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
    }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`CoinPay said ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as any
  // { success, payment: {...} }: the id is nested, not body.id.
  const payment = body?.payment ?? body
  const ref = payment?.id ?? payment?.payment_id
  if (!ref) throw new Error('CoinPay returned no payment reference')
  // Written before the buyer leaves: a webhook can beat the redirect.
  await store.recordPayment({ ref: String(ref), user_id: args.user.id, product: args.product, amount_cents: product.cents, chain: args.chain, raw: body })
  return { checkoutUrl: `${cfg.coinpay.baseUrl}/pay/${ref}`, ref: String(ref) }
}

/** `t=<unix>,v1=<hex hmac of "t.rawBody">`, within five minutes. Same scheme we use to sign our own webhooks. */
export function verifyWebhook(secret: string, rawBody: string, header: string | null | undefined, nowSeconds = Date.now() / 1000): boolean {
  if (!secret || !header) return false
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=').map((s) => s.trim())))
  const t = Number(parts.t)
  if (!Number.isFinite(t) || !parts.v1 || Math.abs(nowSeconds - t) > 300) return false
  const expected = Buffer.from(createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex'), 'hex')
  const given = Buffer.from(String(parts.v1), 'hex')
  return expected.length === given.length && timingSafeEqual(expected, given)
}

export const SETTLED = new Set(['paid', 'completed', 'confirmed', 'forwarded', 'succeeded', 'settled'])

/** The live webhook is { id: "evt_…", type, data: { payment_id, status, metadata } }; the top-level id is the event. */
export function readWebhook(payload: any): { ref: string | null; status: string } {
  const data = payload?.data ?? payload
  return { ref: data?.payment_id ?? data?.id ?? null, status: String(data?.status ?? '').toLowerCase() }
}
