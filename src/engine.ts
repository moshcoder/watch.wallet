/**
 * What counts as a move, and when a price alert fires. Pure: balances and
 * prices go in, a decision comes out, so the rules are tested without a
 * database or a network.
 *
 * An address watch compares each read with its baseline: the balances at the
 * first read, or at the last alert. Any difference is a move. With a dollar
 * threshold (paid plans) a move alerts only once the total moved since the
 * baseline is worth at least that much, so small drains still add up to an
 * alert instead of slipping under the limit one at a time.
 *
 * A price watch fires once when the price is at or past its level, then waits
 * until the price is back on the other side by REARM_BAND before it can fire
 * again. The band keeps a price sitting on the line from calling you every
 * minute.
 */
import { assetsOf, STABLES, type Chain } from './chains.js'
import type { Balances } from './sources.js'

export type Change = { asset: string; decimals: number; delta: bigint; usd: number | null }

/** Every asset whose balance differs between two reads. A missing asset counts as zero. */
export function diffBalances(chain: Chain, before: Balances, after: Balances): Change[] {
  const out: Change[] = []
  for (const a of assetsOf(chain)) {
    const delta = BigInt(after[a.symbol] ?? '0') - BigInt(before[a.symbol] ?? '0')
    if (delta !== 0n) out.push({ asset: a.symbol, decimals: a.decimals, delta, usd: null })
  }
  return out
}

/** Put a dollar value on each change: stablecoins at $1, the rest at the price given (or null if we have none). */
export function valueChanges(changes: Change[], prices: Record<string, number | null | undefined>): Change[] {
  return changes.map((c) => {
    const price = STABLES.has(c.asset) ? 1 : prices[c.asset]
    return { ...c, usd: price == null ? null : toNumber(c.delta, c.decimals) * price }
  })
}

/**
 * Should these changes alert? With no threshold, any change does. With one,
 * the total absolute dollar value must reach it. A change we could not value
 * (no price) alerts anyway: better a call too many than a missed drain.
 */
export function shouldAlert(changes: Change[], minUsd: number): boolean {
  if (!changes.length) return false
  if (!(minUsd > 0)) return true
  if (changes.some((c) => c.usd === null)) return true
  return changes.reduce((sum, c) => sum + Math.abs(c.usd!), 0) >= minUsd
}

export const REARM_BAND = 0.005

export type PriceRule = { direction: 'above' | 'below'; level: number; armed: boolean }

/** Fire when armed and the price is at or past the level; re-arm once it is back across by the band. */
export function decidePrice(rule: PriceRule, price: number): { fire: boolean; armed: boolean } {
  const past = rule.direction === 'above' ? price >= rule.level : price <= rule.level
  if (rule.armed) return past ? { fire: true, armed: false } : { fire: false, armed: true }
  const back = rule.direction === 'above' ? price < rule.level * (1 - REARM_BAND) : price > rule.level * (1 + REARM_BAND)
  return { fire: false, armed: back }
}

// ---- numbers for people ----------------------------------------------------------

export function toNumber(v: bigint, decimals: number): number {
  return Number(v) / 10 ** decimals
}

/** 1234500000000000000n with 18 decimals is "1.2345". At most `maxFrac` decimals, trailing zeros dropped. */
export function formatUnits(v: bigint, decimals: number, maxFrac = 6): string {
  const neg = v < 0n
  const abs = neg ? -v : v
  const base = 10n ** BigInt(decimals)
  const whole = abs / base
  let frac = (abs % base).toString().padStart(decimals, '0').slice(0, Math.min(maxFrac, decimals)).replace(/0+$/, '')
  // Something too small to show at maxFrac is still not nothing.
  if (whole === 0n && !frac && abs > 0n) frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${neg ? '-' : ''}${w}${frac ? `.${frac}` : ''}`
}

export function usd(n: number): string {
  const abs = Math.abs(n)
  const digits = abs >= 100 ? 0 : abs >= 1 ? 2 : 4
  return `${n < 0 ? '-' : ''}$${abs.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

/** "0.5 ETH out (~$1,222), 100 USDC in" */
export function describeChanges(changes: Change[]): string {
  return changes
    .map((c) => `${formatUnits(c.delta < 0n ? -c.delta : c.delta, c.decimals)} ${c.asset} ${c.delta < 0n ? 'out' : 'in'}${c.usd !== null && !STABLES.has(c.asset) ? ` (~${usd(Math.abs(c.usd))})` : ''}`)
    .join(', ')
}

/** The same, for a voice on the phone: no symbols it would read out oddly. */
export function speakChanges(changes: Change[]): string {
  return changes.map((c) => `${formatUnits(c.delta < 0n ? -c.delta : c.delta, c.decimals, 4).replace(/,/g, '')} ${c.asset.split('').join(' ')} ${c.delta < 0n ? 'out' : 'in'}`).join(', and ')
}

/** Balances for display: "0.5 ETH · 100 USDC", skipping zero tokens (but always the native coin). */
export function describeBalances(chain: Chain, b: Balances | null): string {
  if (!b) return 'not read yet'
  return assetsOf(chain)
    .map((a, i) => ({ a, v: BigInt(b[a.symbol] ?? '0'), i }))
    .filter((x) => x.i === 0 || x.v !== 0n)
    .map((x) => `${formatUnits(x.v, x.a.decimals)} ${x.a.symbol}`)
    .join(' · ')
}
