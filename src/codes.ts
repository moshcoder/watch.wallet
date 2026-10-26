/**
 * Credit codes and invites.
 *
 * A credit code (@profullstack/redeem-credits) grants the unit `watcher_days`:
 * days of the Watcher plan. When days land on an account they are applied the
 * way a purchase is: a settled $0 row in `payments` (chain "credit-code") that
 * extends plan_until, so the plan has one source of truth and stacks with time
 * already paid for. Watches a lapsed plan paused come back at once.
 *
 * Invites (@profullstack/affiliates): three per person, each link works once,
 * for someone who makes a new account through it. An accepted invite gives
 * both people INVITE_DAYS Watcher days (so one person can earn at most three
 * weeks from inviting). Affiliate links (?ref=) are remembered first-touch.
 *
 * Both modules keep their own tables (credit_*, aff_*) in the app's Postgres,
 * through a tiny adapter over Bun's SQL client.
 */
import { Affiliates, postgresStore as affiliateStore } from '@profullstack/affiliates'
import { Credits, postgresStore } from '@profullstack/redeem-credits'
import type { Store, User } from './db.js'
import { limitsFor, type PlanConfig } from './plans.js'

export const WATCHER_DAYS = 'watcher_days'
/** Invite links each person can hand out. Scarce on purpose: an invite should mean something. */
export const INVITES_PER_PERSON = 3
/** Watcher days an accepted invite gives the new person and the one who invited them. */
export const INVITE_DAYS = 7
export const INVITE_CODE = /^[A-Za-z0-9-]{6,40}$/
export const REF_CODE = /^[A-Za-z0-9-]{4,40}$/

export class CodeError extends Error {}

const WHY: Record<string, string> = {
  invalid: 'That code is not valid.',
  expired: 'That code has expired.',
  used_up: 'That code has been used.',
  already_redeemed: 'You already redeemed that code.',
  revoked: 'That code was withdrawn.',
}

/** The `pool.query(sql, params) -> { rows }` shape both modules want, over Bun's SQL client. */
export const pgLike = (store: Store) => ({
  query: async (sql: string, params: unknown[] = []) => ({ rows: (await store.sql.unsafe(sql, params as never[])) as any[] }),
})

export class Codes {
  readonly credits: Credits
  readonly affiliates: Affiliates
  constructor(
    readonly store: Store,
    readonly plans: PlanConfig,
  ) {
    this.credits = new Credits(postgresStore(pgLike(store)))
    this.affiliates = new Affiliates(affiliateStore(pgLike(store)), { defaultQuota: INVITES_PER_PERSON })
  }

  /**
   * Turn whole watcher_days on the account into Watcher time, the way a
   * purchase does. Days can also arrive outside a redemption (an invite, or a
   * `grant` from the server), so /me calls this first. Returns the days applied.
   */
  async applyWatcherDays(userId: string, why = 'credit code'): Promise<number> {
    const days = Math.floor(await this.credits.balance(userId, WATCHER_DAYS))
    if (days < 1) return 0
    const spent = await this.credits.spend(userId, WATCHER_DAYS, days, `${days} Watcher days applied`)
    if (!spent.ok) return 0
    await this.store.grantPlanDays(userId, days, { product: `${days} days, ${why}`, chain: 'credit-code', raw: { source: 'redeem-credits', unit: WATCHER_DAYS, days, why } })
    const u = await this.store.user(userId)
    if (u) await this.store.resumePlanPaused(u.id, limitsFor(this.plans, u, this.store.now().getTime()).watches - (await this.store.countWatches(u.id, true)))
    return days
  }

  /** Redeem a credit code for the signed-in person; the message to show them. */
  async redeem(u: User, input: unknown): Promise<string> {
    const code = String(input ?? '').trim()
    if (!code) throw new CodeError('Type the code first.')
    if (code.length > 80) throw new CodeError(WHY.invalid!)
    const r = await this.credits.redeem(code, u.id)
    if (!r.ok) throw new CodeError(WHY[r.reason] ?? 'That code did not work.')
    if (r.grant.unit !== WATCHER_DAYS) return `Code redeemed: ${r.grant.amount} ${r.grant.unit}.`
    const days = await this.applyWatcherDays(u.id)
    const after = await this.store.user(u.id)
    const until = after?.plan_until ? ` Watcher runs until ${after.plan_until.toISOString().slice(0, 10)}.` : ''
    return days ? `Code redeemed: ${days} days of Watcher added.${until}` : 'Code redeemed.'
  }

  /**
   * A new account signed up through an invite: spend it, remember who invited
   * whom, and give both of them INVITE_DAYS of Watcher.
   */
  async acceptInvite(code: string, newUserId: string): Promise<{ ok: boolean; reason?: string; inviterId?: string }> {
    const r = await this.affiliates.redeemInvite(code, newUserId)
    if (!r.ok) return { ok: false, reason: r.reason }
    for (const uid of [newUserId, r.inviterId]) {
      await this.credits.grant(uid, { unit: WATCHER_DAYS, amount: INVITE_DAYS }, `invite:${r.inviteId}`)
      await this.applyWatcherDays(uid, 'invite')
    }
    return { ok: true, inviterId: r.inviterId }
  }

  async invitesView(userId: string, origin: string) {
    return {
      quota: await this.affiliates.quota(userId),
      invites: await this.affiliates.invites(userId),
      invitees: (await this.affiliates.invitees(userId)).length,
      affiliate: `${origin}/?ref=${await this.affiliates.affiliateCode(userId)}`,
    }
  }
}
