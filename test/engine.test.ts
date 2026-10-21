import { describe, expect, test } from 'bun:test'
import { decidePrice, describeBalances, describeChanges, diffBalances, formatUnits, shouldAlert, speakChanges, valueChanges } from '../src/engine.ts'

const ETH = 10n ** 18n

describe('change detection', () => {
  test('no change, no moves', () => {
    expect(diffBalances('ethereum', { ETH: '1', USDC: '2', USDT: '0' }, { ETH: '1', USDC: '2', USDT: '0' })).toEqual([])
  })
  test('each asset that moved, with a signed delta; missing counts as zero', () => {
    const d = diffBalances('ethereum', { ETH: (2n * ETH).toString(), USDC: '0' }, { ETH: (ETH + ETH / 2n).toString(), USDC: '100000000', USDT: '0' })
    expect(d.map((c) => [c.asset, c.delta])).toEqual([
      ['ETH', -(ETH / 2n)],
      ['USDC', 100_000_000n],
    ])
  })
  test('dollar values: stables at $1, native at the price, unknown as null', () => {
    const d = diffBalances('ethereum', { ETH: (2n * ETH).toString(), USDC: '0' }, { ETH: (ETH + ETH / 2n).toString(), USDC: '100000000' })
    const v = valueChanges(d, { ETH: 2000 })
    expect(v.map((c) => c.usd)).toEqual([-1000, 100])
    expect(valueChanges(d, {})[0]!.usd).toBeNull()
    expect(describeChanges(v)).toBe('0.5 ETH out (~$1,000), 100 USDC in')
    expect(speakChanges(v)).toBe('0.5 E T H out, and 100 U S D C in')
  })
  test('threshold: any move without one, the total with one, unvalued moves always', () => {
    const small = valueChanges(diffBalances('base', { USDC: '0' }, { USDC: '90000000' }), {})
    expect(shouldAlert(small, 0)).toBe(true)
    expect(shouldAlert(small, 100)).toBe(false)
    expect(shouldAlert(small, 90)).toBe(true)
    const both = valueChanges(diffBalances('base', { USDC: '0', USDT: '0' }, { USDC: '60000000', USDT: '50000000' }), {})
    expect(shouldAlert(both, 100)).toBe(true)
    const unvalued = valueChanges(diffBalances('base', { ETH: '0' }, { ETH: '1' }), {})
    expect(shouldAlert(unvalued, 1_000_000)).toBe(true)
    expect(shouldAlert([], 0)).toBe(false)
  })
})

describe('price crossing', () => {
  const below = { direction: 'below' as const, level: 60_000, armed: true }
  const above = { direction: 'above' as const, level: 100_000, armed: true }
  test('fires once when the level is reached, then stays quiet', () => {
    expect(decidePrice(below, 61_000)).toEqual({ fire: false, armed: true })
    expect(decidePrice(below, 60_000)).toEqual({ fire: true, armed: false })
    expect(decidePrice({ ...below, armed: false }, 55_000)).toEqual({ fire: false, armed: false })
    expect(decidePrice(above, 100_500)).toEqual({ fire: true, armed: false })
  })
  test('re-arms only once back across the level by the band', () => {
    const fired = { ...below, armed: false }
    expect(decidePrice(fired, 60_100).armed).toBe(false) // inside the 0.5% band
    expect(decidePrice(fired, 60_301).armed).toBe(true)
    const up = { ...above, armed: false }
    expect(decidePrice(up, 99_800).armed).toBe(false)
    expect(decidePrice(up, 99_400).armed).toBe(true)
    // ...and the next crossing fires again.
    expect(decidePrice({ ...up, armed: true }, 100_000).fire).toBe(true)
  })
})

describe('formatting', () => {
  test('formatUnits', () => {
    expect(formatUnits(1_234_500_000_000_000_000n, 18)).toBe('1.2345')
    expect(formatUnits(-50_000_000n, 8)).toBe('-0.5')
    expect(formatUnits(1_000_000_000_000n, 6)).toBe('1,000,000')
    expect(formatUnits(1n, 18)).toBe('0.000000000000000001')
    expect(formatUnits(0n, 9)).toBe('0')
  })
  test('balances skip zero tokens but always show the native coin', () => {
    expect(describeBalances('solana', { SOL: '0', USDC: '2500000', USDT: '0' })).toBe('0 SOL · 2.5 USDC')
    expect(describeBalances('bitcoin', null)).toBe('not read yet')
  })
})
