# watch.wallet

Know the second your wallet moves. Watch any address on Bitcoin, Ethereum,
Base, Polygon or Solana, or a price, and get an email, a push, or a phone call
that wakes you up.

Made for guarding a cold wallet or a treasury, and as an early warning on a
wallet you think is compromised. Also does price levels.

- Web: <https://watch.wallet.pit.world> (on Moshpit DNS: <https://watch.wallet>)
- Free lookup: <https://watch.wallet.pit.world/check>
- CLI and TUI: `bunx @profullstack/watchwallet`
- MCP: `claude mcp add watchwallet -- bunx @profullstack/watchwallet mcp`
- API: `https://watch.wallet.pit.world/api/v1` (`Authorization: Bearer ww_…`)

## How it works

1. **Add a watch.** An address on a chain, or a coin above or below a USD level.
   Addresses are checked before they are saved (Bitcoin base58check, bech32 and
   bech32m checksums; Solana base58 to 32 bytes; EVM shape).
2. **We read it.** The native coin plus USDC and USDT, from public sources with
   no API keys:

   | Chain | Source | Assets |
   | --- | --- | --- |
   | Bitcoin | mempool.space `/api/address/:addr` (confirmed + mempool) | BTC |
   | Ethereum | public JSON-RPC (`eth_getBalance`, `balanceOf`) | ETH, USDC, USDT |
   | Base | public JSON-RPC | ETH, USDC, USDT |
   | Polygon | public JSON-RPC | POL, USDC, USDT (USDT0) |
   | Solana | public JSON-RPC (`getBalance`, `getTokenAccountsByOwner`) | SOL, USDC, USDT |
   | Prices | Coinbase `/v2/prices/<COIN>-USD/spot` | any Coinbase ticker |

   Token contracts are in one table, `src/chains.ts`.
3. **It moves, you hear.** The first read is the baseline. Any change after
   that records an alert and sends email and push; on Watcher also a phone call
   ("press 1 to acknowledge") and a signed webhook. With a dollar threshold, the
   total moved since the last alert must reach it, so small drains add up.
4. **Price watches** fire once at the level, then re-arm after the price is back
   on the other side by 0.5%.

The worker runs once a minute inside the web process. Each read leases the watch
(compare-and-set on an integer `version`) and commits balances and the alert in
one transaction, so two workers never alert twice. A failed read never alerts
and never moves the baseline; the source is backed off 1, 2, 4 … 30 minutes.

## Plans

| | Free | Watcher ($5 for 30 days, or $39 a year) |
| --- | --- | --- |
| Watches | 3 | 50 |
| Checked every | 15 minutes | minute |
| Email, push | yes | yes |
| Phone calls, webhooks | | yes |
| Dollar threshold | | yes |

One-time payments in crypto through [CoinPay](https://coinpayportal.com); paying
again extends the end date. A lapsed plan deletes nothing: the first three
watches keep running at the free cadence and the rest are paused until you pay.

## CLI

```sh
watchwallet login ww_…                          # key from /me#account
watchwallet status
watchwallet add ethereum 0x… --label=Cold --min-usd=100 --call
watchwallet price BTC below 60000
watchwallet alerts
watchwallet ack                                 # acknowledge everything open
watchwallet rm Cold
watchwallet check solana <address>              # no key needed
watchwallet redeem CR-XXXX-XXXX-XXXX-XXXX        # days of Watcher from a code
watchwallet invite-link "for Dan"               # a single-use invite (you both get 7 days)
watchwallet                                     # TUI: a = acknowledge, r = reload
```

## Credit codes and invites

**Credit codes** ([`@profullstack/redeem-credits`](https://www.npmjs.com/package/@profullstack/redeem-credits)):
a code grants the unit `watcher_days`, days of the Watcher plan. A signed-in
person redeems it under "Have a code?" on `/me` (or `watchwallet redeem CR-…`,
MCP `redeem_code`, `POST /api/v1/redeem {"code"}` with a `ww_` key). The days
are applied the way a purchase is: a settled $0 row in `payments` (chain
`credit-code`) that extends `plan_until`, so they stack with paid time and
watches a lapsed plan paused come back. Mint on the server (the redeem-credits
CLI only speaks SQLite, so this one talks to `DATABASE_URL`):

```sh
export PATH=/root/.bun/bin:$PATH; cd /opt/watch.wallet && set -a && . /root/.local/share/watch-wallet/app.env && set +a
bun bin/watchwallet codes mint 30 --label="for Dan" [--max=10] [--expires=30d]
bun bin/watchwallet codes list
bun bin/watchwallet codes revoke <codeId>
bun bin/watchwallet codes grant someone@example.com 14      # days straight onto an account
```

**Invites** ([`@profullstack/affiliates`](https://www.npmjs.com/package/@profullstack/affiliates)):
three single-use links per account at `/invites` (`GET/POST /api/v1/invites`,
`watchwallet invite-link`, MCP `create_invite`). A link lands on `/i/<code>`,
rides in a 7-day cookie, and is spent when that browser makes a **new**
account; then both people get 7 Watcher days (at most 21 for one inviter).
Every account also has an affiliate link (`/?ref=<code>`), remembered
first-touch for 30 days and credited to new accounts.

## Webhooks

Every alert POSTs `{ event: "watch.alert", alert, watch }` with
`x-watchwallet-signature: t=<unix>,v1=<hex>`, where v1 is HMAC-SHA256 of
`t + "." + body` with your secret. URLs must be https and resolve to a public
address (checked when saved and before each send).

## Running it

Bun + Hono + Postgres (`DATABASE_URL`, Bun's built-in client). Tables are made on boot.

```sh
bun install
DATABASE_URL=postgres://… WATCHWALLET_SECRET=$(openssl rand -hex 32) bun src/server.ts
```

| Variable | |
| --- | --- |
| `DATABASE_URL` | Postgres |
| `WATCHWALLET_SECRET` | 32+ characters; signs CSRF tokens and acknowledge links |
| `RESEND_API_KEY`, `MAIL_FROM` | email (without a key, mail goes to the log) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | web push (`bunx web-push generate-vapid-keys`) |
| `COINPAY_API_KEY`, `COINPAY_BUSINESS_ID`, `COINPAY_WEBHOOK_SECRET`, `COINPAY_API_URL`, `COINPAY_CHAINS` | payments |
| `PRICE_MONTH_USD` (5), `PRICE_YEAR_USD` (39) | prices |
| `TELNYX_API_KEY`, `TELNYX_CONNECTION_ID`, `TELNYX_FROM`, `TELNYX_PUBLIC_KEY` | phone calls |
| `ADMIN_EMAILS` | accounts that get Watcher free |
| `WATCHWALLET_RPC_ETHEREUM`, `_BASE`, `_POLYGON`, `_SOLANA` | comma-separated RPC URLs, tried in order |
| `MEMPOOL_URL`, `COINBASE_URL`, `SOURCE_TIMEOUT_MS` | other sources |
| `CRAWLPROOF_SITE` | analytics on public pages |
| `PORT` (8805), `HOST`, `WORKER=off` | |

CLI: `WATCHWALLET_KEY`, `WATCHWALLET_URL`.

Tests: `TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55491/postgres bun test`
(see `test/app.test.ts` for a one-line docker Postgres). Each run makes and drops its own database.

Deploy: `bin/install.sh` on the box (OpenInstall), settings in `bin/install.conf`.

MIT. By [Profullstack, Inc.](https://profullstack.com)
