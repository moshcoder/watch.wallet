/**
 * The chains we watch, the tokens we read on each, and how we tell a real
 * address from a typo. One table, so adding a token is one line.
 *
 * Token contracts were checked on chain (symbol() and decimals()) on
 * 2026-10-21. On Polygon, 0xc2132D05... now reports its symbol as USDT0
 * (Tether's upgraded contract); it is still the USDT people hold.
 */
import { createHash } from 'node:crypto'

export type Chain = 'bitcoin' | 'ethereum' | 'base' | 'polygon' | 'solana'
export type EvmChain = 'ethereum' | 'base' | 'polygon'
export const CHAINS: readonly Chain[] = ['bitcoin', 'ethereum', 'base', 'polygon', 'solana']
export const EVM_CHAINS: readonly EvmChain[] = ['ethereum', 'base', 'polygon']

export type Token = { symbol: string; address: string; decimals: number }
export type ChainInfo = { label: string; native: string; decimals: number; tokens: Token[]; explorer: (address: string) => string }

export const CHAIN_INFO: Record<Chain, ChainInfo> = {
  bitcoin: { label: 'Bitcoin', native: 'BTC', decimals: 8, tokens: [], explorer: (a) => `https://mempool.space/address/${a}` },
  ethereum: {
    label: 'Ethereum',
    native: 'ETH',
    decimals: 18,
    tokens: [
      { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
      { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
    ],
    explorer: (a) => `https://etherscan.io/address/${a}`,
  },
  base: {
    label: 'Base',
    native: 'ETH',
    decimals: 18,
    tokens: [
      { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
      { symbol: 'USDT', address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6 },
    ],
    explorer: (a) => `https://basescan.org/address/${a}`,
  },
  polygon: {
    label: 'Polygon',
    native: 'POL',
    decimals: 18,
    tokens: [
      { symbol: 'USDC', address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
      { symbol: 'USDT', address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 },
    ],
    explorer: (a) => `https://polygonscan.com/address/${a}`,
  },
  solana: {
    label: 'Solana',
    native: 'SOL',
    decimals: 9,
    tokens: [
      { symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
      { symbol: 'USDT', address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6 },
    ],
    explorer: (a) => `https://solscan.io/account/${a}`,
  },
}

/** Stablecoins count as one dollar each when we put a USD value on a move. */
export const STABLES = new Set(['USDC', 'USDT'])

/** Every asset we read for a chain: the native coin first, then its tokens. */
export function assetsOf(chain: Chain): { symbol: string; decimals: number }[] {
  const c = CHAIN_INFO[chain]
  return [{ symbol: c.native, decimals: c.decimals }, ...c.tokens.map((t) => ({ symbol: t.symbol, decimals: t.decimals }))]
}

/** "btc", "eth", "matic" and friends, to a chain we know; null if not. */
export function parseChain(input: unknown): Chain | null {
  const s = String(input ?? '').trim().toLowerCase()
  const alias: Record<string, Chain> = { btc: 'bitcoin', bitcoin: 'bitcoin', eth: 'ethereum', ethereum: 'ethereum', mainnet: 'ethereum', base: 'base', polygon: 'polygon', pol: 'polygon', matic: 'polygon', sol: 'solana', solana: 'solana' }
  return alias[s] ?? null
}

// ---- address checks -----------------------------------------------------------

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export function base58Decode(s: string): Uint8Array | null {
  if (!s || s.length > 128) return null
  let n = 0n
  for (const ch of s) {
    const v = B58.indexOf(ch)
    if (v < 0) return null
    n = n * 58n + BigInt(v)
  }
  const bytes: number[] = []
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn))
    n >>= 8n
  }
  for (const ch of s) {
    if (ch !== '1') break
    bytes.unshift(0)
  }
  return Uint8Array.from(bytes)
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest()

/** Legacy (1…) and P2SH (3…) Bitcoin addresses: base58 with a double-SHA256 checksum. */
function base58checkBtc(s: string): boolean {
  const b = base58Decode(s)
  if (!b || b.length !== 25 || (b[0] !== 0x00 && b[0] !== 0x05)) return false
  const sum = sha256(sha256(b.subarray(0, 21)))
  return sum.subarray(0, 4).equals(Buffer.from(b.subarray(21)))
}

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
function polymod(values: number[]): number {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let chk = 1
  for (const v of values) {
    const top = chk >>> 25
    chk = (((chk & 0x1ffffff) << 5) ^ v) >>> 0
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk = (chk ^ G[i]!) >>> 0
  }
  return chk
}

/** SegWit (bc1q…, BIP 173) and Taproot (bc1p…, BIP 350) addresses. */
function segwitBtc(s: string): boolean {
  if (s.length < 14 || s.length > 90 || (s !== s.toLowerCase() && s !== s.toUpperCase())) return false
  const a = s.toLowerCase()
  const sep = a.lastIndexOf('1')
  if (a.slice(0, sep) !== 'bc') return false
  const data: number[] = []
  for (const ch of a.slice(sep + 1)) {
    const v = BECH32.indexOf(ch)
    if (v < 0) return false
    data.push(v)
  }
  if (data.length < 7) return false
  const hrp = [...'bc'].map((c) => c.charCodeAt(0) >> 5).concat([0], [...'bc'].map((c) => c.charCodeAt(0) & 31))
  const check = polymod(hrp.concat(data))
  const version = data[0]!
  if (version > 16) return false
  if (check !== (version === 0 ? 1 : 0x2bc830a3)) return false
  // 5-bit groups back to bytes: the witness program.
  let acc = 0
  let bits = 0
  const prog: number[] = []
  for (const v of data.slice(1, -6)) {
    acc = (acc << 5) | v
    bits += 5
    while (bits >= 8) {
      bits -= 8
      prog.push((acc >> bits) & 0xff)
    }
  }
  if (bits >= 5 || (acc & ((1 << bits) - 1)) !== 0) return false
  if (prog.length < 2 || prog.length > 40) return false
  return version !== 0 || prog.length === 20 || prog.length === 32
}

/**
 * The address in the form we store, or null if it is not one for this chain.
 * EVM addresses are stored lowercase: we do not check the EIP-55 mixed-case
 * checksum (it needs keccak, which Node does not ship), only the shape.
 */
export function normalizeAddress(chain: Chain, input: unknown): string | null {
  const s = String(input ?? '').trim()
  switch (chain) {
    case 'bitcoin':
      if (/^bc1/i.test(s)) return segwitBtc(s) ? s.toLowerCase() : null
      return /^[13]/.test(s) && base58checkBtc(s) ? s : null
    case 'ethereum':
    case 'base':
    case 'polygon':
      return /^0x[0-9a-fA-F]{40}$/.test(s) && !/^0x0{40}$/.test(s) ? s.toLowerCase() : null
    case 'solana': {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return null
      return base58Decode(s)?.length === 32 ? s : null
    }
  }
}

export const shortAddress = (a: string) => (a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a)

/** Price watches: a Coinbase ticker, like BTC or ETH. */
export function normalizeCoin(input: unknown): string | null {
  const s = String(input ?? '').trim().toUpperCase().replace(/-USD$/, '')
  return /^[A-Z0-9]{2,10}$/.test(s) ? s : null
}
