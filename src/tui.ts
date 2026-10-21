/**
 * `watchwallet` with no arguments: your watches with live balances.
 *
 * ↑/↓ picks a watch, a acknowledges its open alerts (A: all of them),
 * p pauses or resumes, r reloads, q quits. It reloads on its own every 30 s.
 */
import { createApp } from '@profullstack/hqtui'
import { WatchClient, watchText, type ApiAlert, type ApiMe } from './client.js'

export type TuiState = { me: ApiMe | null; alerts: ApiAlert[]; at: number; busy: boolean; message: string; error: string | null }
export const initialState = (): TuiState => ({ me: null, alerts: [], at: 0, busy: false, message: '', error: null })

/** Pure key handling, testable without a terminal. */
export function onKey(s: TuiState, key: { name: string; key: string; char?: string }): 'quit' | 'ack' | 'ack-all' | 'toggle' | 'reload' | null {
  const n = s.me?.watches.length ?? 0
  if (key.key === 'ctrl+c' || key.name === 'escape' || key.char === 'q') return 'quit'
  if (key.name === 'down' || key.char === 'j') return n && (s.at = (s.at + 1) % n), null
  if (key.name === 'up' || key.char === 'k') return n && (s.at = (s.at + n - 1) % n), null
  if (key.char === 'a') return n ? 'ack' : null
  if (key.char === 'A') return 'ack-all'
  if (key.char === 'p') return n ? 'toggle' : null
  if (key.char === 'r') return 'reload'
  return null
}

export const openAlerts = (s: TuiState, watchId: string) => s.alerts.filter((a) => a.watch_id === watchId && !a.acked_at).length

export async function runTui(client = new WatchClient()): Promise<void> {
  const s = initialState()
  const app = await createApp({ title: 'watch.wallet', quitKeys: [] })
  const run = async (label: string, fn: () => Promise<unknown>) => {
    s.busy = true
    s.error = null
    app.invalidate()
    try {
      await fn()
      ;[s.me, s.alerts] = await Promise.all([client.me(), client.alerts(50)])
      s.message = label
    } catch (e) {
      s.error = e instanceof Error ? e.message : String(e)
    } finally {
      s.busy = false
      app.invalidate()
    }
  }
  void run('', async () => {})
  const timer = setInterval(() => !s.busy && void run(s.message, async () => {}), 30_000)
  app.on('key', (event: any) => {
    const action = onKey(s, event)
    const cur = s.me?.watches[s.at]
    if (action === 'quit') {
      clearInterval(timer)
      app.quit()
    } else if (action === 'ack' && cur) void run(`Acknowledged ${cur.name}.`, () => client.ack('tui', undefined, cur.id))
    else if (action === 'ack-all') void run('Acknowledged everything.', () => client.ack('tui'))
    else if (action === 'toggle' && cur) void run(cur.state === 'paused' ? `Resumed ${cur.name}.` : `Paused ${cur.name}.`, () => (cur.state === 'paused' ? client.resume(cur.id) : client.pause(cur.id)))
    else if (action === 'reload') void run('Reloaded.', async () => {})
    app.invalidate()
  })
  app.render(({ ui, theme }: any) => {
    ui.row({ size: 1 }, (h: any) => {
      h.text(' watch.wallet', { fg: theme.accent, bold: true, size: 14 })
      h.text(s.me ? `${s.me.email} · ${s.me.plan}` : 'loading…', { fg: theme.muted })
      h.text(`${client.base.replace(/^https?:\/\//, '')} `, { fg: theme.muted, align: 'right' })
    })
    ui.panel({ title: 'Watches' }, (p: any) => {
      if (s.error) p.text(s.error, { fg: theme.danger ?? theme.accent })
      const list = s.me?.watches ?? []
      if (s.me && !list.length) p.text('Nothing watched yet: watchwallet add ethereum 0x…', { fg: theme.muted })
      list.forEach((w, i) => {
        const open = openAlerts(s, w.id)
        p.text(`${i === s.at ? '›' : ' '} ${watchText(w)}${open ? `  ${open} OPEN` : ''}`, {
          fg: i === s.at ? theme.accent : open || w.fail_count > 2 ? (theme.danger ?? theme.text) : theme.text,
          bold: i === s.at || open > 0,
        })
      })
    })
    ui.panel({ title: 'Recent alerts' }, (p: any) => {
      const recent = s.alerts.slice(0, 8)
      if (!recent.length) p.text('None yet.', { fg: theme.muted })
      for (const a of recent) p.text(`${a.at.slice(5, 16).replace('T', ' ')} ${a.acked_at ? ' ' : '●'} ${a.summary}`, { fg: a.acked_at ? theme.muted : (theme.danger ?? theme.text) })
      if (s.message) p.text(s.message, { fg: theme.muted })
    })
    ui.statusBar({ items: [{ key: 'a', label: 'acknowledge' }, { key: 'A', label: 'all' }, { key: 'p', label: 'pause/resume' }, { key: 'r', label: 'reload' }, { key: 'q', label: 'quit' }], right: [{ label: s.busy ? 'working…' : 'read only' }] })
  })
  await app.start()
}
