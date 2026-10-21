/**
 * The worker: once a minute, every watch whose next check is due gets read.
 * Free plans are checked every 15 minutes, paid plans every minute.
 *
 * One read is: lease the watch (compare-and-set on its version), read the
 * chain or the price, and commit the new balances and any alert in one
 * transaction that only succeeds if nobody else touched the watch meanwhile.
 * Only the worker whose commit succeeded sends anything, so two copies of
 * the worker never alert twice on one move.
 *
 * A failed read never alerts and never moves the baseline. The watch is
 * retried later and the source it used is backed off (1, 2, 4 … 30 minutes),
 * so one broken RPC does not hold up the other chains.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { CHAIN_INFO, shortAddress } from './chains.js'
import type { Alert, Store, User, Watch } from './db.js'
import { decidePrice, describeChanges, diffBalances, shouldAlert, speakChanges, usd, valueChanges, type Change } from './engine.js'
import type { Notifier } from './notify.js'
import { FREE, isPaid, limitsFor, type PlanConfig } from './plans.js'
import { Backoff, priceCache, readAddress, sourceKey, type SourceConfig } from './sources.js'

export type WorkerDeps = { store: Store; notifier: Notifier; plans: PlanConfig; key: string; origin: string; sources: SourceConfig; backoff?: Backoff; log?: (line: string) => void }

const LEASE_MS = 2 * 60_000

/** A one-tap acknowledge link for one alert (email, push button). */
export function ackToken(key: string, alertId: string): string {
  return `${alertId}.${createHmac('sha256', key).update(`ack:${alertId}`).digest('base64url').slice(0, 22)}`
}

export function alertForAckToken(key: string, t: string): string | null {
  const [alertId] = t.split('.')
  if (!alertId) return null
  const expected = Buffer.from(ackToken(key, alertId))
  const given = Buffer.from(t)
  return expected.length === given.length && timingSafeEqual(expected, given) ? alertId : null
}

export const watchName = (w: Pick<Watch, 'label' | 'kind' | 'chain' | 'address' | 'coin' | 'direction' | 'level_usd'>) =>
  w.label || (w.kind === 'price' ? `${w.coin} ${w.direction} ${usd(w.level_usd)}` : `${CHAIN_INFO[w.chain!].label} ${shortAddress(w.address)}`)

export type TickResult = { checked: number; alerts: number; failed: number }

export async function tick(deps: WorkerDeps, now = Date.now()): Promise<TickResult> {
  const { store, log = console.log } = deps
  const backoff = (deps.backoff ??= new Backoff())
  await enforcePlans(deps, now)
  const price = priceCache(deps.sources)
  const users = new Map<string, Promise<User | null>>()
  const userOf = (id: string) => {
    let p = users.get(id)
    if (!p) users.set(id, (p = store.user(id)))
    return p
  }
  const result: TickResult = { checked: 0, alerts: 0, failed: 0 }
  const due = await store.dueWatches()
  // A few at a time: public RPCs rate-limit a burst.
  const queue = [...due]
  const lane = async () => {
    for (let w = queue.shift(); w; w = queue.shift()) {
      try {
        const user = await userOf(w.user_id)
        if (!user) continue
        const r = await checkWatch(deps, backoff, price, w, user, now)
        if (r === 'alert') result.alerts += 1
        if (r === 'failed') result.failed += 1
        if (r !== 'skipped') result.checked += 1
      } catch (e) {
        log(`[worker] ${w.id}: ${e instanceof Error ? e.message : e}`)
      }
    }
  }
  await Promise.all(Array.from({ length: 6 }, lane))
  await renewals(deps)
  return result
}

type Outcome = 'ok' | 'alert' | 'failed' | 'skipped'

async function checkWatch(deps: WorkerDeps, backoff: Backoff, price: (coin: string) => Promise<number | null>, w: Watch, user: User, now: number): Promise<Outcome> {
  const { store } = deps
  const limits = limitsFor(deps.plans, user, now)
  const next = now + limits.everyMs
  const src = sourceKey(w.kind === 'address' ? w.chain : null, w.coin)
  // A backed-off source: look again when it is due, without spending a lease.
  if (!backoff.ready(src, now)) return 'skipped'
  const version = await store.lease(w, now + LEASE_MS)
  if (version === null) return 'skipped'

  if (w.kind === 'price') {
    const p = await price(w.coin)
    if (p === null) {
      const wait = backoff.fail(src, now)
      await store.readFailed(w.id, version, `no price for ${w.coin} from Coinbase`, Math.max(next, now + wait))
      return 'failed'
    }
    backoff.ok(src)
    const d = decidePrice({ direction: w.direction as 'above' | 'below', level: w.level_usd, armed: w.armed }, p)
    const name = watchName(w)
    const alert = d.fire
      ? { kind: 'price' as const, summary: `${w.coin} is ${w.direction} ${usd(w.level_usd)}: now ${usd(p)}`, speech: `${name}. ${w.coin} is ${w.direction} ${Math.round(w.level_usd)} dollars, now ${Math.round(p)} dollars`, usd: p, detail: { price: p, level: w.level_usd, direction: w.direction } }
      : undefined
    const c = await store.commitRead(w.id, version, { price: p, armed: d.armed, nextMs: next }, alert)
    if (c.alert) await deliver(deps, w, user, c.alert, now)
    return c.alert ? 'alert' : 'ok'
  }

  let reading
  try {
    reading = await readAddress(deps.sources, w.chain!, w.address)
    backoff.ok(src)
  } catch (e) {
    const wait = backoff.fail(src, now)
    await store.readFailed(w.id, version, e instanceof Error ? e.message : String(e), Math.max(next, now + wait))
    return 'failed'
  }
  // The first good read is the baseline: nothing to compare with yet.
  if (!w.baseline) {
    await store.commitRead(w.id, version, { balances: reading.balances, baseline: reading.balances, nextMs: next })
    return 'ok'
  }
  const raw = diffBalances(w.chain!, w.baseline, reading.balances)
  if (!raw.length) {
    await store.commitRead(w.id, version, { balances: reading.balances, nextMs: next })
    return 'ok'
  }
  const native = CHAIN_INFO[w.chain!].native
  const changes = valueChanges(raw, { [native]: await price(native) })
  const minUsd = limits.thresholds ? w.min_usd : 0
  if (!shouldAlert(changes, minUsd)) {
    // Under the threshold: keep the old baseline, so small moves add up.
    await store.commitRead(w.id, version, { balances: reading.balances, nextMs: next })
    return 'ok'
  }
  const name = watchName(w)
  const total = changes.every((c) => c.usd !== null) ? changes.reduce((s, c) => s + Math.abs(c.usd!), 0) : null
  const c = await store.commitRead(w.id, version, { balances: reading.balances, baseline: reading.balances, nextMs: next }, {
    kind: 'address',
    summary: `${name} moved: ${describeChanges(changes)}${reading.pending ? ' (unconfirmed)' : ''}`,
    speech: `${name} moved ${speakChanges(changes)}`,
    usd: total,
    detail: { changes: changes.map(changeJson), pending: reading.pending, balances: reading.balances },
  })
  if (c.alert) await deliver(deps, w, user, c.alert, now)
  return c.alert ? 'alert' : 'ok'
}

