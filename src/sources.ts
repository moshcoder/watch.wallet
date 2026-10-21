/**
 * Where balances and prices come from. All public, none needs an API key:
 *
 *   Bitcoin   mempool.space /api/address/:addr (confirmed + mempool sums)
 *   EVM       public JSON-RPC: eth_getBalance, and eth_call balanceOf per token
 *   Solana    public JSON-RPC: getBalance, getTokenAccountsByOwner per mint
 *   Prices    Coinbase /v2/prices/<COIN>-USD/spot
 *
 * Every adapter takes the fetch it should use, so tests hand it a fake. A
 * read either returns every asset for the address or throws: a half read is
 * a failed read, and the worker never alerts on a failed read.
 *
 * Public RPC nodes rate-limit and sometimes refuse whole IP ranges, so each
 * chain has a list of URLs, tried in order. WATCHWALLET_RPC_<CHAIN> (comma
 * separated) replaces the list; MEMPOOL_URL and COINBASE_URL move the others.
 */
import { CHAIN_INFO, type Chain, type EvmChain } from './chains.js'

export type Fetch = typeof fetch
/** Base units per asset symbol, as decimal strings (bigints do not fit in JSON). */
export type Balances = Record<string, string>
export type Reading = { balances: Balances; pending: boolean }

export class SourceError extends Error {}

export type SourceConfig = {
  fetch: Fetch
  rpc: Record<EvmChain | 'solana', string[]>
  mempool: string
  coinbase: string
  timeoutMs: number
}

export const DEFAULT_RPC: Record<EvmChain | 'solana', string[]> = {
  ethereum: ['https://ethereum-rpc.publicnode.com', 'https://1rpc.io/eth'],
  base: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'],
  polygon: ['https://polygon-bor-rpc.publicnode.com', 'https://1rpc.io/matic'],
  solana: ['https://api.mainnet-beta.solana.com'],
}

