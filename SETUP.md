# BotDock Cloud — Setup Guide

A step-by-step guide for a non-expert. Every variable below lives in `.env`
(copy `.env.example` → `.env`). Restart `bun run dev` after changing it.

## 1. Required software

| Software | Check with | Notes |
|---|---|---|
| Bun ≥ 1.1 | `bun --version` | Runs the web app and the bot runtime |
| Python ≥ 3.10 | `python3 --version` | Needed to RUN Python bots |
| Node.js ≥ 20 | `node --version` | Needed to RUN Node bots |

## 2. Environment variables

### Core (always required)

```ini
DATABASE_URL="file:./db/custom.db"   # SQLite in development
APP_SECRET="<openssl rand -hex 32>"  # signs sessions, encrypts secrets
APP_URL="http://localhost:3000"      # public URL used in emails/OAuth
ADMIN_BOOTSTRAP_TOKEN="<openssl rand -hex 16>"
```

`APP_SECRET` protects everything from sessions to bot env vars. If you rotate
it, all sessions and stored encrypted values (bot env vars, GitHub tokens)
become undecryptable and must be re-entered.

### First administrator bootstrap (security-critical)

On a **production** deployment the first account is NOT granted admin just
for registering first — that would let a random visitor own the platform.
Instead:

1. Set `ADMIN_BOOTSTRAP_TOKEN` (one-time value, keep it secret).
2. Register the first account and enter that token in the “Setup token”
   field (the register form shows it automatically when setup is required).
3. That first account becomes ADMIN; every later registration is a normal
   user. The token is never needed again — remove it from the env if you like.

In development (no `NODE_ENV=production`) the first account still becomes
admin automatically for convenience — unless `ADMIN_BOOTSTRAP_TOKEN` is set.
The grant is additionally protected by an atomic database marker, so two
simultaneous “first” registrations can never produce two admins.

### Bot runtime

```ini
RUNTIME_SERVICE_URL="http://127.0.0.1:3030"  # dev: embedded runtime (or unset)
RUNTIME_SERVICE_PORT="3030"                  # used only for the localhost default
RUNTIME_API_KEY="<openssl rand -hex 32>"
RUNTIME_DATA_DIR="./bot-data"        # bot workspaces, logs, staging
RUNTIME_EMBEDDED="true"              # dev: web app supervises the runtime
```

`RUNTIME_SERVICE_URL` is honored for ALL runtime calls and is validated at
startup: it must be a valid http(s) URL, and **public production endpoints
must use HTTPS** (plain http is accepted only for loopback/private-network
hosts). An invalid value is surfaced by `/api/health` as `configError` —
the app never silently falls back to localhost in production.

In production set `RUNTIME_EMBEDDED=false` and point `RUNTIME_SERVICE_URL` at
the dedicated runtime server — see `docs/RUNTIME-DEPLOYMENT.md`.

### OAuth (optional — buttons show a clear notice when unset)

The login/register pages detect configuration at runtime via `/api/auth/config`.
Unconfigured providers stay visible but are clearly labelled "not configured on
this deployment" — nothing pretends to work.

**Exact authorized callback URLs** (derived from the routes in this repository —
`src/app/api/auth/oauth/[provider]/{route.ts,callback/route.ts}`):

| Provider | Register EXACTLY this redirect URI |
|---|---|
| Google | `<APP_URL>/api/auth/oauth/google/callback` |
| GitHub | `<APP_URL>/api/auth/oauth/github/callback` |

`<APP_URL>` is verbatim the value of `APP_URL` in your environment (no trailing
slash). The OAuth start route builds its `redirect_uri` the same way, so the
provider and the app must agree character-for-character or the provider rejects
the callback (`redirect_uri_mismatch`).

**Google**
1. Go to https://console.cloud.google.com/apis/credentials → *Create OAuth client ID* → *Web application*.
2. Authorized redirect URI: `https://YOUR-DOMAIN/api/auth/oauth/google/callback` (for local dev: `http://localhost:3000/api/auth/oauth/google/callback`).
3. No "Authorized JavaScript origins" entry is required — the flow is server-side.
4. Copy the client id/secret:

```ini
GOOGLE_CLIENT_ID="...apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET="GOCSPX-..."
```

**GitHub**
1. https://github.com/settings/developers → *New OAuth App*.
2. Authorization callback URL: `https://YOUR-DOMAIN/api/auth/oauth/github/callback`.
3. This is a plain **OAuth App for sign-in** — it does NOT grant repository
   access and is unrelated to the repo-import feature (that uses a personal
   access token entered by each user in Settings; no extra `repo` scope here).
4. Copy:

```ini
GITHUB_CLIENT_ID="..."
GITHUB_CLIENT_SECRET="..."
```

**Where to put the variables**

- *Z.ai demo environment:* edit `/home/z/my-project/.env` (git-ignored; see the
  "Z.ai demo environment" note below), then restart the dev server.
- *Production (Cloudflare):* `wrangler secret put GOOGLE_CLIENT_ID` etc. (see
  `docs/DEPLOYMENT.md`). Secrets never go into frontend code or Git — the
  client only ever receives the boolean "configured" flag.

OAuth linking policy: an OAuth login only auto-links to an existing
password-registered account when the **provider attests the email is
verified** (Google's `email_verified` claim / GitHub's verified primary email).
Otherwise the user is told to sign in with the password and link from settings.

### Email delivery (Resend — optional but strongly recommended)