const changeJson = (c: Change) => ({ asset: c.asset, decimals: c.decimals, delta: c.delta.toString(), usd: c.usd })

/** Tell the owner on every channel their plan has. Each one is independent. */
async function deliver(deps: WorkerDeps, w: Watch, user: User, a: Alert, now: number): Promise<void> {
  const paid = isPaid(deps.plans, user, now)
  const ack = ackToken(deps.key, a.id)
  const page = `${deps.origin}/w/${w.id}`
  const explorer = w.kind === 'address' ? `\nOn the explorer: ${CHAIN_INFO[w.chain!].explorer(w.address)}\n` : ''
  const jobs: Promise<unknown>[] = [
    deps.notifier.mail({
      to: user.email,
      subject: `watch.wallet: ${a.summary}`.slice(0, 180),
      text: `${a.summary}

${w.kind === 'address' ? `Address: ${w.address} (${CHAIN_INFO[w.chain!].label})` : `Rule: ${w.coin} ${w.direction} ${usd(w.level_usd)}`}
When: ${a.at.toUTCString()}
${explorer}
If this was you, acknowledge it: ${deps.origin}/a/${ack}
If it was not you, act now: move what is left to a wallet whose keys were never near this one.

The watch: ${page}

watch.wallet`,
    }),
    deps.notifier.push(user, { title: 'watch.wallet alert', body: a.summary, url: `/w/${w.id}`, ack }),
  ]
  if (paid && w.call && user.phone) jobs.push(deps.notifier.call(user.phone, a.id))
  if (paid && user.webhook_url && user.webhook_secret) {
    jobs.push(
      deps.notifier.webhook(user.webhook_url, user.webhook_secret, {
        event: 'watch.alert',
        alert: { id: a.id, at: a.at, kind: a.kind, summary: a.summary, usd: a.usd, detail: a.detail },
        watch: { id: w.id, label: w.label, kind: w.kind, chain: w.chain, address: w.address, coin: w.coin, direction: w.direction, level_usd: w.level_usd, url: page },
      }),
    )
  }
  await Promise.allSettled(jobs)
}

/** Lapsed plans keep their oldest three watches running and pause the rest; a paid plan gets them back. */
async function enforcePlans(deps: WorkerDeps, now: number): Promise<void> {
  const { store } = deps
  for (const uid of await store.usersOverActive(FREE.watches)) {
    const u = await store.user(uid)
    if (u && !isPaid(deps.plans, u, now)) {
      const n = await store.pauseBeyond(uid, FREE.watches)
      if (n) deps.log?.(`[worker] ${uid}: plan lapsed, paused ${n} watches`)
    }
  }
  for (const uid of await store.usersWithPlanPaused()) {
    const u = await store.user(uid)
    if (!u) continue
    const room = limitsFor(deps.plans, u, now).watches - (await store.countWatches(uid, true))
    await store.resumePlanPaused(uid, room)
  }
}

async function renewals(deps: WorkerDeps): Promise<void> {
  for (const u of await deps.store.renewalsDue(3 * 86_400_000)) {
    await deps.notifier.mail({
      to: u.email,
      subject: 'Your watch.wallet Watcher plan ends soon',
      text: `Hi ${u.name || 'there'},

Your Watcher plan ends on ${u.plan_until!.toUTCString()}. Nothing is deleted when it does: your first three watches keep running, checked every 15 minutes by email and push. Phone calls, webhooks, dollar thresholds and any watches past three pause until you renew.

Renew (crypto, via CoinPay): ${deps.origin}/plans

watch.wallet`,
    })
    await deps.store.markRenewalWarned(u.id)
  }
}

export function startWorker(deps: WorkerDeps, everyMs = 60_000): () => void {
  let busy = false
  const run = async () => {
    if (busy) return
    busy = true
    try {
      const r = await tick(deps)
      if (r.alerts || r.failed) deps.log?.(`[worker] checked ${r.checked}, alerts ${r.alerts}, failed ${r.failed}`)
    } catch (e) {
      deps.log?.(`[worker] tick failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      busy = false
    }
  }
  const timer = setInterval(run, everyMs)
  timer.unref?.()
  void run()
  return () => clearInterval(timer)
}
