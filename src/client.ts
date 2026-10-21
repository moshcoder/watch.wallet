/**
 * The watch.wallet API from anywhere: the CLI, the TUI and the MCP server use this.
 * WATCHWALLET_URL points it at another instance; WATCHWALLET_KEY (ww_…) is your key
 * from /me, or the one `watchwallet login` saved in ~/.config/watchwallet/key.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type ApiWatch = {
  id: string
  kind: 'address' | 'price'
  label: string
  name: string
  state: 'active' | 'paused'
  paused_reason: string
  chain: string | null
  address: string
  coin: string
  direction: string
  level_usd: number
  min_usd: number
  call: boolean
  balances: Record<string, string> | null
  balances_text: string | null
  price: number | null
  armed: boolean
  last_checked_at: string | null
  last_change_at: string | null
  fail_count: number
  last_error: string
  url: string
}
export type ApiAlert = { id: string; watch_id: string; at: string; kind: string; summary: string; usd: number | null; acked_at: string | null; acked_via: string }
export type ApiMe = { email: string; name: string; plan: string; paid: boolean; limits: { watches: number; everyMs: number }; watches: ApiWatch[] }
export type ApiCheck = { chain: string; address: string; rows: { asset: string; amount: string; usd: number | null }[]; pending: boolean }

export const KEY_FILE = join(homedir(), '.config', 'watchwallet', 'key')
export const DEFAULT_URL = 'https://watch.wallet.pit.world'

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

function savedKey(): string | undefined {
  try {
    return existsSync(KEY_FILE) ? readFileSync(KEY_FILE, 'utf8').trim() || undefined : undefined
  } catch {
    return undefined
  }
}

export type Via = 'cli' | 'mcp' | 'tui' | 'api'

export class WatchClient {
  readonly base: string
  constructor(base = process.env.WATCHWALLET_URL ?? DEFAULT_URL, readonly key: string | undefined = process.env.WATCHWALLET_KEY ?? savedKey(), private readonly doFetch: typeof fetch = fetch) {
    this.base = base.replace(/\/+$/, '')
  }

  async call<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    if (auth && !this.key) throw new ApiError(`No key. Make one at ${this.base}/me#account, then: watchwallet login ww_…`, 401)
    const res = await this.doFetch(this.base + path, {
      method,
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(auth ? { authorization: `Bearer ${this.key}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    })
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    if (!res.ok) throw new ApiError(data.error ?? `watch.wallet answered ${res.status}`, res.status)
    return data as T
  }

  me = () => this.call<ApiMe>('GET', '/api/v1/me')
  watches = () => this.call<{ watches: ApiWatch[] }>('GET', '/api/v1/watches').then((r) => r.watches)
  addAddress = (input: { chain: string; address: string; label?: string; min_usd?: number; call?: boolean }) => this.call<ApiWatch>('POST', '/api/v1/watches', { kind: 'address', ...input })
  addPrice = (input: { coin: string; direction: 'above' | 'below'; level_usd: number; label?: string; call?: boolean }) => this.call<ApiWatch>('POST', '/api/v1/watches', { kind: 'price', ...input })
  update = (id: string, input: { label?: string; min_usd?: number; call?: boolean; level_usd?: number; direction?: string }) => this.call<ApiWatch>('PATCH', `/api/v1/watches/${encodeURIComponent(id)}`, input)
  remove = (id: string) => this.call<{ ok: true }>('DELETE', `/api/v1/watches/${encodeURIComponent(id)}`)
  pause = (id: string) => this.call<ApiWatch>('POST', `/api/v1/watches/${encodeURIComponent(id)}/pause`)
  resume = (id: string) => this.call<ApiWatch>('POST', `/api/v1/watches/${encodeURIComponent(id)}/resume`)
  alerts = (limit = 20) => this.call<{ alerts: ApiAlert[] }>('GET', `/api/v1/alerts?limit=${limit}`).then((r) => r.alerts)
  ack = (via: Via, alertId?: string, watchId?: string) =>
    (alertId
      ? this.call<{ acknowledged: number }>('POST', `/api/v1/alerts/${encodeURIComponent(alertId)}/ack`, { via })
      : this.call<{ acknowledged: number }>('POST', '/api/v1/alerts/ack', { via, ...(watchId ? { watch_id: watchId } : {}) })
    ).then((r) => r.acknowledged)

  /** One look at any address; needs no key. */
  check = (chain: string, address: string) => this.call<ApiCheck>('GET', `/api/v1/check?chain=${encodeURIComponent(chain)}&address=${encodeURIComponent(address)}`, undefined, false)

  /** Resolve a watch by id or (unique) label. */
  async find(idOrLabel: string): Promise<ApiWatch> {
    const all = await this.watches()
    const q = idOrLabel.toLowerCase()
    const hit = all.find((w) => w.id === idOrLabel) ?? all.find((w) => w.label.toLowerCase() === q) ?? all.find((w) => w.name.toLowerCase() === q) ?? all.find((w) => w.address === q)
    if (!hit) throw new ApiError(`no watch "${idOrLabel}" (you have: ${all.map((w) => w.name).join(', ') || 'none'})`, 404)
    return hit
  }
}

/** One line per watch, for the CLI and the TUI. */
export function watchText(w: ApiWatch): string {
  const state = w.state === 'paused' ? 'paused' : w.fail_count > 2 ? "can't read" : w.kind === 'price' ? (w.armed ? 'armed' : 'fired') : w.balances ? 'watching' : 'first read soon'
  const what = w.kind === 'price' ? `${w.coin} ${w.direction} $${w.level_usd} (now ${w.price === null ? '-' : `$${w.price}`})` : (w.balances_text ?? '')
  return `${w.name.slice(0, 28).padEnd(28)} ${state.padEnd(15)} ${what}`
}
