/**
 * How we reach people: email (Resend) and web push for everyone; on paid
 * plans a phone call (Telnyx Call Control) that says what moved and asks for
 * 1 to acknowledge, and a signed webhook to a URL of their choosing.
 *
 * Every channel is best effort and independent: one failing never stops the
 * others. Without RESEND_API_KEY mail is written to the log, which is what a
 * local `watchwallet serve` wants.
 */
import { createHmac } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import webpush from 'web-push'
import type { Store, User } from './db.js'

export type Mail = { to: string; subject: string; text: string; html?: string; replyTo?: string }
export type Notifier = {
  mail(m: Mail): Promise<boolean>
  push(user: User, payload: { title: string; body: string; url: string; ack?: string }): Promise<number>
  call(phone: string, alertId: string): Promise<boolean>
  webhook(url: string, secret: string, body: unknown): Promise<boolean>
  readonly callsEnabled: boolean
  readonly vapidPublic: string
}

export type NotifyConfig = {
  resendKey?: string
  mailFrom: string
  vapidPublic?: string
  vapidPrivate?: string
  vapidSubject: string
  telnyxKey?: string
  telnyxConnection?: string
  telnyxFrom?: string
  /** Where Telnyx sends call events: a public URL (the relay, never the Moshpit name). */
  callHook: string
}

export function notifyConfig(env: Record<string, string | undefined> = process.env, publicOrigin: string): NotifyConfig {
  return {
    resendKey: env.RESEND_API_KEY,
    mailFrom: env.MAIL_FROM ?? 'watch.wallet <alerts@pit.world>',
    vapidPublic: env.VAPID_PUBLIC_KEY,
    vapidPrivate: env.VAPID_PRIVATE_KEY,
    vapidSubject: env.VAPID_SUBJECT ?? 'mailto:alerts@pit.world',
    telnyxKey: env.TELNYX_API_KEY,
    telnyxConnection: env.TELNYX_CONNECTION_ID,
    telnyxFrom: env.TELNYX_FROM,
    callHook: `${publicOrigin}/hooks/telnyx`,
  }
}

/** `t=<unix>,v1=<hex HMAC-SHA256 of "t.body">`, the header we send as x-watchwallet-signature. */
export function signWebhook(secret: string, body: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  return `t=${nowSeconds},v1=${createHmac('sha256', secret).update(`${nowSeconds}.${body}`).digest('hex')}`
}

/** Loopback, private, link-local, CGNAT and unique-local addresses: never a webhook target. */
export function privateAddress(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^::ffff:/, '')
  if (isIP(v) === 4) {
    const [a, b] = v.split('.').map(Number) as [number, number]
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224
  }
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')
}

export type Resolver = (host: string) => Promise<string[]>
const dnsResolve: Resolver = async (host) => (await lookup(host, { all: true })).map((r) => r.address)

/**
 * A webhook URL we are willing to POST to: https, a real hostname, and every
 * address it resolves to public. Checked when it is saved and again before
 * each send (a name can be pointed somewhere else later).
 */
export async function webhookUrlError(url: string, resolve: Resolver = dnsResolve): Promise<string | null> {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return 'That is not a URL.'
  }
  if (u.protocol !== 'https:') return 'Use an https:// URL.'
  if (u.username || u.password) return 'Leave the user and password out of the URL.'
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (/^(localhost|.*\.(local|localhost|internal|lan|home))$/i.test(host)) return 'That host is not reachable from the internet.'
  try {
    const ips = isIP(host) ? [host] : await resolve(host)
    if (!ips.length || ips.some(privateAddress)) return 'That host points at a private address.'
  } catch {
    return 'That host does not resolve.'
  }
  return null
}

