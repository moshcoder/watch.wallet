/**
 * `watchwallet codes …`: mint, list, revoke and grant credit codes on the
 * server, straight against DATABASE_URL (the redeem-credits CLI only speaks
 * SQLite). Codes grant `watcher_days`.
 *
 *   watchwallet codes mint <days> [--label=…] [--max=N] [--expires=30d]
 *   watchwallet codes list
 *   watchwallet codes revoke <codeId>
 *   watchwallet codes grant <email> <days>
 */
import { Codes, WATCHER_DAYS } from './codes.js'
import { Store } from './db.js'
import { planConfig } from './plans.js'

type Out = { log(text: string): void }

const USAGE = 'usage: watchwallet codes mint <days> [--label=…] [--max=N] [--expires=30d] | list | revoke <codeId> | grant <email> <days>'

export async function codesAdmin(argv: string[], out: Out, env = process.env): Promise<number> {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set: run this on the server (source app.env)')
  const flag = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
  const [sub, ...rest] = argv.filter((a) => !a.startsWith('--'))
  const store = new Store(env.DATABASE_URL)
  try {
    await store.migrate()
    const codes = new Codes(store, planConfig(env))
    switch (sub) {
      case 'mint': {
        const days = Number(rest[0])
        if (!Number.isInteger(days) || days < 1) throw new Error(USAGE)
        const exp = flag('expires')?.match(/^(\d+)d$/)
        const m = await codes.credits.mint({
          grant: { unit: WATCHER_DAYS, amount: days },
          label: flag('label') ?? '',
          maxRedemptions: Number(flag('max') ?? 1),
          expiresAt: exp ? Date.now() + Number(exp[1]) * 86_400_000 : null,
          createdBy: 'cli',
        })
        out.log(`${m.code}\n${days} Watcher days · ${m.maxRedemptions} use(s) · id ${m.id}${m.expiresAt ? ` · expires ${new Date(m.expiresAt).toISOString().slice(0, 10)}` : ''}`)
        return 0
      }
      case 'list':
        for (const c of await codes.credits.list()) {
          out.log(`${c.id}  ${c.grant.amount} ${c.grant.unit}  ${c.redemptions}/${c.maxRedemptions}${c.revokedAt ? '  revoked' : ''}  ${c.label}`)
        }
        return 0
      case 'revoke':
        if (!rest[0]) throw new Error(USAGE)
        await codes.credits.revoke(rest[0])
        out.log(`revoked ${rest[0]}`)
        return 0
      case 'grant': {
        const u = rest[0] ? await store.userByEmail(rest[0]) : null
        const days = Number(rest[1])
        if (!u || !Number.isInteger(days) || days < 1) throw new Error(u ? USAGE : 'no account with that email')
        await codes.credits.grant(u.id, { unit: WATCHER_DAYS, amount: days }, 'cli grant')
        const applied = await codes.applyWatcherDays(u.id, 'grant')
        out.log(`${u.email}: ${applied} Watcher days added, plan until ${(await store.user(u.id))?.plan_until?.toISOString().slice(0, 10)}`)
        return 0
      }
    }
    throw new Error(USAGE)
  } finally {
    await store.close()
  }
}
