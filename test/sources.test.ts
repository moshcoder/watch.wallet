import { describe, expect, test } from 'bun:test'
import { Backoff, priceCache, readAddress, sourceConfig, spotPrice, SourceError } from '../src/sources.ts'

type Call = { url: string; body: any }

/** A fake network: `route` answers each request; every request is recorded. */
function fakeNet(route: (url: string, body: any) => Response | Promise<Response>) {
  const calls: Call[] = []
  const f = (async (input: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url: String(input), body })
    return route(String(input), body)
  }) as unknown as typeof fetch
  return { calls, f }
}
const rpc = (result: unknown) => Response.json({ jsonrpc: '2.0', id: 1, result })
const hex = (n: bigint) => `0x${n.toString(16)}`

const ENV = {
  WATCHWALLET_RPC_ETHEREUM: 'https://eth-a.test,https://eth-b.test',
  WATCHWALLET_RPC_BASE: 'https://base.test',
  WATCHWALLET_RPC_POLYGON: 'https://poly.test',
  WATCHWALLET_RPC_SOLANA: 'https://sol.test',
  MEMPOOL_URL: 'https://mempool.test',
  COINBASE_URL: 'https://cb.test',
}

describe('source adapters', () => {
  test('env lists replace the default RPCs', () => {
    expect(sourceConfig({}).rpc.ethereum[0]).toBe('https://ethereum-rpc.publicnode.com')
    expect(sourceConfig(ENV).rpc.ethereum).toEqual(['https://eth-a.test', 'https://eth-b.test'])
  })

  test('bitcoin: confirmed plus mempool sums, pending flagged', async () => {
    const net = fakeNet(() =>
      Response.json({ chain_stats: { funded_txo_sum: 150_000, spent_txo_sum: 50_000, tx_count: 3 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 30_000, tx_count: 1 } }),
    )
    const r = await readAddress(sourceConfig(ENV, net.f), 'bitcoin', 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh')
    expect(r).toEqual({ balances: { BTC: '70000' }, pending: true })
    expect(net.calls[0]!.url).toBe('https://mempool.test/api/address/bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh')
  })

  test('bitcoin: a strange answer is a failed read, not a zero balance', async () => {
    const net = fakeNet(() => Response.json({ chain_stats: {} }))
    await expect(readAddress(sourceConfig(ENV, net.f), 'bitcoin', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).rejects.toBeInstanceOf(SourceError)
  })

  test('EVM: native balance and balanceOf on each token contract', async () => {
    const addr = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045'
    const net = fakeNet((_url, body) => {
      if (body.method === 'eth_getBalance') return rpc(hex(1_500_000_000_000_000_000n))
      const to = body.params[0].to.toLowerCase()
      expect(body.params[0].data).toBe(`0x70a08231${addr.slice(2).padStart(64, '0')}`)
      return rpc(to === '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' ? hex(250_000_000n) : '0x0')
    })
    const r = await readAddress(sourceConfig(ENV, net.f), 'base', addr)
    expect(r.balances).toEqual({ ETH: '1500000000000000000', USDC: '250000000', USDT: '0' })
    expect(net.calls.every((c) => c.url === 'https://base.test')).toBe(true)
  })

  test('EVM: falls back to the next RPC when one refuses, fails when all do', async () => {
    const net = fakeNet((url, body) => {
      if (url === 'https://eth-a.test') return new Response('Your access is limited.', { status: 403 })
      return rpc(body.method === 'eth_getBalance' ? '0x1' : '0x0')
    })
    const r = await readAddress(sourceConfig(ENV, net.f), 'ethereum', '0xd8da6bf26964af9d7eed9e03e53415d37aa96045')
    expect(r.balances.ETH).toBe('1')
    const down = fakeNet(() => Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'rate limit' } }))
    await expect(readAddress(sourceConfig(ENV, down.f), 'ethereum', '0xd8da6bf26964af9d7eed9e03e53415d37aa96045')).rejects.toThrow('rate limit')
  })

  test('polygon: native POL', async () => {
    const net = fakeNet((_u, body) => rpc(body.method === 'eth_getBalance' ? hex(10n ** 18n) : hex(5n)))
    const r = await readAddress(sourceConfig(ENV, net.f), 'polygon', '0xd8da6bf26964af9d7eed9e03e53415d37aa96045')
    expect(r.balances).toEqual({ POL: '1000000000000000000', USDC: '5', USDT: '5' })
  })

  test('solana: lamports and summed token accounts per mint', async () => {
    const net = fakeNet((_u, body) => {
      if (body.method === 'getBalance') return rpc({ context: { slot: 1 }, value: 2_000_000_000 })
      const mint = body.params[1].mint
      const accounts = mint.startsWith('EPj')
        ? [{ account: { data: { parsed: { info: { tokenAmount: { amount: '1000000' } } } } } }, { account: { data: { parsed: { info: { tokenAmount: { amount: '500000' } } } } } }]
        : []
      return rpc({ context: { slot: 1 }, value: accounts })
    })
    const r = await readAddress(sourceConfig(ENV, net.f), 'solana', 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg')
    expect(r.balances).toEqual({ SOL: '2000000000', USDC: '1500000', USDT: '0' })
  })

  test('solana: an exchange wallet above 2^53 lamports still reads', async () => {
    // The live answer for an exchange hot wallet on 2026-10-21, sent as raw JSON text.
    const net = fakeNet((_u, body) =>
      body.method === 'getBalance'
        ? new Response('{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":1},"value":11175975344465202}}', { headers: { 'content-type': 'application/json' } })
        : rpc({ context: { slot: 1 }, value: [] }),
    )
    const r = await readAddress(sourceConfig(ENV, net.f), 'solana', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')
    expect(BigInt(r.balances.SOL!) / 1_000_000_000n).toBe(11_175_975n)
  })

  test('solana: a malformed token account fails the read', async () => {
    const net = fakeNet((_u, body) => rpc(body.method === 'getBalance' ? { value: 1 } : { value: [{ account: {} }] }))
    await expect(readAddress(sourceConfig(ENV, net.f), 'solana', 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg')).rejects.toBeInstanceOf(SourceError)
  })

  test('prices from Coinbase; an unknown coin throws; the cache asks once per pass', async () => {
    const net = fakeNet((url) => (url.includes('/BTC-USD/') ? Response.json({ data: { amount: '82723.36', base: 'BTC', currency: 'USD' } }) : Response.json({ message: 'not found' }, { status: 404 })))
    const cfg = sourceConfig(ENV, net.f)
    expect(await spotPrice(cfg, 'BTC')).toBe(82723.36)
    await expect(spotPrice(cfg, 'NOPE')).rejects.toBeInstanceOf(SourceError)
    const price = priceCache(cfg)
    await Promise.all([price('BTC'), price('BTC'), price('NOPE')])
    expect(await price('NOPE')).toBeNull()
    expect(net.calls.filter((c) => c.url.includes('BTC')).length).toBe(2) // one above, one for the cache
  })

  test('a network error is a SourceError', async () => {
    const f = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    await expect(readAddress(sourceConfig(ENV, f), 'bitcoin', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).rejects.toBeInstanceOf(SourceError)
  })
})

describe('backoff', () => {
  test('1, 2, 4 minutes, capped at 30, reset by a success', () => {
    const b = new Backoff()
    expect(b.ready('chain:base', 0)).toBe(true)
    expect(b.fail('chain:base', 0)).toBe(60_000)
    expect(b.ready('chain:base', 59_999)).toBe(false)
    expect(b.ready('chain:base', 60_000)).toBe(true)
    expect(b.fail('chain:base', 60_000)).toBe(120_000)
    expect(b.fail('chain:base', 0)).toBe(240_000)
    for (let i = 0; i < 10; i++) b.fail('chain:base', 0)
    expect(b.fail('chain:base', 0)).toBe(30 * 60_000)
    expect(b.ready('chain:solana', 0)).toBe(true)
    b.ok('chain:base')
    expect(b.ready('chain:base', 0)).toBe(true)
  })
})
