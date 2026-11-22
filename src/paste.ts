/**
 * Bulk paste of wallet addresses in CoinPay's "Copy All Addresses" format
 * (coinpayportal.com: Settings > Global Wallets, a business's Wallets tab, or
 * the web wallet). One wallet per line:
 *
 *   BTC: bc1q...
 *   USDC_ETH (Treasury): 0x...      <- "Include all fields" adds the label
 *
 * Each CoinPay symbol maps to the chain it lives on. One watch already covers
 * the native coin plus USDC/USDT on an address, so ETH and USDC_ETH with the
 * same address become a single watch. Symbols on chains we do not read (BCH,
 * TRON, BNB, XRP, ADA, DOGE) are reported, not guessed at.
 */
import { normalizeAddress, type Chain } from './chains.js'

/** CoinPay symbol -> our chain (null: CoinPay has it, we cannot read it). Bare USDT/USDC are CoinPay's Ethereum tokens. */
export const COINPAY_SYMBOLS: Record<string, Chain | null> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  USDT: 'ethereum',
  USDT_ETH: 'ethereum',
  USDC: 'ethereum',
  USDC_ETH: 'ethereum',
  POL: 'polygon',
  USDT_POL: 'polygon',
  USDC_POL: 'polygon',
  SOL: 'solana',
  USDT_SOL: 'solana',
  USDC_SOL: 'solana',
  USDC_BASE: 'base',
  BCH: null,
  USDT_TRON: null,
  BNB: null,
  XRP: null,
  ADA: null,
  DOGE: null,
}

export type PastedWatch = { chain: Chain; address: string; label: string; symbols: string[] }
export type PasteResult = {
  watches: PastedWatch[]
  /** Symbols we cannot watch (other chains), or that nobody knows. */
  unsupported: string[]
  /** Lines that are not "SYMBOL: address", or whose address is wrong for its chain. */
  invalid: string[]
}

// "USDC_ETH (Treasury): 0xabc" -> symbol, optional label, address. A label may itself hold parentheses.
const LINE = /^([A-Za-z][A-Za-z0-9_]*)\s*(?:\((.*)\))?\s*:\s*(\S+)$/

const autoLabel = (symbols: string[]) => `CoinPay ${symbols.join(', ')}`.slice(0, 60)

export function parseCoinpayPaste(text: unknown): PasteResult {
  const byKey = new Map<string, PastedWatch & { named: boolean }>()
  const unsupported = new Set<string>()
  const invalid: string[] = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const m = LINE.exec(line)
    if (!m) {
      invalid.push(line)
      continue
    }
    const symbol = m[1]!.toUpperCase()
    const chain = COINPAY_SYMBOLS[symbol]
    if (!chain) {
      unsupported.add(symbol)
      continue
    }
    const address = normalizeAddress(chain, m[3])
    if (!address) {
      invalid.push(line)
      continue
    }
    const name = (m[2] ?? '').trim().slice(0, 60)
    const key = `${chain}:${address}`
    const prev = byKey.get(key)
    if (prev) {
      if (!prev.symbols.includes(symbol)) prev.symbols.push(symbol)
      if (!prev.named) {
        prev.named = Boolean(name)
        prev.label = name || autoLabel(prev.symbols)
      }
      continue
    }
    byKey.set(key, { chain, address, label: name || autoLabel([symbol]), symbols: [symbol], named: Boolean(name) })
  }
  return { watches: [...byKey.values()].map(({ named: _, ...w }) => w), unsupported: [...unsupported], invalid }
}
