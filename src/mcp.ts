/**
 * `watchwallet mcp`: watch.wallet for an agent, on stdio.
 *
 *   claude mcp add watchwallet -- bunx @profullstack/watchwallet mcp
 *
 * check_address needs no key; the rest need WATCHWALLET_KEY (or `watchwallet login`).
 * Nothing here can move funds: watch.wallet only reads public balances.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { WatchClient } from './client.js'
import { VERSION } from './version.js'

const text = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })
const failure = (error: unknown) => ({ isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] })
const wrap = <A>(fn: (a: A) => Promise<unknown>) => async (a: A) => {
  try {
    return text(await fn(a))
  } catch (e) {
    return failure(e)
  }
}
const chain = z.enum(['bitcoin', 'ethereum', 'base', 'polygon', 'solana'])

export function createMcpServer(client = new WatchClient()): McpServer {
  const server: any = new McpServer({ name: 'watch.wallet', version: VERSION })
  server.tool('check_address', 'Look up the current balance of any address (native coin, USDC, USDT) with USD values. No key needed.', { chain, address: z.string().min(20).max(100) }, wrap(({ chain: c, address }: any) => client.check(c, address)))
  server.tool('list_watches', 'Your plan and every watch: last balances, last move, whether it is paused or failing.', {}, wrap(() => client.me()))
  server.tool(
    'add_watch',
    'Watch an address: alert (email, push, and on Watcher a phone call and webhook) when its native, USDC or USDT balance changes. min_usd (Watcher) alerts only on moves worth at least that much.',
    { chain, address: z.string().min(20).max(100), label: z.string().max(60).optional(), min_usd: z.number().min(0).optional(), call: z.boolean().optional() },
    wrap((input: any) => client.addAddress(input)),
  )
  server.tool(
    'add_price_watch',
    'Watch a price: alert once when a coin (Coinbase ticker, like BTC) goes above or below a USD level. It re-arms when the price crosses back.',
    { coin: z.string().min(2).max(10), direction: z.enum(['above', 'below']), level_usd: z.number().positive(), label: z.string().max(60).optional(), call: z.boolean().optional() },
    wrap((input: any) => client.addPrice(input)),
  )
  server.tool('remove_watch', 'Stop watching (by id or label). Its alerts are deleted with it.', { watch: z.string().min(1) }, wrap(async ({ watch }: any) => {
    const w = await client.find(watch)
    await client.remove(w.id)
    return { removed: w.name }
  }))
  server.tool('redeem_code', 'Redeem a credit code someone gave you: it adds days of the Watcher plan.', { code: z.string().min(6).max(80) }, wrap(({ code }: any) => client.redeem(code)))
  server.tool('create_invite', 'Make a single-use invite link to watch.wallet (each person has 3). Whoever makes a new account through it and you both get Watcher days.', { note: z.string().max(80).optional() }, wrap(({ note }: any) => client.newInvite(note)))
  server.tool('recent_alerts', 'Recent alerts, newest first, with whether each was acknowledged.', { limit: z.number().int().min(1).max(200).optional() }, wrap(({ limit }: any) => client.alerts(limit ?? 20)))
  return server
}

export async function runMcp(client = new WatchClient()): Promise<void> {
  await createMcpServer(client).connect(new StdioServerTransport())
}
