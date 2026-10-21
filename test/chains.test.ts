import { describe, expect, test } from 'bun:test'
import { assetsOf, normalizeAddress, normalizeCoin, parseChain } from '../src/chains.ts'

describe('address checks', () => {
  test('bitcoin: legacy, P2SH, SegWit and Taproot, with checksums', () => {
    expect(normalizeAddress('bitcoin', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')
    expect(normalizeAddress('bitcoin', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).toBe('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')
    expect(normalizeAddress('bitcoin', 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh')).toBe('bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh')
    // BIP 173 test vector, upper case is fine and stored lower.
    expect(normalizeAddress('bitcoin', 'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4')).toBe('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')
    // Taproot (BIP 86) and a BIP 350 (bech32m) test vector.
    expect(normalizeAddress('bitcoin', 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr')).not.toBeNull()
    expect(normalizeAddress('bitcoin', 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcs')).toBeNull()
    expect(normalizeAddress('bitcoin', 'bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y')).not.toBeNull()
  })
  test('bitcoin: typos and wrong networks are refused', () => {
    expect(normalizeAddress('bitcoin', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb')).toBeNull() // checksum
    expect(normalizeAddress('bitcoin', 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlj')).toBeNull() // checksum
    expect(normalizeAddress('bitcoin', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')).toBeNull() // testnet
    expect(normalizeAddress('bitcoin', 'bc1qW508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toBeNull() // mixed case
    expect(normalizeAddress('bitcoin', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')).toBeNull()
  })
  test('EVM: 0x and 40 hex, stored lowercase, the zero address refused', () => {
    for (const chain of ['ethereum', 'base', 'polygon'] as const) {
      expect(normalizeAddress(chain, ' 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 ')).toBe('0xd8da6bf26964af9d7eed9e03e53415d37aa96045')
      expect(normalizeAddress(chain, '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA9604')).toBeNull()
      expect(normalizeAddress(chain, '0x' + '0'.repeat(40))).toBeNull()
      expect(normalizeAddress(chain, 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg')).toBeNull()
    }
  })
  test('solana: base58 that decodes to 32 bytes', () => {
    expect(normalizeAddress('solana', 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg')).toBe('vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg')
    expect(normalizeAddress('solana', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).not.toBeNull()
    expect(normalizeAddress('solana', 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPT0')).toBeNull() // 0 is not base58
    expect(normalizeAddress('solana', '1111111111111111111111111111111111')).toBeNull() // too short decoded
    expect(normalizeAddress('solana', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')).toBeNull()
  })
  test('chains and coins by their everyday names', () => {
    expect(parseChain('BTC')).toBe('bitcoin')
    expect(parseChain('matic')).toBe('polygon')
    expect(parseChain('sol')).toBe('solana')
    expect(parseChain('dogecoin')).toBeNull()
    expect(normalizeCoin('btc-usd')).toBe('BTC')
    expect(normalizeCoin('$$$')).toBeNull()
  })
  test('each chain reads its native coin and USDC/USDT (Bitcoin only BTC)', () => {
    expect(assetsOf('bitcoin').map((a) => a.symbol)).toEqual(['BTC'])
    expect(assetsOf('polygon').map((a) => a.symbol)).toEqual(['POL', 'USDC', 'USDT'])
    expect(assetsOf('solana').map((a) => a.decimals)).toEqual([9, 6, 6])
  })
})
