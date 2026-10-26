/**
 * The Postgres store (self-hosted on the box, DATABASE_URL), through Bun's
 * built-in client. Migrations are idempotent CREATE ... IF NOT EXISTS and run
 * on boot, so two processes starting at once are fine.
 *
 * Secrets we hand out (session ids, sign-in links, API keys) are stored as
 * SHA-256 hashes. The one exception is each user's webhook signing secret,
 * which we need in the clear to sign with.
 *
 * Every write the worker makes is a compare-and-set on `version`: it leases a
 * watch (version + 1), reads the chain, and commits only if the version is
 * still the one it leased. Two workers never both alert on the same move.
 */
import { createHash, randomBytes } from 'node:crypto'
import { SQL } from 'bun'
import type { Chain } from './chains.js'
import type { Balances } from './sources.js'

export const hash = (secret: string) => createHash('sha256').update(secret).digest('hex')
export const token = (prefix = '', bytes = 24) => `${prefix}${randomBytes(bytes).toString('base64url')}`
const id = () => randomBytes(9).toString('base64url')

export type Plan = 'free' | 'watcher'
export type User = { id: string; email: string; name: string; plan: Plan; plan_until: Date | null; phone: string; webhook_url: string; webhook_secret: string; created_at: Date }
export type WatchKind = 'address' | 'price'
export type Watch = {
  id: string
  user_id: string
  kind: WatchKind
  label: string
  chain: Chain | null
  address: string
  coin: string
  direction: 'above' | 'below' | ''
  level_usd: number
  min_usd: number
  call: boolean
  state: 'active' | 'paused'
  paused_reason: '' | 'user' | 'plan'
  baseline: Balances | null
  balances: Balances | null
  price: number | null
  armed: boolean
  version: number
  last_checked_at: Date | null
  last_change_at: Date | null
  next_check_at: Date
  fail_count: number
  last_error: string
  created_at: Date
}
export type Alert = { id: string; watch_id: string; user_id: string; at: Date; kind: WatchKind; summary: string; speech: string; usd: number | null; detail: unknown; acked_at: Date | null; acked_via: string }
export type PushSub = { id: string; user_id: string; endpoint: string; p256dh: string; auth: string }
export type Payment = { ref: string; user_id: string; product: string; amount_cents: number; chain: string; status: string; settled_at: Date | null; created_at: Date }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL DEFAULT '',
  plan text NOT NULL DEFAULT 'free',
  plan_until timestamptz,
  phone text NOT NULL DEFAULT '',
  webhook_url text NOT NULL DEFAULT '',
  webhook_secret text NOT NULL DEFAULT '',
  api_key_hash text UNIQUE,
  renewal_warned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS login_links (
  token_hash text PRIMARY KEY,
  email text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_links_email ON login_links(email, created_at);
CREATE TABLE IF NOT EXISTS watches (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  label text NOT NULL DEFAULT '',
  chain text,
  address text NOT NULL DEFAULT '',
  coin text NOT NULL DEFAULT '',
  direction text NOT NULL DEFAULT '',
  level_usd double precision NOT NULL DEFAULT 0,
  min_usd double precision NOT NULL DEFAULT 0,
  call boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'active',
  paused_reason text NOT NULL DEFAULT '',
  baseline jsonb,
  balances jsonb,
  price double precision,
  armed boolean NOT NULL DEFAULT true,
  version int NOT NULL DEFAULT 0,
  last_checked_at timestamptz,
  last_change_at timestamptz,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  fail_count int NOT NULL DEFAULT 0,
  last_error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS watches_user ON watches(user_id, created_at);
CREATE INDEX IF NOT EXISTS watches_due ON watches(next_check_at) WHERE state = 'active';
CREATE TABLE IF NOT EXISTS alerts (
  id text PRIMARY KEY,
  watch_id text NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL,
  summary text NOT NULL,
  speech text NOT NULL DEFAULT '',
  usd double precision,
  detail jsonb,
  acked_at timestamptz,
  acked_via text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS alerts_user ON alerts(user_id, at DESC);
CREATE INDEX IF NOT EXISTS alerts_watch ON alerts(watch_id, at DESC);
CREATE TABLE IF NOT EXISTS push_subs (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_subs_user ON push_subs(user_id);
CREATE TABLE IF NOT EXISTS payments (
  ref text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product text NOT NULL,
  amount_cents int NOT NULL,
  chain text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  raw jsonb,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_user ON payments(user_id);
CREATE TABLE IF NOT EXISTS calls (
  call_id text PRIMARY KEY,
  alert_id text NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
`

const USER_COLS = 'id, email, name, plan, plan_until, phone, webhook_url, webhook_secret, created_at'
const WATCH_COLS =
  'id, user_id, kind, label, chain, address, coin, direction, level_usd, min_usd, call, state, paused_reason, baseline, balances, price, armed, version, last_checked_at, last_change_at, next_check_at, fail_count, last_error, created_at'
const ALERT_COLS = 'id, watch_id, user_id, at, kind, summary, speech, usd, detail, acked_at, acked_via'
const DAY = 86_400_000

export type NewWatch =
  | { kind: 'address'; label: string; chain: Chain; address: string; min_usd: number; call: boolean }
  | { kind: 'price'; label: string; coin: string; direction: 'above' | 'below'; level_usd: number; call: boolean }

export class Store {
  readonly sql: SQL
  constructor(url: string, readonly now: () => Date = () => new Date()) {
    this.sql = new SQL(url)
  }

  async migrate(): Promise<void> {
    await this.sql.unsafe(SCHEMA)
  }

  async close(): Promise<void> {
    await this.sql.close()
  }

  // ---- accounts --------------------------------------------------------------

  async userByEmail(email: string): Promise<User | null> {
    const [u] = await this.sql.unsafe(`SELECT ${USER_COLS} FROM users WHERE email = $1`, [email.toLowerCase()])
    return (u as User) ?? null
  }

  async user(userId: string): Promise<User | null> {
    const [u] = await this.sql.unsafe(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [userId])
    return (u as User) ?? null
  }

  async ensureUser(email: string): Promise<User> {
    const e = email.trim().toLowerCase()
    await this.sql`INSERT INTO users (id, email) VALUES (${id()}, ${e}) ON CONFLICT (email) DO NOTHING`
    return (await this.userByEmail(e))!
  }

  /** Like ensureUser, and whether this call made the account (an invite only counts for a new one). */
  async signUp(email: string): Promise<{ user: User; created: boolean }> {
    const e = email.trim().toLowerCase()
    const made = await this.sql`INSERT INTO users (id, email) VALUES (${id()}, ${e}) ON CONFLICT (email) DO NOTHING RETURNING id`
    return { user: (await this.userByEmail(e))!, created: made.length === 1 }
  }

  async updateUser(userId: string, fields: { name?: string; phone?: string; webhook_url?: string }): Promise<void> {
    if (fields.name !== undefined) await this.sql`UPDATE users SET name = ${fields.name.slice(0, 80)} WHERE id = ${userId}`
    if (fields.phone !== undefined) await this.sql`UPDATE users SET phone = ${fields.phone} WHERE id = ${userId}`
    if (fields.webhook_url !== undefined) {
      // The first URL gets a signing secret; later changes keep it.
      await this.sql`UPDATE users SET webhook_url = ${fields.webhook_url},
        webhook_secret = CASE WHEN webhook_secret = '' THEN ${token('whsec_', 24)} ELSE webhook_secret END WHERE id = ${userId}`
    }
  }

  async rotateWebhookSecret(userId: string): Promise<string> {
    const s = token('whsec_', 24)
    await this.sql`UPDATE users SET webhook_secret = ${s} WHERE id = ${userId}`
    return s
  }

  async deleteUser(userId: string): Promise<void> {
    await this.sql`DELETE FROM users WHERE id = ${userId}`
  }

  async newLoginLink(email: string, ttlMs = 20 * 60_000): Promise<string> {
    const t = token('', 32)
    await this.sql`INSERT INTO login_links (token_hash, email, expires_at) VALUES (${hash(t)}, ${email.toLowerCase()}, ${new Date(this.now().getTime() + ttlMs)})`
    return t
  }

  async recentLoginLinks(email: string, sinceMs: number): Promise<number> {
    const [r] = await this.sql`SELECT count(*)::int AS n FROM login_links WHERE email = ${email.toLowerCase()} AND created_at > ${new Date(this.now().getTime() - sinceMs)}`
    return r.n
  }

  /** One use, unexpired: the email it was sent to, or null. */
  async takeLoginLink(t: string): Promise<string | null> {
    const [r] = await this.sql`DELETE FROM login_links WHERE token_hash = ${hash(t)} AND expires_at > ${this.now()} RETURNING email`
    return r?.email ?? null
  }

  async newSession(userId: string, ttlMs = 60 * DAY): Promise<string> {
    const sid = token('', 32)
    await this.sql`INSERT INTO sessions (id_hash, user_id, expires_at) VALUES (${hash(sid)}, ${userId}, ${new Date(this.now().getTime() + ttlMs)})`
    return sid
  }

  async session(sid: string | undefined): Promise<User | null> {
    if (!sid) return null
    const [u] = await this.sql.unsafe(
      `SELECT ${USER_COLS.split(', ').map((c) => `u.${c}`).join(', ')} FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = $1 AND s.expires_at > $2`,
      [hash(sid), this.now()],
    )
    return (u as User) ?? null
  }

  async endSession(sid: string | undefined): Promise<void> {
    if (sid) await this.sql`DELETE FROM sessions WHERE id_hash = ${hash(sid)}`
  }

  async newApiKey(userId: string): Promise<string> {
    const key = token('ww_', 24)
    await this.sql`UPDATE users SET api_key_hash = ${hash(key)} WHERE id = ${userId}`
    return key
  }

  async userByApiKey(key: string): Promise<User | null> {
    if (!key.startsWith('ww_')) return null
    const [u] = await this.sql.unsafe(`SELECT ${USER_COLS} FROM users WHERE api_key_hash = $1`, [hash(key)])
    return (u as User) ?? null
  }

  // ---- watches ---------------------------------------------------------------

  async watches(userId: string): Promise<Watch[]> {
    return (await this.sql.unsafe(`SELECT ${WATCH_COLS} FROM watches WHERE user_id = $1 ORDER BY created_at`, [userId])) as Watch[]
  }

  async watchOf(userId: string, watchId: string): Promise<Watch | null> {
    const [w] = await this.sql.unsafe(`SELECT ${WATCH_COLS} FROM watches WHERE id = $1 AND user_id = $2`, [watchId, userId])
    return (w as Watch) ?? null
  }

  async watchById(watchId: string): Promise<Watch | null> {
    const [w] = await this.sql.unsafe(`SELECT ${WATCH_COLS} FROM watches WHERE id = $1`, [watchId])
    return (w as Watch) ?? null
  }

  async countWatches(userId: string, onlyActive = false): Promise<number> {
    const [r] = onlyActive
      ? await this.sql`SELECT count(*)::int AS n FROM watches WHERE user_id = ${userId} AND state = 'active'`
      : await this.sql`SELECT count(*)::int AS n FROM watches WHERE user_id = ${userId}`
    return r.n
  }

  /** Checked on the next worker pass, which records the first balances as the baseline. */
  async createWatch(userId: string, w: NewWatch): Promise<Watch> {
    const wid = id()
    if (w.kind === 'address') {
      await this.sql`INSERT INTO watches (id, user_id, kind, label, chain, address, min_usd, call, next_check_at)
        VALUES (${wid}, ${userId}, 'address', ${w.label}, ${w.chain}, ${w.address}, ${w.min_usd}, ${w.call}, ${this.now()})`
    } else {
      await this.sql`INSERT INTO watches (id, user_id, kind, label, coin, direction, level_usd, call, next_check_at)
        VALUES (${wid}, ${userId}, 'price', ${w.label}, ${w.coin}, ${w.direction}, ${w.level_usd}, ${w.call}, ${this.now()})`
    }
    return (await this.watchById(wid))!
  }

  /** Label, threshold, the phone-call flag and a price level. A new price level re-arms the watch. */
  async updateWatch(w: Watch, f: { label?: string; min_usd?: number; call?: boolean; level_usd?: number; direction?: 'above' | 'below' }): Promise<Watch> {
    const level = f.level_usd ?? w.level_usd
    const direction = f.direction ?? w.direction
    const rearm = level !== w.level_usd || direction !== w.direction
    await this.sql`UPDATE watches SET label = ${f.label ?? w.label}, min_usd = ${f.min_usd ?? w.min_usd}, call = ${f.call ?? w.call},
      level_usd = ${level}, direction = ${direction}, armed = ${rearm ? true : w.armed} WHERE id = ${w.id}`
    return (await this.watchById(w.id))!
  }

  async setWatchState(watchId: string, state: 'active' | 'paused', reason: '' | 'user' | 'plan' = state === 'paused' ? 'user' : ''): Promise<void> {
    await this.sql`UPDATE watches SET state = ${state}, paused_reason = ${reason}, next_check_at = ${this.now()} WHERE id = ${watchId}`
  }

  async deleteWatch(watchId: string): Promise<void> {
    await this.sql`DELETE FROM watches WHERE id = ${watchId}`
  }

  /** Active watches whose next check is due: the worker's queue. */
  async dueWatches(limit = 200): Promise<Watch[]> {
    return (await this.sql.unsafe(`SELECT ${WATCH_COLS} FROM watches WHERE state = 'active' AND next_check_at <= $1 ORDER BY next_check_at LIMIT $2`, [this.now(), limit])) as Watch[]
  }

  /** Claim a watch for one read. Returns the leased version, or null if another worker got there first. */
  async lease(w: Watch, untilMs: number): Promise<number | null> {
    const [r] = await this.sql`UPDATE watches SET version = version + 1, next_check_at = ${new Date(untilMs)}
      WHERE id = ${w.id} AND version = ${w.version} AND state = 'active' RETURNING version`
    return r?.version ?? null
  }

  /** A read failed: count it, say why, try again later. Balances and the baseline are left alone. */
  async readFailed(watchId: string, version: number, error: string, nextMs: number): Promise<void> {
    await this.sql`UPDATE watches SET fail_count = fail_count + 1, last_error = ${error.slice(0, 300)}, next_check_at = ${new Date(nextMs)}, last_checked_at = ${this.now()}
      WHERE id = ${watchId} AND version = ${version}`
  }

  /**
   * Commit a good read, and the alert it caused if any, in one transaction.
   * False if the watch changed hands (or was paused or deleted) since the lease:
   * then nothing is written and nobody is told.
   */
  async commitRead(
    watchId: string,
    version: number,
    r: { balances?: Balances; baseline?: Balances | null; price?: number; armed?: boolean; nextMs: number },
    alert?: { kind: WatchKind; summary: string; speech: string; usd: number | null; detail: unknown },
  ): Promise<{ ok: boolean; alert: Alert | null }> {
    return this.sql.begin(async (tx) => {
      const now = this.now()
      const rows = await tx`UPDATE watches SET
          balances = coalesce(${r.balances ?? null}::jsonb, balances),
          baseline = CASE WHEN ${r.baseline !== undefined} THEN ${r.baseline ?? null}::jsonb ELSE baseline END,
          price = coalesce(${r.price ?? null}::double precision, price),
          armed = coalesce(${r.armed ?? null}::boolean, armed),
          version = version + 1, fail_count = 0, last_error = '', last_checked_at = ${now}, next_check_at = ${new Date(r.nextMs)},
          last_change_at = CASE WHEN ${Boolean(alert)} THEN ${now}::timestamptz ELSE last_change_at END
        WHERE id = ${watchId} AND version = ${version} AND state = 'active' RETURNING user_id`
      if (!rows.length) return { ok: false, alert: null }
      if (!alert) return { ok: true, alert: null }
      const aid = id()
      await tx`INSERT INTO alerts (id, watch_id, user_id, at, kind, summary, speech, usd, detail)
        VALUES (${aid}, ${watchId}, ${rows[0].user_id}, ${now}, ${alert.kind}, ${alert.summary}, ${alert.speech}, ${alert.usd}, ${alert.detail as object})`
      const [a] = await tx.unsafe(`SELECT ${ALERT_COLS} FROM alerts WHERE id = $1`, [aid])
      return { ok: true, alert: a as Alert }
    })
  }

  // ---- plan limits -----------------------------------------------------------

  /** Users with more than `n` active watches: the ones a lapsed plan may have to trim. */
  async usersOverActive(n: number): Promise<string[]> {
    const rows = await this.sql`SELECT user_id FROM watches WHERE state = 'active' GROUP BY user_id HAVING count(*) > ${n}`
    return rows.map((r: { user_id: string }) => r.user_id)
  }

  /** Keep the oldest `keep` active watches running and pause the rest for the plan. Nothing is deleted. */
  async pauseBeyond(userId: string, keep: number): Promise<number> {
    const rows = await this.sql`UPDATE watches SET state = 'paused', paused_reason = 'plan'
      WHERE user_id = ${userId} AND state = 'active' AND id NOT IN (
        SELECT id FROM watches WHERE user_id = ${userId} AND state = 'active' ORDER BY created_at, id LIMIT ${keep}
      ) RETURNING id`
    return rows.length
  }

  async usersWithPlanPaused(): Promise<string[]> {
    const rows = await this.sql`SELECT DISTINCT user_id FROM watches WHERE state = 'paused' AND paused_reason = 'plan'`
    return rows.map((r: { user_id: string }) => r.user_id)
  }

  /** Resume watches the plan paused, oldest first, up to `room` of them. */
  async resumePlanPaused(userId: string, room: number): Promise<number> {
    if (room <= 0) return 0
    const rows = await this.sql`UPDATE watches SET state = 'active', paused_reason = '', next_check_at = ${this.now()}
      WHERE id IN (SELECT id FROM watches WHERE user_id = ${userId} AND state = 'paused' AND paused_reason = 'plan' ORDER BY created_at, id LIMIT ${room})
      RETURNING id`
    return rows.length
  }

  // ---- alerts ----------------------------------------------------------------

  async alerts(userId: string, limit = 20): Promise<Alert[]> {
    return (await this.sql.unsafe(`SELECT ${ALERT_COLS} FROM alerts WHERE user_id = $1 ORDER BY at DESC LIMIT $2`, [userId, limit])) as Alert[]
  }

  async alertsFor(watchId: string, limit = 50): Promise<Alert[]> {
    return (await this.sql.unsafe(`SELECT ${ALERT_COLS} FROM alerts WHERE watch_id = $1 ORDER BY at DESC LIMIT $2`, [watchId, limit])) as Alert[]
  }

  async alertById(alertId: string): Promise<Alert | null> {
    const [a] = await this.sql.unsafe(`SELECT ${ALERT_COLS} FROM alerts WHERE id = $1`, [alertId])
    return (a as Alert) ?? null
  }

  /** Acknowledge one alert. True the first time. */
  async ack(alertId: string, via: string): Promise<boolean> {
    const rows = await this.sql`UPDATE alerts SET acked_at = ${this.now()}, acked_via = ${via.slice(0, 20)} WHERE id = ${alertId} AND acked_at IS NULL RETURNING id`
    return rows.length === 1
  }

  /** Acknowledge every open alert of a user (or of one watch). */
  async ackAll(userId: string, via: string, watchId?: string): Promise<number> {
    const rows = watchId
      ? await this.sql`UPDATE alerts SET acked_at = ${this.now()}, acked_via = ${via.slice(0, 20)} WHERE user_id = ${userId} AND watch_id = ${watchId} AND acked_at IS NULL RETURNING id`
      : await this.sql`UPDATE alerts SET acked_at = ${this.now()}, acked_via = ${via.slice(0, 20)} WHERE user_id = ${userId} AND acked_at IS NULL RETURNING id`
    return rows.length
  }

  // ---- web push --------------------------------------------------------------

  async addPush(userId: string, sub: { endpoint: string; p256dh: string; auth: string }): Promise<void> {
    await this.sql`INSERT INTO push_subs (id, user_id, endpoint, p256dh, auth) VALUES (${id()}, ${userId}, ${sub.endpoint}, ${sub.p256dh}, ${sub.auth})
      ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`
  }

  async pushSubs(userId: string): Promise<PushSub[]> {
    return (await this.sql`SELECT id, user_id, endpoint, p256dh, auth FROM push_subs WHERE user_id = ${userId}`) as PushSub[]
  }

  async dropPush(endpoint: string): Promise<void> {
    await this.sql`DELETE FROM push_subs WHERE endpoint = ${endpoint}`
  }

  // ---- phone calls -----------------------------------------------------------

  async recordCall(callId: string, alertId: string): Promise<void> {
    await this.sql`INSERT INTO calls (call_id, alert_id) VALUES (${callId}, ${alertId}) ON CONFLICT DO NOTHING`
  }

  async callAlert(callId: string): Promise<string | null> {
    const [r] = await this.sql`SELECT alert_id FROM calls WHERE call_id = ${callId}`
    return r?.alert_id ?? null
  }

  // ---- payments --------------------------------------------------------------

  async recordPayment(p: { ref: string; user_id: string; product: string; amount_cents: number; chain: string; raw: unknown }): Promise<void> {
    await this.sql`INSERT INTO payments (ref, user_id, product, amount_cents, chain, raw) VALUES (${p.ref}, ${p.user_id}, ${p.product}, ${p.amount_cents}, ${p.chain}, ${p.raw as object})
      ON CONFLICT (ref) DO NOTHING`
  }

  async payment(ref: string): Promise<Payment | null> {
    const [p] = await this.sql`SELECT ref, user_id, product, amount_cents, chain, status, settled_at, created_at FROM payments WHERE ref = ${ref}`
    return (p as Payment) ?? null
  }

  async payments(userId: string): Promise<Payment[]> {
    return (await this.sql`SELECT ref, user_id, product, amount_cents, chain, status, settled_at, created_at FROM payments WHERE user_id = ${userId} ORDER BY created_at DESC`) as Payment[]
  }

  /**
   * Record a webhook status. The first time a payment settles it extends the
   * plan by `days` from now, or from the current end if still paid up.
   */
  async settlePayment(ref: string, status: string, raw: unknown, settled: boolean, daysFor: (product: string) => number): Promise<{ granted: boolean; userId: string | null }> {
    return this.sql.begin(async (tx) => {
      const [p] = await tx`SELECT ref, user_id, product, settled_at FROM payments WHERE ref = ${ref} FOR UPDATE`
      if (!p) return { granted: false, userId: null }
      await tx`UPDATE payments SET status = ${status || 'unknown'}, raw = ${raw as object}, updated_at = ${this.now()} WHERE ref = ${ref}`
      if (!settled || p.settled_at) return { granted: false, userId: p.user_id }
      await tx`UPDATE payments SET settled_at = ${this.now()} WHERE ref = ${ref}`
      await tx`UPDATE users SET plan = 'watcher',
        plan_until = greatest(coalesce(plan_until, ${this.now()}::timestamptz), ${this.now()}::timestamptz) + make_interval(days => ${daysFor(p.product)}::int), renewal_warned_at = NULL
        WHERE id = ${p.user_id}`
      return { granted: true, userId: p.user_id }
    })
  }

  /**
   * Watcher days that did not come from a purchase (a credit code, an invite)
   * go down the same path a purchase does: a settled $0 payment row that
   * extends plan_until. So the plan has one source of truth, the payments
   * table shows where the days came from, and nothing else needs to know.
   */
  async grantPlanDays(userId: string, days: number, source: { product: string; chain: string; raw: unknown }): Promise<boolean> {
    if (!(days >= 1)) return false
    const ref = `${source.chain}:${userId}:${Date.now()}:${randomBytes(4).toString('hex')}`
    await this.recordPayment({ ref, user_id: userId, product: source.product.slice(0, 60), amount_cents: 0, chain: source.chain, raw: source.raw })
    return (await this.settlePayment(ref, 'credit', source.raw, true, () => Math.floor(days))).granted
  }

  /** Paid plans that end within `withinMs` and have not been warned this period. */
  async renewalsDue(withinMs: number): Promise<User[]> {
    return (await this.sql.unsafe(
      `SELECT ${USER_COLS} FROM users WHERE plan = 'watcher' AND plan_until BETWEEN $1 AND $2 AND renewal_warned_at IS NULL`,
      [this.now(), new Date(this.now().getTime() + withinMs)],
    )) as User[]
  }

  async markRenewalWarned(userId: string): Promise<void> {
    await this.sql`UPDATE users SET renewal_warned_at = ${this.now()} WHERE id = ${userId}`
  }
}
