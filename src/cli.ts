/**
 * watchwallet: watch.wallet from the terminal.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { KEY_FILE, WatchClient, watchText } from './client.js'
import { VERSION } from './version.js'

export const HELP = `watchwallet ${VERSION}: know the second your wallet moves (https://watch.wallet.pit.world)

  watchwallet                                  interactive (TUI)
  watchwallet login <ww_key>                   save your API key (make one at /me#account)
  watchwallet status                           your watches and their last balances
  watchwallet add <chain> <address> [--label=…] [--min-usd=N] [--call]
                                               watch an address (bitcoin, ethereum, base, polygon, solana)
  watchwallet price <coin> above|below <usd> [--label=…] [--call]
                                               watch a price, like: price BTC below 60000
  watchwallet rm <watch>                       stop watching (id or label)
  watchwallet pause|resume <watch>
  watchwallet alerts [--limit=N]               recent alerts
  watchwallet ack [alert id]                   acknowledge one alert, or all of them
  watchwallet check <chain> <address>          one balance lookup, no key needed
  watchwallet redeem <credit-code>             add days of Watcher from a code someone gave you
  watchwallet invite-link [note]               a single-use invite link (you both get Watcher days)
  watchwallet invites                          your invites left and your ?ref= link
  watchwallet mcp                              MCP server: claude mcp add watchwallet -- bunx @profullstack/watchwallet mcp
  watchwallet codes mint <days> [--label=…] [--max=N] [--expires=30d]
                                               on the server (DATABASE_URL): mint a credit code; also list, revoke <id>, grant <email> <days>
  watchwallet serve [--port N]                 run your own instance (DATABASE_URL, WATCHWALLET_SECRET)

  --json                                       machine-readable output
  WATCHWALLET_KEY=ww_…  WATCHWALLET_URL=https://…   (default https://watch.wallet.pit.world)
`

type Out = { log(text: string): void; error(text: string): void }

async function ask(question: string): Promise<string> {
  process.stderr.write(question)
  for await (const line of console) return String(line).trim()
  return ''
}

export async function main(argv = process.argv.slice(2), out: Out = console, client = new WatchClient()): Promise<number> {
  const json = argv.includes('--json')
  const flag = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
  const has = (name: string) => argv.includes(`--${name}`)
  const args = argv.filter((a) => !a.startsWith('--'))
  const [command, ...rest] = args
  const show = (value: unknown, text: string) => out.log(json ? JSON.stringify(value, null, 2) : text)
  try {
    switch (command) {
      case undefined: {
        if (!process.stdout.isTTY) return out.log(HELP), 0
        const { runTui } = await import('./tui.js')
        await runTui(client)
        return 0
      }
      case 'help':
      case '-h':
        out.log(HELP)
        return 0
      case 'version':
        out.log(VERSION)
        return 0
      case 'mcp': {
        const { runMcp } = await import('./mcp.js')
        await runMcp(client)
        return 0
      }
      case 'codes': {
        const { codesAdmin } = await import('./codes-admin.js')
        return await codesAdmin(argv.slice(argv.indexOf('codes') + 1), out)
      }
      case 'serve': {
        const i = argv.indexOf('--port')
        const { serve } = await import('./server.js')
        const s = await serve(i >= 0 ? { port: Number(argv[i + 1]) } : {})
        out.log(`watch.wallet listening on http://${s.hostname}:${s.port}`)
        return await new Promise<number>(() => {})
      }
      case 'login': {
        const key = rest[0] ?? (await ask('API key (ww_…): '))
        if (!key.startsWith('ww_')) throw new Error('that is not a watch.wallet key (they start with ww_)')
        const me = await new WatchClient(client.base, key).me()
        mkdirSync(dirname(KEY_FILE), { recursive: true, mode: 0o700 })
        writeFileSync(KEY_FILE, `${key}\n`, { mode: 0o600 })
        out.log(`Signed in as ${me.email} (${me.plan}). Key saved to ${KEY_FILE}.`)
        return 0
      }
      case 'status':
      case 'ls': {
        const me = await client.me()
        show(me, `${me.email} · ${me.plan} · ${me.watches.length} of ${me.limits.watches} watches\n${me.watches.map(watchText).join('\n') || 'nothing watched yet: watchwallet add ethereum 0x…'}`)
        return 0
      }
      case 'add': {
        const [chain, address] = rest
        if (!chain || !address) throw new Error('usage: watchwallet add <chain> <address> [--label=…] [--min-usd=N] [--call]')
        const min = flag('min-usd')
        const w = await client.addAddress({ chain, address, ...(flag('label') ? { label: flag('label')! } : {}), ...(min ? { min_usd: Number(min) } : {}), ...(has('call') ? { call: true } : {}) })
        show(w, `watching: ${w.name}. The first read is the baseline; any move after that alerts you.`)
        return 0
      }
      case 'price': {
        const [coin, direction, level] = rest
        if (!coin || (direction !== 'above' && direction !== 'below') || !level) throw new Error('usage: watchwallet price <coin> above|below <usd>')
        const w = await client.addPrice({ coin, direction, level_usd: Number(level.replace(/[$,]/g, '')), ...(flag('label') ? { label: flag('label')! } : {}), ...(has('call') ? { call: true } : {}) })
        show(w, `watching: ${w.name}`)
        return 0
      }
      case 'rm':
      case 'remove': {
        const w = await client.find(rest.join(' '))
        await client.remove(w.id)
        show({ ok: true, id: w.id }, `stopped watching ${w.name}`)
        return 0
      }
      case 'pause':
      case 'resume': {
        const w = await client.find(rest.join(' '))
        const next = command === 'pause' ? await client.pause(w.id) : await client.resume(w.id)
        show(next, watchText(next))
        return 0
      }
      case 'alerts': {
        const alerts = await client.alerts(Number(flag('limit') ?? 20))
        show(alerts, alerts.map((a) => `${a.at.slice(0, 16).replace('T', ' ')}  ${a.acked_at ? '     ' : 'OPEN '} ${a.summary}  ${a.id}`).join('\n') || 'no alerts yet')
        return 0
      }
      case 'ack': {
        const n = await client.ack('cli', rest[0])
        show({ acknowledged: n }, n ? `acknowledged ${n}` : 'nothing open to acknowledge')
        return 0
      }
      case 'redeem': {
        if (!rest[0]) throw new Error('usage: watchwallet redeem <credit-code>')
        const r = await client.redeem(rest[0])
        show(r, r.message)
        return 0
      }
      case 'invite-link': {
        const r = await client.newInvite(rest.join(' ') || undefined)
        show(r, `${r.link}\n(${r.left} invites left)`)
        return 0
      }
      case 'invites': {
        const r = await client.invites()
        show(r, `${r.quota.left} of ${r.quota.total} invites left · ${r.invitees} joined\nyour link: ${r.affiliate_link}`)
        return 0
      }
      case 'check': {
        const [chain, address] = rest
        if (!chain || !address) throw new Error('usage: watchwallet check <chain> <address>')
        const r = await client.check(chain, address)
        show(r, `${r.chain} ${r.address}\n${r.rows.map((x) => `  ${x.asset.padEnd(6)} ${x.amount.padStart(22)}${x.usd === null ? '' : `  $${x.usd.toFixed(2)}`}`).join('\n')}${r.pending ? '\n  (an unconfirmed transaction is in the mempool)' : ''}`)
        return 0
      }
    }
    out.error(`watchwallet: unknown command "${command}"\n\n${HELP}`)
    return 2
  } catch (error) {
    out.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}