export function createNotifier(cfg: NotifyConfig, store: Store, fetcher: typeof fetch = fetch, log: (line: string) => void = console.log, resolve: Resolver = dnsResolve): Notifier {
  const pushOn = Boolean(cfg.vapidPublic && cfg.vapidPrivate)
  if (pushOn) webpush.setVapidDetails(cfg.vapidSubject, cfg.vapidPublic!, cfg.vapidPrivate!)
  const callsEnabled = Boolean(cfg.telnyxKey && cfg.telnyxConnection && cfg.telnyxFrom)

  return {
    callsEnabled,
    vapidPublic: cfg.vapidPublic ?? '',

    async mail(m) {
      if (!cfg.resendKey) {
        log(`[mail] to=${m.to} subject=${JSON.stringify(m.subject)}\n${m.text}`)
        return true
      }
      try {
        const res = await fetcher('https://api.resend.com/emails', {
          method: 'POST',
          headers: { authorization: `Bearer ${cfg.resendKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from: cfg.mailFrom, to: [m.to], subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}), ...(m.replyTo ? { reply_to: m.replyTo } : {}) }),
          signal: AbortSignal.timeout(15_000),
        })
        if (!res.ok) log(`[mail] resend ${res.status} for ${m.to}: ${(await res.text()).slice(0, 200)}`)
        return res.ok
      } catch (e) {
        log(`[mail] failed for ${m.to}: ${e instanceof Error ? e.message : e}`)
        return false
      }
    },

    async push(user, payload) {
      if (!pushOn) return 0
      let sent = 0
      for (const sub of await store.pushSubs(user.id)) {
        try {
          await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), { TTL: 3_600, urgency: 'high' })
          sent += 1
        } catch (e: any) {
          // 404/410: the browser dropped the subscription; forget it.
          if (e?.statusCode === 404 || e?.statusCode === 410) await store.dropPush(sub.endpoint)
          else log(`[push] ${e?.statusCode ?? ''} ${e?.message ?? e}`)
        }
      }
      return sent
    },

    async call(phone, alertId) {
      if (!callsEnabled || !/^\+[1-9]\d{7,14}$/.test(phone)) return false
      try {
        const res = await fetcher('https://api.telnyx.com/v2/calls', {
          method: 'POST',
          headers: { authorization: `Bearer ${cfg.telnyxKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ connection_id: cfg.telnyxConnection, to: phone, from: cfg.telnyxFrom, webhook_url: cfg.callHook, timeout_secs: 45 }),
          signal: AbortSignal.timeout(15_000),
        })
        const body = (await res.json().catch(() => ({}))) as any
        const callId = body?.data?.call_control_id
        if (!res.ok || !callId) {
          log(`[call] telnyx ${res.status}: ${JSON.stringify(body).slice(0, 200)}`)
          return false
        }
        await store.recordCall(callId, alertId)
        return true
      } catch (e) {
        log(`[call] failed: ${e instanceof Error ? e.message : e}`)
        return false
      }
    },

    async webhook(url, secret, payload) {
      const bad = await webhookUrlError(url, resolve)
      if (bad) {
        log(`[webhook] refused ${url}: ${bad}`)
        return false
      }
      const body = JSON.stringify(payload)
      try {
        const res = await fetcher(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': 'watch.wallet-webhook/1', 'x-watchwallet-signature': signWebhook(secret, body) },
          body,
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
        })
        if (!res.ok) log(`[webhook] ${new URL(url).host} answered ${res.status}`)
        return res.ok
      } catch (e) {
        log(`[webhook] ${new URL(url).host} failed: ${e instanceof Error ? e.message : e}`)
        return false
      }
    },
  }
}

/** Telnyx Call Control: answer -> speak and gather one digit -> 1 acknowledges. */
export async function telnyxCommand(cfg: NotifyConfig, callId: string, command: 'gather_using_speak' | 'speak' | 'hangup', body: object, fetcher: typeof fetch = fetch): Promise<void> {
  await fetcher(`https://api.telnyx.com/v2/calls/${encodeURIComponent(callId)}/actions/${command}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.telnyxKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => {})
}