1. Create an account at https://resend.com and verify your sending domain:
   *Resend → Domains → Add domain* → add the shown DNS records (SPF + DKIM)
   at your DNS provider → wait for the status to turn **Verified**. Until the
   domain is verified, Resend rejects arbitrary senders — only the special
   onboarding address `onboarding@resend.dev` works, and it can deliver **only
   to your own account's email address** (fine for a first smoke test, useless
   for real users).
2. Create an API key:

```ini
RESEND_API_KEY="re_..."
EMAIL_FROM="BotDock Cloud <no-reply@your-verified-domain.com>"
```

`EMAIL_FROM` must use the domain you verified in step 1, or Resend returns
`403 validation_error` — the platform records that failure honestly in the
`EmailLog` table (status `FAILED`) and never reports the mail as sent.

Without a key the platform **does not pretend to send**: verification /
reset emails are recorded in the `EmailLog` table (status `SKIPPED`) and
printed to the server console. For local testing only you may set
`DEV_SHOW_EMAIL_LINKS="true"`, which surfaces the verification/reset link in
the UI. **Never enable that in production.**

Admins can also verify a user manually in Admin → Users.

### Monetization & payments (DISABLED at launch)

BotDock Cloud launches **free-first**: every eligible user is placed on the free
plan automatically and no payment is ever requested. The monetization switch:

```ini
MONETIZATION_ENABLED="false"   # default — leave this way for the free launch
```

While it is `false` (the launch state):

- `/api/subscription` POST (checkout) returns `501 free_only_launch`.
- `/api/billing/webhook` is inert and returns `501 billing_disabled`.
- Paid plan rows are hidden from the public plans API and pricing page.
- The dashboard shows **Plan & usage** (real quotas and consumption) instead of
  a checkout funnel. There are no upgrade buttons anywhere.

The Stripe integration below stays in the codebase **dormant** for future
monetization. Do NOT set the following until paid plans are explicitly wanted
(and `MONETIZATION_ENABLED="true"` is set):

```ini
STRIPE_SECRET_KEY="sk_live_..."      # or sk_test_...
STRIPE_WEBHOOK_SECRET="whsec_..."
```

- Create a webhook endpoint pointing to `https://YOUR-DOMAIN/api/billing/webhook`
  with events: `checkout.session.completed`, `invoice.payment_failed`,
  `customer.subscription.deleted`.
- Plans activate **only** via the signed webhook — success redirects never
  mark payments as completed.
- Admins can also apply a plan manually (Admin → Users → plan selector); this
  audited tooling remains available even in free-first mode.

### Telegram broadcasts (optional)

```ini
TELEGRAM_BOT_TOKEN="123456:ABC..."
```

Used by the broadcast system to deliver announcements to users who have a
`telegramChatId` linked. Without the token, Telegram rows are recorded as
SKIPPED — never reported as sent.

### Z.ai demo environment (and any sandboxed preview)

In the Z.ai demo environment the app runs from `/home/z/my-project` on port
3000 behind a gateway. To configure environment variables there:

1. Edit `/home/z/my-project/.env` (already git-ignored — verify with
   `git check-ignore .env`). Copy any block from `.env.example` you need.
2. Set `APP_URL` to the **public URL your browser actually uses** for the
   preview (not `localhost`) whenever you need OAuth callbacks or emailed
   links to work from outside — emails and OAuth redirects are built from
   `APP_URL`.
3. Restart so `next dev` re-reads `.env`:
   `pkill -f "next dev -p 3000" && nohup bun run dev > /dev/null 2>&1 &`
4. Confirm with `curl -s localhost:3000/api/auth/config` — booleans flip to
   `true` the moment the matching variables are present. `/api/health` and the
   auth UI always reflect the real state; nothing needs a rebuild.

Never put secrets in frontend code: the browser only ever receives the
boolean "configured" flags from `/api/auth/config`; the credentials themselves
stay in server-side environment variables and are never returned by any API.

## 3. Database

Development uses SQLite — zero setup beyond `bun run db:push` (safe: it will
refuse changes that would lose data) or migrations:

```bash
bun run db:migrate            # create/apply a dev migration
bun run db:migrate:deploy     # apply pending migrations (used in production)
bun run db:migrate:status     # check migration state
bun run db:reset              # DESTROYS all data — dev only
```

`.env` and `db/*.db` are git-ignored — never commit real user data.

Production: see `docs/DEPLOYMENT.md` (remote libSQL/Turso via the driver
adapter, or Postgres — with backup/restore/rollback procedures).

## 4. First run checklist

1. `bun install && bun run db:migrate:deploy && bun run dev`
2. Register the first account:
   - development → it becomes ADMIN automatically;
   - production → enter your `ADMIN_BOOTSTRAP_TOKEN` in the setup field.
3. Verify the email (dev link, Resend, or Admin → Users → Verify).
4. Create a bot from the "Python keep-alive" template and press **Deploy**.
5. Watch the Logs tab — you should see real process output within seconds.

## 5. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "Runtime offline" badge | runtime service not running | `curl -H "X-Runtime-Key: $RUNTIME_API_KEY" http://127.0.0.1:3030/health`; check `bot-runtime.log` |
| Deploy fails with `install_failed` | dependency install error | Bot → Logs → Build tab shows the full pip/bun output |
| Deploy fails `email_verification_required` | account unverified | verify via email/dev-link or Admin → Users → Verify |
| OAuth button shows "not configured" | provider env vars missing | set the variables per section above and restart |
| Bot fails `can't start new thread` | `ulimit -u` too low for a shared host | runtime floors nproc at 4096; ensure you are on the latest `mini-services/bot-runtime` |
| 403 `origin_not_allowed` on API calls | proxy rewriting the Origin header | set `APP_URL` to the real public URL |