export function sourceConfig(env: Record<string, string | undefined> = process.env, fetcher: Fetch = fetch): SourceConfig {
  const list = (name: string, fallback: string[]) => {
    const v = (env[`WATCHWALLET_RPC_${name.toUpperCase()}`] ?? '').split(',').map((s) => s.trim()).filter((s) => /^https?:\/\//.test(s))
    return v.length ? v : fallback
  }
  return {
    fetch: fetcher,
    rpc: { ethereum: list('ethereum', DEFAULT_RPC.ethereum), base: list('base', DEFAULT_RPC.base), polygon: list('polygon', DEFAULT_RPC.polygon), solana: list('solana', DEFAULT_RPC.solana) },
    mempool: (env.MEMPOOL_URL ?? 'https://mempool.space').replace(/\/+$/, ''),
    coinbase: (env.COINBASE_URL ?? 'https://api.coinbase.com').replace(/\/+$/, ''),
    timeoutMs: Number(env.SOURCE_TIMEOUT_MS ?? 10_000),
  }
}

async function getJson(cfg: SourceConfig, url: string, init?: RequestInit): Promise<any> {
  let res: Response
  try {
    res = await cfg.fetch(url, { ...init, headers: { accept: 'application/json', 'user-agent': 'watch.wallet (+https://watch.wallet.pit.world)', ...(init?.headers as Record<string, string>) }, signal: AbortSignal.timeout(cfg.timeoutMs) })
  } catch (e) {
    throw new SourceError(`${new URL(url).host}: ${e instanceof Error ? e.message : e}`)
  }
  const text = await res.text().catch(() => '')
  if (!res.ok) throw new SourceError(`${new URL(url).host} answered ${res.status}`)
  try {
    return JSON.parse(text)
  } catch {
    throw new SourceError(`${new URL(url).host} sent something that is not JSON`)
  }
}

/** One JSON-RPC call, trying each URL until one answers with a result. */
export async function rpcCall(cfg: SourceConfig, urls: string[], method: string, params: unknown[]): Promise<unknown> {
  let last: Error = new SourceError('no RPC URL configured')
  for (const url of urls) {
    try {
      const body = await getJson(cfg, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
      if (body?.error) throw new SourceError(`${new URL(url).host}: ${String(body.error.message ?? 'rpc error').slice(0, 120)}`)
      if (body?.result === undefined) throw new SourceError(`${new URL(url).host}: no result`)
      return body.result
    } catch (e) {
      last = e instanceof Error ? e : new SourceError(String(e))
    }
  }
  throw last
}

// Not Number.isSafeInteger: an exchange hot wallet holds more than 2^53 lamports, which
// JSON.parse rounds to the nearest double. That is still a whole number, the same
// one every read, so change detection stays exact to within a few lamports.
const isUint = (v: unknown): v is string | number => (typeof v === 'string' && /^\d+$/.test(v)) || (typeof v === 'number' && Number.isInteger(v) && v >= 0)

/** Bitcoin: confirmed funded minus spent, plus the same for the mempool. A mempool tx moves the balance at once. */
export async function readBitcoin(cfg: SourceConfig, address: string): Promise<Reading> {
  const body = await getJson(cfg, `${cfg.mempool}/api/address/${encodeURIComponent(address)}`)
  const c = body?.chain_stats
  const m = body?.mempool_stats
  if (![c?.funded_txo_sum, c?.spent_txo_sum, m?.funded_txo_sum, m?.spent_txo_sum].every(isUint)) throw new SourceError('mempool.space: unexpected answer')
  const sats = BigInt(c.funded_txo_sum) - BigInt(c.spent_txo_sum) + BigInt(m.funded_txo_sum) - BigInt(m.spent_txo_sum)
  return { balances: { BTC: sats.toString() }, pending: Number(m.tx_count ?? 0) > 0 }
}

const hexToBig = (v: unknown, what: string): bigint => {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(v)) throw new SourceError(`${what}: unexpected answer`)
  return BigInt(v)
}

/** EVM: the native balance and balanceOf(address) on each token contract. */
export async function readEvm(cfg: SourceConfig, chain: EvmChain, address: string): Promise<Reading> {
  const info = CHAIN_INFO[chain]
  const urls = cfg.rpc[chain]
  const pad = address.toLowerCase().replace(/^0x/, '').padStart(64, '0')
  const [native, ...tokens] = await Promise.all([
    rpcCall(cfg, urls, 'eth_getBalance', [address, 'latest']).then((r) => hexToBig(r, `${chain} balance`)),
    ...info.tokens.map((t) => rpcCall(cfg, urls, 'eth_call', [{ to: t.address, data: `0x70a08231${pad}` }, 'latest']).then((r) => hexToBig(r, `${chain} ${t.symbol}`))),
  ])
  const balances: Balances = { [info.native]: native!.toString() }
  info.tokens.forEach((t, i) => (balances[t.symbol] = tokens[i]!.toString()))
  return { balances, pending: false }
}

/** Solana: lamports, and the summed token accounts the address owns for each mint. */
export async function readSolana(cfg: SourceConfig, address: string): Promise<Reading> {
  const info = CHAIN_INFO.solana
  const urls = cfg.rpc.solana
  const [lamports, ...tokens] = await Promise.all([
    rpcCall(cfg, urls, 'getBalance', [address, { commitment: 'confirmed' }]).then((r: any) => {
      if (!isUint(r?.value)) throw new SourceError('solana balance: unexpected answer')
      return BigInt(r.value)
    }),
    ...info.tokens.map((t) =>
      rpcCall(cfg, urls, 'getTokenAccountsByOwner', [address, { mint: t.address }, { encoding: 'jsonParsed', commitment: 'confirmed' }]).then((r: any) => {
        if (!Array.isArray(r?.value)) throw new SourceError(`solana ${t.symbol}: unexpected answer`)
        let sum = 0n
        for (const acct of r.value) {
          const amount = acct?.account?.data?.parsed?.info?.tokenAmount?.amount
          if (!isUint(amount)) throw new SourceError(`solana ${t.symbol}: unexpected token account`)
          sum += BigInt(amount)
        }
        return sum
      }),
    ),
  ])
  const balances: Balances = { SOL: lamports!.toString() }
  info.tokens.forEach((t, i) => (balances[t.symbol] = tokens[i]!.toString()))
  return { balances, pending: false }
}

export function readAddress(cfg: SourceConfig, chain: Chain, address: string): Promise<Reading> {
  if (chain === 'bitcoin') return readBitcoin(cfg, address)
  if (chain === 'solana') return readSolana(cfg, address)
  return readEvm(cfg, chain, address)
}

/** Coinbase spot price in USD. Throws for a coin Coinbase does not list. */
export async function spotPrice(cfg: SourceConfig, coin: string): Promise<number> {
  const body = await getJson(cfg, `${cfg.coinbase}/v2/prices/${encodeURIComponent(coin)}-USD/spot`)
  const n = Number(body?.data?.amount)
  if (!Number.isFinite(n) || n <= 0) throw new SourceError(`coinbase: no price for ${coin}`)
  return n
}

/** Which source a read uses, for backing off one that is failing without stopping the rest. */
export const sourceKey = (chain: Chain | null, coin?: string) => (chain ? `chain:${chain}` : `price:${coin ?? ''}`)

/**
 * Back off a failing source: after n failures in a row, skip it for
 * 1, 2, 4 … minutes, at most 30. One success resets it.
 */
export class Backoff {
  private state = new Map<string, { n: number; until: number }>()
  constructor(private readonly baseMs = 60_000, private readonly maxMs = 30 * 60_000) {}
  ready(key: string, now = Date.now()): boolean {
    return (this.state.get(key)?.until ?? 0) <= now
  }
  fail(key: string, now = Date.now()): number {
    const n = (this.state.get(key)?.n ?? 0) + 1
    const wait = Math.min(this.maxMs, this.baseMs * 2 ** (n - 1))
    this.state.set(key, { n, until: now + wait })
    return wait
  }
  ok(key: string): void {
    this.state.delete(key)
  }
  failures(key: string): number {
    return this.state.get(key)?.n ?? 0
  }
}

/** Prices for one worker pass: each coin is fetched once, a failure is remembered for the pass. */
export function priceCache(cfg: SourceConfig): (coin: string) => Promise<number | null> {
  const seen = new Map<string, Promise<number | null>>()
  return (coin) => {
    let p = seen.get(coin)
    if (!p) {
      p = spotPrice(cfg, coin).catch(() => null)
      seen.set(coin, p)
    }
    return p
  }
}
