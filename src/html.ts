/**
 * Server-rendered pages. One script (public/app.js) turns on push; every
 * page works without it.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { INVITE_DAYS, INVITES_PER_PERSON } from './codes.js'
import { CHAIN_INFO, CHAINS, shortAddress, type Chain } from './chains.js'
import type { Alert, Payment, User, Watch } from './db.js'
import { describeBalances, usd } from './engine.js'
import { pitFooter } from './pit-footer.js'
import { CHAIN_LABELS, dollars, PRODUCTS, type Limits } from './plans.js'
import { ringFooter } from './ring-footer.js'
import { RING_PLACEHOLDER } from './ring.js'
import { watchName } from './worker.js'

export const SITE = 'https://watch.wallet.pit.world'
export const REPO = 'https://github.com/moshcoder/watch.wallet'

/** crawlproof analytics, on public pages only (never on a dashboard). */
const TRACKER = process.env.CRAWLPROOF_SITE ? `<script data-site="${process.env.CRAWLPROOF_SITE}" src="https://crawlproof.com/stats.js" async></script>` : ''

const asset = (name: string) => {
  const body = readFileSync(new URL(`../public/${name}`, import.meta.url))
  return `/${name}?v=${createHash('sha256').update(body).digest('hex').slice(0, 10)}`
}
const STYLE_URL = asset('style.css')
const SCRIPT_URL = asset('app.js')

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]!)
const stamp = (d: Date | number | null) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '-')
const day = (d: Date | number | null) => (d ? new Date(d).toISOString().slice(0, 10) : '-')

export function ago(d: Date | null, now = Date.now()): string {
  if (!d) return 'never'
  const s = Math.max(0, Math.round((now - d.getTime()) / 1000))
  if (s < 90) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  if (s < 172_800) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86_400)} days ago`
}

const LOGO = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><path d="M3 16c3.4-5.6 7.8-8.5 13-8.5S25.6 10.4 29 16c-3.4 5.6-7.8 8.5-13 8.5S6.4 21.6 3 16z" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"/><circle cx="16" cy="16" r="4.2" fill="currentColor"/></svg>`

export type Ctx = { user: User | null; csrf: string; origin: string }
type LayoutOptions = { title: string; description: string; path: string; body: string; ctx: Ctx; noindex?: boolean; script?: boolean; track?: boolean }

function layout(o: LayoutOptions): string {
  const signedIn = Boolean(o.ctx.user)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<meta name="referrer" content="strict-origin-when-cross-origin">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#07090c">
${o.noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${esc(SITE + o.path)}">`}
<meta property="og:type" content="website">
<meta property="og:site_name" content="watch.wallet">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="stylesheet" href="${STYLE_URL}">
${o.script ? `<script src="${SCRIPT_URL}" defer></script>` : ''}
${o.track ? TRACKER : ''}
</head>
<body>
${RING_PLACEHOLDER}
<header class="top">
  <a class="brand" href="/">${LOGO}<span>watch<b>.</b>wallet</span></a>
  <nav aria-label="Site">
    <a href="/check">Check an address</a>
    <a href="/help">Help</a>
    <a href="/plans">Plans</a>
    ${signedIn ? `<a href="/me">My watches</a><form method="post" action="/auth/logout"><input type="hidden" name="csrf" value="${esc(o.ctx.csrf)}"><button class="linkish">Sign out</button></form>` : '<a href="/signin">Sign in</a>'}
  </nav>
</header>
<main>
${o.body}
</main>
${ringFooter()}
${pitFooter()}
</body>
</html>`
}

const csrfField = (ctx: Ctx) => `<input type="hidden" name="csrf" value="${esc(ctx.csrf)}">`
const chainOptions = (current?: string) => CHAINS.map((c) => `<option value="${c}"${c === current ? ' selected' : ''}>${esc(CHAIN_INFO[c].label)}</option>`).join('')

export function homePage(ctx: Ctx): string {
  return layout({
    ctx,
    track: true,
    title: 'watch.wallet: know the second your wallet moves',
    description: 'Watch any address on Bitcoin, Ethereum, Base, Polygon or Solana, or a price, and get an email, a push, or a phone call that wakes you up.',
    path: '/',
    body: `<section class="hero">
  <h1>Know the second<br>your wallet moves.</h1>
  <p class="tag">Watch any address on Bitcoin, Ethereum, Base, Polygon or Solana, or a price, and get an email, a push, or a phone call that wakes you up.</p>
  <a class="btn big" href="${ctx.user ? '/me' : '/signin'}">${ctx.user ? 'My watches' : 'Start watching, free'}</a>
  <p class="muted small">Sign in with just your email. Three watches are free. No keys, no wallet connect: we only read public balances.</p>
</section>
<div class="grid3">
  <div class="card"><h2><span class="step-n">1</span>Paste an address</h2><p class="muted">Your cold wallet, the company treasury, the multisig, the address you think was compromised. Any chain we list, no signature needed.</p></div>
  <div class="card"><h2><span class="step-n">2</span>We read it</h2><p class="muted">Every minute on Watcher, every 15 on free. The native coin, USDC and USDT. A Bitcoin transaction counts as soon as it hits the mempool.</p></div>
  <div class="card"><h2><span class="step-n">3</span>It moves, you know</h2><p class="muted">Email and a push straight away. On Watcher, a phone call that rings until you pick up, and a signed webhook for your bots.</p></div>
</div>
<div class="card">
  <h2>Why a phone call</h2>
  <p>A drained wallet is drained in minutes, often at night. An email you read at breakfast is too late to move what is left. A phone call wakes you up, says what moved and how much, and you press 1 to say you saw it.</p>
  <p class="muted small">Also good for: price levels (BTC below $60,000, ETH above $5,000), a treasury that should never move without a meeting, and an exchange deposit you are waiting on.</p>
</div>
<form class="card" method="get" action="/check">
  <h2>Try it: look up any address</h2>
  <div class="row"><select name="chain">${chainOptions('ethereum')}</select><input name="address" required placeholder="0x…, bc1…, or a Solana address"><button class="btn ghost">Check</button></div>
  <p class="muted small">Free, no sign-in. One look, no alerts.</p>
</form>
${plansTable(ctx)}
<div class="card" id="agents">
  <h2>For agents and bots</h2>
  <pre>bunx @profullstack/watchwallet check ethereum 0x…        # one balance, no key
bunx @profullstack/watchwallet add base 0x… --label=Treasury
claude mcp add watchwallet -- bunx @profullstack/watchwallet mcp</pre>
  <p class="muted small">Every alert can POST a signed JSON webhook to your URL. Full API, CLI and MCP on the <a href="/help#api">help page</a>.</p>
</div>`,
  })
}

function plansTable(ctx: Ctx): string {
  return `<div class="card" id="plans">
  <h2>Plans</h2>
  <div class="grid2">
    <div class="plan"><h3>Free</h3><p class="price">$0</p><ul><li>3 watches</li><li>Checked every 15 minutes</li><li>Email and push</li></ul></div>
    <div class="plan featured"><h3>Watcher</h3><p class="price">${dollars(PRODUCTS.month.cents)}<span class="muted">/30 days</span> <span class="muted small">or ${dollars(PRODUCTS.year.cents)} a year</span></p><ul><li>50 watches</li><li>Checked every minute</li><li>Phone calls that wake you up</li><li>Signed webhooks</li><li>Only alert above a dollar amount</li></ul>
    <a class="btn" href="${ctx.user ? '/plans' : '/signin?next=/plans'}">Get Watcher</a></div>
  </div>
  <p class="muted small">Paid once in crypto through <a href="https://coinpayportal.com">CoinPay</a>. No subscription: pay again to extend. If it lapses nothing is deleted; your first three watches keep running on the free plan.</p>
</div>`
}

export function helpPage(ctx: Ctx): string {
  const tokens = CHAINS.map((c) => `<li><b>${esc(CHAIN_INFO[c].label)}</b>: ${esc([CHAIN_INFO[c].native, ...CHAIN_INFO[c].tokens.map((t) => t.symbol)].join(', '))}</li>`).join('')
  return layout({
    ctx,
    track: true,
    title: 'Help · watch.wallet',
    description: 'How watch.wallet reads balances, when it alerts, the phone call, webhooks, and the API, CLI and MCP.',
    path: '/help',
    body: `<section class="hero"><h1>Help</h1><p class="tag">Everything about watch.wallet on one page.</p></section>
<div class="card"><h2>What we watch</h2>
<ul>${tokens}</ul>
<p>We read public balances from public sources: <a href="https://mempool.space">mempool.space</a> for Bitcoin, public RPC nodes for Ethereum, Base, Polygon and Solana, and <a href="https://www.coinbase.com">Coinbase</a> for prices. You never connect a wallet or sign anything.</p></div>
<div class="card"><h2>When it alerts</h2>
<ul>
  <li>The first read of a new watch is the baseline. After that, any change in any of the balances above is a move.</li>
  <li>Bitcoin counts a transaction as soon as it is in the mempool, before it confirms.</li>
  <li>With a dollar threshold (Watcher), we alert once the total moved since the last alert is worth at least that much. Small moves add up: ten $90 withdrawals still reach a $500 threshold.</li>
  <li>A read that fails (a node is down, a rate limit) never alerts. We try again and back off a source that keeps failing.</li>
  <li>A price watch fires once when the price reaches your level, then waits until the price is back on the other side (by half a percent) before it can fire again.</li>
</ul></div>
<div class="card"><h2>The phone call</h2><p>On Watcher, tick "call me" on a watch and save your number. When it alerts we call: "watch.wallet alert: Cold wallet moved 0.5 E T H out. Press 1 to acknowledge." Pressing 1 marks the alert as seen. You can also acknowledge from the email, the push notification, the web, the CLI or the TUI.</p></div>
<div class="card" id="webhooks"><h2>Webhooks</h2>
<p>On Watcher, set a webhook URL on <a href="/me#webhook">your page</a>. Every alert POSTs JSON to it:</p>
<pre>{ "event": "watch.alert",
  "alert": { "id": "…", "at": "…", "kind": "address", "summary": "Treasury moved: 0.5 ETH out (~$1,222)", "usd": 1222, "detail": { "changes": [ … ] } },
  "watch": { "id": "…", "label": "Treasury", "chain": "base", "address": "0x…", "url": "${SITE}/w/…" } }</pre>
<p>It carries <code>x-watchwallet-signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</code>, where v1 is HMAC-SHA256 of <code>t + "." + body</code> with your webhook secret. Check it, and refuse a <code>t</code> more than five minutes old.</p>
<pre>const [t, v1] = header.split(',').map((p) => p.split('=')[1])
const ok = crypto.createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest('hex') === v1</pre>
<p class="muted small">Webhook URLs must be https and resolve to a public address.</p></div>
<div class="card" id="api"><h2>API, CLI and MCP</h2>
<p>Make an API key on <a href="/me#account">your page</a>. Then:</p>
<pre>export WATCHWALLET_KEY=ww_…
bunx @profullstack/watchwallet status                              # your watches and last balances
bunx @profullstack/watchwallet add ethereum 0x… --label=Cold --min-usd=100 --call
bunx @profullstack/watchwallet price BTC below 60000
bunx @profullstack/watchwallet alerts                              # recent alerts
bunx @profullstack/watchwallet ack                                 # acknowledge them all
bunx @profullstack/watchwallet rm Cold
bunx @profullstack/watchwallet check solana &lt;address&gt;              # no key needed
bunx @profullstack/watchwallet                                     # the TUI
bunx @profullstack/watchwallet mcp                                 # MCP server on stdio</pre>
<pre>curl "${SITE}/api/v1/check?chain=bitcoin&amp;address=bc1q…"
curl ${SITE}/api/v1/watches -H "authorization: Bearer $WATCHWALLET_KEY"
curl -X POST ${SITE}/api/v1/watches -H "authorization: Bearer $WATCHWALLET_KEY" \\
  -H 'content-type: application/json' -d '{"kind":"address","chain":"base","address":"0x…","label":"Treasury"}'</pre>
<p class="muted small">Endpoints: <code>GET /api/v1/me</code>, <code>GET|POST /api/v1/watches</code>, <code>GET|PATCH|DELETE /api/v1/watches/:id</code>, <code>POST /api/v1/watches/:id/(pause|resume)</code>, <code>GET /api/v1/alerts</code>, <code>POST /api/v1/alerts/ack</code>, <code>POST /api/v1/alerts/:id/ack</code>, and without a key <code>GET /api/v1/check?chain=&amp;address=</code> (rate limited).</p>
<p class="muted small">MCP tools: check_address (no key), list_watches, add_watch, add_price_watch, remove_watch, recent_alerts, redeem_code, create_invite.</p></div>
<div class="card" id="codes"><h2>Codes and invites</h2><p>A credit code someone gave you goes on <a href="/me#code">your page</a> under "Have a code?" (or <code>watchwallet redeem CR-…</code>, or <code>POST /api/v1/redeem {"code"}</code>): it adds days of Watcher, on top of any time you have left. Every account also has ${INVITES_PER_PERSON} single-use invite links (<a href="/invites">Invites</a>); whoever makes a new account through one, and you, each get ${INVITE_DAYS} days of Watcher. Your own link (<code>/?ref=…</code>) is there too, for everyone else.</p></div>
<div class="card"><h2>What we keep</h2><p>Your email, the addresses and prices you watch, their last balances and your alerts. We never ask for a private key or a seed, and nothing here can move funds. Delete your account and it all goes.</p></div>
<div class="card"><h2>Who runs this</h2><p><a href="https://profullstack.com">Profullstack, Inc.</a> Source: <a href="${REPO}">${REPO.replace('https://', '')}</a>. Questions: <a href="mailto:alerts@pit.world">alerts@pit.world</a>.</p></div>`,
  })
}

export function signinPage(ctx: Ctx, o: { next?: string; error?: string; sent?: string } = {}): string {
  return layout({
    ctx,
    noindex: true,
    title: 'Sign in · watch.wallet',
    description: 'Sign in with your email.',
    path: '/signin',
    body: `<section class="hero"><h1>${o.sent ? 'Check your email' : 'Sign in'}</h1></section>
<div class="card narrow">
${o.sent ? `<p>We sent a sign-in link to <b>${esc(o.sent)}</b>. It works once, for 20 minutes.</p><p class="muted small">Nothing there? Check spam, or <a href="/signin">try again</a>.</p>` : `
${o.error ? `<p class="note error">${esc(o.error)}</p>` : ''}
<form method="post" action="/signin" class="stack">
  ${csrfField(ctx)}
  <input type="hidden" name="next" value="${esc(o.next ?? '')}">
  <label>Your email <input type="email" name="email" required autocomplete="email" autofocus></label>
  <button class="btn">Email me a sign-in link</button>
</form>
<p class="muted small">New here? The link makes your account. No password.</p>`}
</div>`,
  })
}

export function confirmSigninPage(ctx: Ctx, t: string, next: string): string {
  return layout({
    ctx,
    noindex: true,
    title: 'Sign in · watch.wallet',
    description: 'Finish signing in.',
    path: '/auth',
    body: `<section class="hero"><h1>Sign in</h1></section>
<div class="card narrow center">
<form method="post" action="/auth/${esc(t)}">
  <input type="hidden" name="next" value="${esc(next)}">
  <button class="btn big">Sign in to watch.wallet</button>
</form>
<p class="muted small">One click, so a mail scanner that opens links can't use yours up.</p>
</div>`,
  })
}

export function messagePage(ctx: Ctx, o: { title: string; message: string; link?: { href: string; label: string } }): string {
  return layout({
    ctx,
    noindex: true,
    title: `${o.title} · watch.wallet`,
    description: o.message,
    path: '/',
    body: `<section class="hero"><h1>${esc(o.title)}</h1><p class="tag">${esc(o.message)}</p>${o.link ? `<a class="btn" href="${esc(o.link.href)}">${esc(o.link.label)}</a>` : ''}</section>`,
  })
}

export function ackPage(ctx: Ctx, t: string, a: Alert): string {
  return layout({
    ctx,
    noindex: true,
    title: 'Acknowledge · watch.wallet',
    description: 'Acknowledge an alert.',
    path: '/a',
    body: `<section class="hero"><h1>${a.acked_at ? 'Already acknowledged' : 'Was this you?'}</h1><p class="tag">${esc(a.summary)}</p>
${a.acked_at ? `<p class="muted">Acknowledged ${esc(stamp(a.acked_at))} via ${esc(a.acked_via)}.</p>` : `<form method="post" action="/a/${esc(t)}"><button class="btn big">Yes, I saw it</button></form>
<p class="muted small">If it was not you: move what is left to a wallet whose keys were never near this one, now.</p>`}</section>`,
  })
}

function watchStatus(w: Watch): string {
  if (w.state === 'paused') return `<span class="status pending">paused${w.paused_reason === 'plan' ? ' (plan)' : ''}</span>`
  if (w.fail_count > 2) return `<span class="status failed" title="${esc(w.last_error)}">can't read: retrying</span>`
  if (w.kind === 'price') return w.armed ? '<span class="status paid">armed</span>' : '<span class="status detected">fired, waiting to re-arm</span>'
  if (!w.baseline) return '<span class="status pending">first read soon</span>'
  return '<span class="status paid">watching</span>'
}

export function watchLine(w: Watch, now = Date.now()): string {
  if (w.kind === 'price') return `${esc(w.coin)} ${esc(w.direction)} ${esc(usd(w.level_usd))} · now ${w.price === null ? '-' : esc(usd(w.price))}`
  return `${esc(CHAIN_INFO[w.chain as Chain].label)} <code>${esc(shortAddress(w.address))}</code> · ${esc(describeBalances(w.chain as Chain, w.balances))} · last move ${esc(ago(w.last_change_at, now))}`
}

function alertRows(ctx: Ctx, alerts: Alert[], names: Map<string, string>): string {
  if (!alerts.length) return '<p class="muted">No alerts yet. That is the good outcome.</p>'
  return `<ul class="alerts">${alerts
    .map(
      (a) => `<li class="${a.acked_at ? '' : 'open'}"><span class="muted small">${esc(stamp(a.at))}${names.get(a.watch_id) ? ` · <a href="/w/${esc(a.watch_id)}">${esc(names.get(a.watch_id))}</a>` : ''}</span><br>${esc(a.summary)}
      ${a.acked_at ? `<span class="muted small"> · seen via ${esc(a.acked_via)}</span>` : `<form method="post" action="/alerts/${esc(a.id)}/ack" class="inline">${csrfField(ctx)}<button class="linkish ok">acknowledge</button></form>`}</li>`,
    )
    .join('')}</ul>`
}

export type DashboardData = {
  watches: Watch[]
  alerts: Alert[]
  limits: Limits
  plan: string
  paid: boolean
  callsEnabled: boolean
  vapid: string
  apiKey?: string
  flash?: string
  error?: string
  now: number
}

export function dashboardPage(ctx: Ctx, d: DashboardData): string {
  const user = ctx.user!
  const names = new Map(d.watches.map((w) => [w.id, watchName(w)]))
  const rows = d.watches.map((w) => `<li><a href="/w/${esc(w.id)}"><b>${esc(watchName(w))}</b></a> ${watchStatus(w)}${w.call ? ' <span class="muted small">· calls</span>' : ''}<br><span class="muted small">${watchLine(w, d.now)}</span></li>`).join('')
  const open = d.alerts.filter((a) => !a.acked_at).length
  const room = d.watches.length < d.limits.watches
  const paidOnly = d.paid ? '' : ' disabled'
  return layout({
    ctx,
    noindex: true,
    script: true,
    title: 'My watches · watch.wallet',
    description: 'Your watches.',
    path: '/me',
    body: `${d.flash ? `<p class="note">${esc(d.flash)}</p>` : ''}${d.error ? `<p class="note error">${esc(d.error)}</p>` : ''}
<section class="hero left"><h1>My watches</h1><p class="muted">${esc(user.email)} · ${esc(d.plan)} · ${d.watches.length} of ${d.limits.watches} watches · checked every ${d.limits.everyMs / 60_000} min</p></section>
<div class="card">
  ${rows ? `<ul class="watches">${rows}</ul>` : '<p>Nothing watched yet. Add an address or a price below.</p>'}
</div>
${room ? `<div class="card" id="add">
  <h2>Watch an address</h2>
  <form method="post" action="/w" class="stack">
    ${csrfField(ctx)}<input type="hidden" name="kind" value="address">
    <label>Chain <select name="chain">${chainOptions()}</select></label>
    <label>Address <input name="address" required autocomplete="off" spellcheck="false" placeholder="0x…, bc1…, or a Solana address"></label>
    <label>Label <span class="muted">(optional)</span><input name="label" maxlength="60" placeholder="Cold wallet"></label>
    <label>Only alert when the move is worth at least <span class="muted">(USD, Watcher)</span><input name="min_usd" type="number" min="0" step="any" placeholder="0 = any move"${paidOnly}></label>
    <label><input type="checkbox" name="call" value="1"${paidOnly}> Call me when it moves <span class="muted">(Watcher)</span></label>
    <button class="btn">Watch it</button>
  </form>
  <details><summary>Watch a price instead</summary>
  <form method="post" action="/w" class="stack">
    ${csrfField(ctx)}<input type="hidden" name="kind" value="price">
    <div class="row"><input name="coin" required maxlength="10" placeholder="BTC" value="BTC"><select name="direction"><option value="below">goes below</option><option value="above">goes above</option></select><input name="level_usd" type="number" min="0" step="any" required placeholder="60000"></div>
    <label>Label <span class="muted">(optional)</span><input name="label" maxlength="60"></label>
    <label><input type="checkbox" name="call" value="1"${paidOnly}> Call me when it fires <span class="muted">(Watcher)</span></label>
    <button class="btn ghost">Watch the price</button>
  </form></details>
</div>` : `<p class="muted small">Your plan holds ${d.limits.watches} watches. ${d.paid ? '' : '<a href="/plans">Watcher</a> holds 50.'}</p>`}
<div class="card" id="alerts">
  <h2>Recent alerts</h2>
  ${open > 1 ? `<form method="post" action="/alerts/ack">${csrfField(ctx)}<button class="btn ghost">Acknowledge all ${open}</button></form>` : ''}
  ${alertRows(ctx, d.alerts, names)}
</div>
<div class="card" id="devices">
  <h2>Push on this device</h2>
  <p class="muted">Alerts on your lock screen, with an Acknowledge button. On iPhone add this site to your home screen first.</p>
  <button class="btn ghost" id="push-on" data-vapid="${esc(d.vapid)}"${d.vapid ? '' : ' disabled'}>Turn on notifications here</button>
  <p class="muted small" id="push-status"></p>
</div>
<div class="card" id="phone">
  <h2>Phone calls</h2>
  ${d.paid ? (d.callsEnabled ? '<p class="muted small">We call this number for watches marked "call me".</p>' : '<p class="muted small">Calls are being set up; we start calling once they are live.</p>') : '<p class="muted small">A Watcher feature. Save your number now and it starts working when you upgrade.</p>'}
  <form method="post" action="/me/phone" class="row">
    ${csrfField(ctx)}
    <input name="phone" type="tel" placeholder="+15551234567" value="${esc(user.phone)}" pattern="\\+[1-9][0-9]{7,14}" title="International format, like +15551234567">
    <button class="btn ghost">Save</button>
  </form>
</div>
<div class="card" id="webhook">
  <h2>Webhook</h2>
  <p class="muted small">${d.paid ? 'Every alert is POSTed here as signed JSON.' : 'A Watcher feature: save it now, it starts with your plan.'} <a href="/help#webhooks">Format and signature</a>.</p>
  <form method="post" action="/me/webhook" class="row">
    ${csrfField(ctx)}
    <input name="webhook_url" type="url" placeholder="https://example.com/hooks/watchwallet" value="${esc(user.webhook_url)}">
    <button class="btn ghost">Save</button>
  </form>
  ${user.webhook_secret ? `<p class="small">Signing secret: <code>${esc(user.webhook_secret)}</code></p><form method="post" action="/me/webhook-secret">${csrfField(ctx)}<button class="linkish">make a new secret</button></form>` : ''}
</div>
<div class="card" id="code">
  <h2>Have a code?</h2>
  <p class="muted small">A credit code adds days of Watcher, on top of any time you have left.</p>
  <form method="post" action="/me/redeem" class="row">${csrfField(ctx)}<input name="code" maxlength="80" required autocomplete="off" spellcheck="false" placeholder="CR-XXXX-XXXX-XXXX-XXXX" aria-label="Credit code"><button class="btn ghost">Redeem</button></form>
  <p class="muted small">You also have a few single-use invite links: whoever joins through one, and you, each get ${INVITE_DAYS} days of Watcher. <a href="/invites">Your invites</a></p>
</div>
<div class="card" id="account">
  <h2>Account</h2>
  <form method="post" action="/me/name" class="row">${csrfField(ctx)}<input name="name" maxlength="80" placeholder="Your name" value="${esc(user.name)}"><button class="btn ghost">Save</button></form>
  ${d.apiKey ? `<p class="note">Your API key (shown once): <code>${esc(d.apiKey)}</code></p>` : ''}
  <form method="post" action="/me/key">${csrfField(ctx)}<button class="btn ghost">${d.apiKey ? 'Make another key' : 'Make an API key'}</button></form>
  <p class="muted small">For the CLI, the API and MCP. A new key replaces the old one.</p>
  <details><summary class="bad">Delete my account</summary>
    <form method="post" action="/me/delete" class="stack">${csrfField(ctx)}<p>This deletes every watch and alert. We stop watching at once.</p><label><input type="checkbox" name="sure" value="1" required> Yes, delete everything</label><button class="btn danger">Delete my account</button></form>
  </details>
</div>`,
  })
}

export type WatchData = { w: Watch; alerts: Alert[]; paid: boolean; flash?: string; error?: string; now: number }

export function watchPage(ctx: Ctx, d: WatchData): string {
  const { w } = d
  const names = new Map([[w.id, '']])
  const paidOnly = d.paid ? '' : ' disabled'
  return layout({
    ctx,
    noindex: true,
    title: `${watchName(w)} · watch.wallet`,
    description: 'One watch.',
    path: `/w/${w.id}`,
    body: `${d.flash ? `<p class="note">${esc(d.flash)}</p>` : ''}${d.error ? `<p class="note error">${esc(d.error)}</p>` : ''}
<p class="small"><a href="/me">‹ My watches</a></p>
<section class="hero left"><h1>${esc(watchName(w))}</h1><p>${watchStatus(w)}</p>
${w.kind === 'address' ? `<p class="small"><code>${esc(w.address)}</code> on ${esc(CHAIN_INFO[w.chain as Chain].label)} · <a href="${esc(CHAIN_INFO[w.chain as Chain].explorer(w.address))}" rel="noopener">explorer</a></p>
<p class="big-balance">${esc(describeBalances(w.chain as Chain, w.balances))}</p>` : `<p class="big-balance">${esc(w.coin)} ${esc(w.direction)} ${esc(usd(w.level_usd))}<span class="muted"> · now ${w.price === null ? '-' : esc(usd(w.price))}</span></p>`}
<p class="muted small">Last read ${esc(ago(w.last_checked_at, d.now))}${w.kind === 'address' ? ` · last move ${esc(ago(w.last_change_at, d.now))}` : ''}${w.last_error ? ` · last error: ${esc(w.last_error)}` : ''}</p></section>

<div class="card"><h2>Alerts</h2>${alertRows(ctx, d.alerts, names)}</div>

<div class="card" id="settings">
  <h2>Settings</h2>
  <form method="post" action="/w/${esc(w.id)}" class="stack">
    ${csrfField(ctx)}
    <label>Label <input name="label" maxlength="60" value="${esc(w.label)}"></label>
    ${w.kind === 'address' ? `<label>Only alert when the move is worth at least <span class="muted">(USD, Watcher)</span><input name="min_usd" type="number" min="0" step="any" value="${w.min_usd || ''}" placeholder="0 = any move"${paidOnly}></label>` : `<div class="row"><select name="direction"><option value="below"${w.direction === 'below' ? ' selected' : ''}>goes below</option><option value="above"${w.direction === 'above' ? ' selected' : ''}>goes above</option></select><input name="level_usd" type="number" min="0" step="any" value="${w.level_usd}"></div>`}
    <label><input type="checkbox" name="call" value="1"${w.call ? ' checked' : ''}${paidOnly}> Call me when it alerts <span class="muted">(Watcher)</span></label>
    <button class="btn ghost">Save</button>
  </form>
  <form method="post" action="/w/${esc(w.id)}/${w.state === 'paused' ? 'resume' : 'pause'}">${csrfField(ctx)}<button class="btn ghost">${w.state === 'paused' ? 'Resume' : 'Pause'}</button></form>
  <details><summary class="bad">Delete this watch</summary><form method="post" action="/w/${esc(w.id)}/delete">${csrfField(ctx)}<button class="btn danger">Delete it and its alerts</button></form></details>
</div>`,
  })
}

export type CheckResult = { chain: Chain; address: string; rows: { asset: string; amount: string; usd: number | null }[]; pending: boolean }

export function checkPage(ctx: Ctx, d: { chain?: string; address?: string; result?: CheckResult; error?: string }): string {
  const r = d.result
  return layout({
    ctx,
    track: true,
    noindex: Boolean(d.address),
    title: 'Check an address · watch.wallet',
    description: 'Look up the balance of any Bitcoin, Ethereum, Base, Polygon or Solana address. Free, no sign-in.',
    path: '/check',
    body: `<section class="hero"><h1>Check an address</h1><p class="tag">The balance of any address, right now. Free, no sign-in.</p></section>
<form class="card" method="get" action="/check">
  <div class="row"><select name="chain">${chainOptions(d.chain ?? 'ethereum')}</select><input name="address" required value="${esc(d.address ?? '')}" autocomplete="off" spellcheck="false" placeholder="0x…, bc1…, or a Solana address"><button class="btn">Check</button></div>
</form>
${d.error ? `<p class="note error">${esc(d.error)}</p>` : ''}
${r ? `<div class="card"><h2>${esc(CHAIN_INFO[r.chain].label)} <code>${esc(shortAddress(r.address))}</code></h2>
<table><tr><th>Asset</th><th>Balance</th><th>USD</th></tr>${r.rows.map((x) => `<tr><td>${esc(x.asset)}</td><td>${esc(x.amount)}</td><td>${x.usd === null ? '-' : esc(usd(x.usd))}</td></tr>`).join('')}</table>
${r.pending ? '<p class="small">There is an unconfirmed transaction in the mempool.</p>' : ''}
<p class="small"><a href="${esc(CHAIN_INFO[r.chain].explorer(r.address))}" rel="noopener">See it on the explorer</a></p>
<p><a class="btn" href="${ctx.user ? '/me#add' : '/signin?next=/me'}">Alert me when it moves</a></p></div>` : ''}`,
  })
}

export function plansPage(ctx: Ctx, d: { chains: string[]; plan: string; paid: boolean; payments: Payment[]; enabled: boolean; error?: string }): string {
  return layout({
    ctx,
    track: true,
    title: 'Plans · watch.wallet',
    description: 'Free for three watches. Watcher for 50, every minute, with phone calls and webhooks.',
    path: '/plans',
    body: `<section class="hero"><h1>Plans</h1>${ctx.user ? `<p class="tag">You are on <b>${esc(d.plan)}</b>.</p>` : ''}</section>
${d.error ? `<p class="note error">${esc(d.error)}</p>` : ''}
${plansTable(ctx)}
${ctx.user ? (d.enabled ? `<div class="card"><h2>Get Watcher</h2>
<form method="post" action="/plans/checkout" class="stack">
  ${csrfField(ctx)}
  <label><input type="radio" name="product" value="month" checked> ${esc(PRODUCTS.month.label)}: ${dollars(PRODUCTS.month.cents)}</label>
  <label><input type="radio" name="product" value="year"> ${esc(PRODUCTS.year.label)}: ${dollars(PRODUCTS.year.cents)}</label>
  ${d.paid ? '<p class="muted small">Added on top of the time you have left.</p>' : ''}
  <label>Pay with <select name="chain">${d.chains.map((c) => `<option value="${esc(c)}">${esc(CHAIN_LABELS[c] ?? c)}</option>`).join('')}</select></label>
  <button class="btn">Pay with CoinPay</button>
</form></div>` : '<p class="note">Payments open soon.</p>') : ''}
${d.payments.length ? `<div class="card"><h2>Your payments</h2><table><tr><th>Date</th><th>Plan</th><th>Amount</th><th>Status</th></tr>${d.payments.map((p) => `<tr><td>${esc(day(p.created_at))}</td><td>${esc(p.product)}</td><td>${dollars(p.amount_cents)} ${esc(p.chain)}</td><td>${esc(p.settled_at ? 'paid' : p.status)}</td></tr>`).join('')}</table></div>` : ''}`,
  })
}

/** Where an invite link lands: the invite rides in a cookie until they make an account. */
export function invitedPage(ctx: Ctx): string {
  return layout({
    ctx,
    noindex: true,
    title: "You're invited · watch.wallet",
    description: 'An invite to watch.wallet.',
    path: '/',
    body: `<section class="hero"><p class="muted">Invite</p><h1>You're invited to watch.wallet.</h1>
<p class="tag">Someone thought you should have this: watch any wallet on Bitcoin, Ethereum, Base, Polygon or Solana, or a price, and get an email, a push, or a phone call the second it moves.</p>
${ctx.user
    ? '<p class="muted">You already have an account, so this invite is for someone new. Pass it on.</p><a class="btn" href="/me">My watches</a>'
    : `<a class="btn" href="/signin?next=/me">Accept: make your account</a><p class="muted small">Make a new account in the next 7 days and you both get ${INVITE_DAYS} days of Watcher: 50 watches checked every minute, phone calls and webhooks.</p>`}</section>`,
  })
}

export type InvitesView = {
  quota: { total: number; used: number; left: number }
  invites: { id: string; createdAt: number; expiresAt: number | null; usedAt: number | null; note: string; revokedAt: number | null }[]
  invitees: number
  affiliate: string
  link?: string
  error?: string
}

export function invitesPage(ctx: Ctx, o: InvitesView): string {
  const now = Date.now()
  const rows = o.invites.map((i) => `<li>${esc(i.note || 'invite')} <span class="muted small">${i.usedAt ? `joined ${day(i.usedAt)}` : i.revokedAt ? 'withdrawn' : i.expiresAt && i.expiresAt < now ? 'expired' : `open, made ${day(i.createdAt)}`}</span></li>`).join('')
  return layout({
    ctx,
    noindex: true,
    title: 'Invites · watch.wallet',
    description: 'Your invite links.',
    path: '/invites',
    body: `${o.error ? `<p class="note error">${esc(o.error)}</p>` : ''}
<section class="hero left"><h1>Invites</h1><p class="muted">You have <b>${o.quota.left}</b> of ${o.quota.total} invite links left. Each works once, for someone who makes a new account through it within 30 days. You both get ${INVITE_DAYS} days of Watcher.</p></section>
${o.link ? `<div class="card"><p class="note">Your new invite link, shown once:</p><pre>${esc(o.link)}</pre></div>` : ''}
<div class="card">
  ${o.quota.left > 0 ? `<form method="post" action="/invites" class="row">${csrfField(ctx)}<input name="note" maxlength="80" placeholder="Who is it for? (only you see this)" aria-label="Note"><button class="btn">Make an invite link</button></form>` : '<p class="muted">All your invites are out.</p>'}
  ${rows ? `<ul>${rows}</ul>` : ''}
</div>
<div class="card">
  <h2>Your link for everyone else</h2>
  <p class="muted small">Share it anywhere. People who make an account after arriving through it are counted as yours${o.invitees ? `; ${o.invitees} joined on your invites so far` : ''}.</p>
  <pre>${esc(o.affiliate)}</pre>
</div>
<p><a class="btn ghost" href="/me">My watches</a></p>`,
  })
}
