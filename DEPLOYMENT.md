# Deploying the BotDock Cloud web application to Cloudflare

## Beginner's map — the 5 components and what they cost

BotDock Cloud is **not a static website**. It has four moving parts. Deploy
them in this order; each section below walks through its step.

| # | Component | What it is | Free option? | Where it runs |
|---|---|---|---|---|
| A | **Web application** | This Next.js app (UI + REST API) as a Cloudflare **Worker** | ✅ Workers free tier is enough to start | Cloudflare |
| B | **Production database** | Remote libSQL (Turso) — local SQLite is dev-only | ✅ Turso free tier (500 DBs) | Turso cloud |
| C | **Bot runtime** | Separate service that actually runs your users' bots | ⚠️ Needs a small always-on Linux host (a free-tier VM works but may sleep/restart — bots then stop until it wakes) | Any Linux VM/container |
| D | **Secrets & env vars** | `APP_SECRET`, `RUNTIME_API_KEY`, `DATABASE_URL`, OAuth/email keys | ✅ Free (`wrangler secret put`) | Cloudflare |
| E | **Final testing** | The post-deploy checklist in §7 | ✅ Free | Your browser |

Costs to be honest about: components A, B, D are genuinely free to start.
Component C is the only one that **cannot** run on Cloudflare (Workers cannot
host persistent bot processes) and needs a tiny always-on computer — free-tier
VMs exist but 24/7 uptime is not guaranteed on them. Nothing here is
"unlimited free 24/7 hosting" — plan limits are enforced server-side.

## Background: fixing "Could not detect a directory containing static files"

That error happens when a full-stack Next.js application is pushed to a
deployment target that treats it as a **static site** (Cloudflare Pages
auto-detection) — no static directory exists because the app is a *server*
application.

BotDock Cloud is deployed the correct way: as a **Cloudflare Worker with
static assets**, built by [OpenNext Cloudflare](https://opennext.js.org/cloudflare).
The repository ships the exact configuration for this:

- `open-next.config.ts` — OpenNext adapter config
- `wrangler.jsonc` — Worker config: `main: .open-next/worker.js`,
  `assets.directory: .open-next/assets`, `nodejs_compat` flag
- `package.json` scripts:

```bash
bun run cf:build     # opennextjs-cloudflare build  (runs next build → .open-next/)
bun run cf:preview   # opennextjs-cloudflare preview (local workerd preview)
bun run cf:deploy    # opennextjs-cloudflare deploy (build first if needed)
```

**Rule: build first, deploy second.** Never run `wrangler deploy` against a
repo that has no `.open-next/` build output.

Verified locally: `bun run cf:build` completes and prints
`Worker saved in .open-next/worker.js`.

## Step-by-step deployment

### 1. Prerequisites

- A Cloudflare account (free tier works) and `wrangler` login:

```bash
bunx wrangler login
```

### 2. Provision a production database (REQUIRED)

Cloudflare Workers **cannot** open a local SQLite file — there is no shared
filesystem between isolates. The application therefore supports two
production-ready transports, selected automatically from `DATABASE_URL`:

**Option A (recommended, minimal change): remote libSQL — e.g. Turso**

```bash
turso db create botdock
turso db show botdock --url          # → libsql://botdock-<org>.turso.io
turso db tokens create botdock       # → auth token
```

```ini
DATABASE_URL="libsql://botdock-<org>.turso.io"
LIBSQL_AUTH_TOKEN="<token from turso db tokens create>"
```

With a `libsql://` (or `https://`) URL the client (`src/lib/db.ts`)
automatically uses the official `@prisma/adapter-libsql` driver adapter —
the supported way to run Prisma on Workers (pure HTTP transport, no native
engine, no filesystem). The schema stays `provider = "sqlite"`; the
migrations in `prisma/migrations/` apply to Turso unchanged.

**Option B: PostgreSQL (Neon/Supabase + Hyperdrive)**

1. Switch the datasource in `prisma/schema.prisma`:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

2. Regenerate the migration SQL for Postgres and apply it to the new
   database:

```bash
bunx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > /tmp/pg-init.sql
psql "$DATABASE_URL" -f /tmp/pg-init.sql      # or bunx prisma migrate deploy after baselining
bunx prisma generate                           # regenerate the client for postgresql
```

3. In Workers, connect through **Hyperdrive** (pooled, edge-local): create a
   Hyperdrive binding in `wrangler.jsonc` and pass its connection string as
   `DATABASE_URL`, plus `@prisma/adapter-pg` in `src/lib/db.ts` (swap the
   adapter branch — the application code above `db.ts` does not change).

> Local development keeps plain `file:` SQLite with zero adapter — nothing
> about the dev workflow changes.

### 3. Apply the schema to production (no data loss)

```bash
# against the production DATABASE_URL:
bun run db:migrate:deploy      # applies prisma/migrations — additive, safe
bun run db:migrate:status      # verify "Database schema is up to date"
```

Migrations are additive (`CREATE TABLE`/`CREATE INDEX`). `prisma db push`
no longer uses `--accept-data-loss` anywhere in the standard workflow, and
destructive commands (`db:reset`) exist only as explicit developer tools.

**Migrating existing data:** copy rows from the old SQLite file into the new
remote DB with any SQLite client (read from `db/custom.db`, write through
Turso's `turso db shell` / the libSQL client) — table names and columns are
identical. Never point production at an empty database and re-seed over
existing users.

### 4. Set secrets and vars

```bash
wrangler secret put APP_SECRET            # openssl rand -hex 32
wrangler secret put RUNTIME_API_KEY       # same value the runtime server uses
wrangler secret put DATABASE_URL          # libsql://… or postgres://…
wrangler secret put LIBSQL_AUTH_TOKEN     # Turso auth token (Option A)
wrangler secret put ADMIN_BOOTSTRAP_TOKEN # one-time first-admin setup token
wrangler secret put RESEND_API_KEY        # optional
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put TELEGRAM_BOT_TOKEN    # optional
# DO NOT set Stripe secrets for the free launch. MONETIZATION_ENABLED stays
# unset/false; checkout and billing webhooks return 501 and paid plans are
# hidden. The dormant Stripe path documents itself in docs/SETUP.md.
```

Non-secret vars go in `wrangler.jsonc` → `vars` (or the Cloudflare dashboard):

```jsonc
"vars": {
  "APP_URL": "https://botdock.your-domain.com",
  "RUNTIME_SERVICE_URL": "https://runtime.your-domain.com",
  "RUNTIME_EMBEDDED": "false",
  "DEV_SHOW_EMAIL_LINKS": "false"
}
```

**Always set `RUNTIME_EMBEDDED=false` in production** — Workers cannot spawn
the bot runtime; it must run separately (next document).

`RUNTIME_SERVICE_URL` is validated at startup: it must be a valid http(s)
URL and **public production endpoints must use HTTPS** (plain http only for
loopback/private addresses). A misconfigured value appears in `/api/health`
as `runtime.configError`, and the app never silently falls back to
localhost. `RUNTIME_API_KEY` is server-side only — it is never included in
any client bundle or API response.

### 5. First administrator (bootstrap)

An empty production database does **not** make the first visitor admin.
Before (or right after) the first deploy:

1. Generate a one-time token: `openssl rand -hex 16`
2. `wrangler secret put ADMIN_BOOTSTRAP_TOKEN`
3. Register the first account and enter the token in the “Setup token”
   field. That account becomes ADMIN; all later registrations are USER.

The grant is also protected by an atomic DB marker — concurrent
registrations can never yield two admins. See `docs/SETUP.md` for details.

### 6. Build & deploy

```bash
bun run cf:build     # next build → OpenNext → .open-next/worker.js + assets (+ hygiene cleanup)
bun run cf:verify    # optional standalone check of the build output
bun run cf:deploy    # preflight gate (cf-verify) → uploads Worker + assets
```

`cf:deploy` and `cf:preview` run **`scripts/cf-verify.mjs` first**, which blocks
the deploy unless ALL of the following hold:

- `.open-next/worker.js` and `.open-next/assets/` exist (`opennextjs-cloudflare
deploy` does NOT build — deploying without `cf:build` is the #1 cause of a
broken/404-ing Worker),
- `wrangler.jsonc` wiring points at exactly those paths,
- the build is FRESH (`.next/BUILD_ID` == `.open-next/assets/BUILD_ID` — a stale
build would ship old code with dead asset hashes),
- no secrets/databases/logs leaked into the bundle, and
- **no build-time `.env` values are baked into `next-env.mjs`** (see below).

> **Baked-env hazard (fixed, but know why):** OpenNext snapshots the build-time
> `.env` into `.open-next/cloudflare/next-env.mjs`, which ships inside the
> Worker bundle and silently back-fills any var the operator did not set —
> leaking local secrets into the artifact AND masking missing production
> config. `scripts/cf-clean.mjs` scrubs that file after every build, so
> production configuration comes **only** from `wrangler secret put` / `[vars]`.

### 7. Post-deploy verification checklist

Run these against the LIVE host (they are also printed by `cf-verify`):

```bash
curl -i https://<your-host>/                    # 200 — landing renders
curl -i https://<your-host>/login               # 307 → /#/login
curl -i https://<your-host>/register            # 307 → /#/register
curl -i https://<your-host>/pricing             # 200
curl -i https://<your-host>/api/health          # 200 — per-component statuses
curl -i https://<your-host>/api/auth/config     # 200 — provider booleans
curl -i https://<your-host>/api/auth/oauth/google # 302 when configured / 501 with oauth_not_configured when not
curl -i https://<your-host>/sitemap.xml         # 200
```

Then fetch the home page HTML and load one `/_next/static/chunks/…` URL from
it — a 404 there means the assets directory was misconfigured. Finally:
register the bootstrap admin → verify email → deploy the keep-alive template
bot → confirm the Logs tab shows live output. `wrangler tail` shows any
unresolved startup errors.

`/api/health` reports **each component independently** — `app` (config),
`database` (live SELECT 1), `auth` (session readiness + which OAuth providers
are configured), `email` (provider presence), `runtime` (LIVE ping) — with
statuses `healthy | unconfigured | unreachable | error`. A health response
never claims Google login or the bot runtime works just because the web
server responds, and never contains secret values.

### 8. Diagnosing a 404 on Cloudflare

A 404 on every route means the deployment itself is wrong, not the app. The
known causes, in likelihood order:

1. **Static ZIP/Pages upload of the source** — this is a full-stack Next.js
   app; there are NO static HTML files, so a Pages static upload 404s (or
   fails with "Could not detect a directory containing static files"). Fix:
   deploy as a **Worker** via `bun run cf:build && bun run cf:deploy`. The
   source ZIP (`BotDock-Cloud-Fixed.zip` / `BotDock-Cloud-Fixed.tar.gz`) is
   for the SOURCE, never for upload.
2. **Deploy without build** — `wrangler deploy` / `opennextjs-cloudflare
   deploy` upload whatever `.open-next/` currently holds; on a fresh clone
   that is nothing. `cf:deploy` now blocks this (cf-verify).
3. **Stale build** — old bundle with dead `/_next/static` hashes: pages load
   but render blank/404 assets. cf-verify compares BUILD_IDs and blocks.
4. **Assets directory mismatch** — `assets.directory` must be exactly
   `.open-next/assets` (what OpenNext emits). Wrong path = missing JS/CSS.
5. **No route attached** — in the Cloudflare dashboard, Workers & Pages →
   your Worker → Settings → Domains & Routes: add your custom domain/route.
   Verify with `wrangler deployments list` and `curl -i https://<host>/`.
6. **Worker exception** — `wrangler tail` shows the live error; fix the cause
   (e.g. missing DATABASE_URL secret → auth/API 5xx), never the 404 page.

## Continuous deployment (GitHub / Cloudflare Workers Builds)

> **Fix for the `"Could not detect a directory containing static files"` build
> failure (verified October 2026):** this error is emitted by
> `npx wrangler deploy` when the directory it runs in contains **no
> `wrangler.jsonc`** and no entry point — reproduced locally with wrangler 4.x.
> (A clone that HAS `wrangler.jsonc` but no build output fails differently:
> `The entry-point file at ".open-next/worker.js" was not found`.) Both mean
> the same two things were missing in the Cloudflare build:
>
> 1. **No build command was configured** — the log shows `Executing user
>    deploy command: npx wrangler deploy` with no build/install output before
>    it. A fresh clone has no `.open-next/` (build output is never committed)
>    and no `node_modules`, so a bare deploy command can never work.
> 2. **No `wrangler.jsonc` at the deploy root** — your GitHub repository must
>    contain this file at the top level (it is tracked in git — verify at
>    `https://github.com/<you>/<repo>` that the file list shows it). If you
>    uploaded files manually, upload the FULL archive contents; if the
>    Cloudflare project sets a **Root directory**, it must be the repo root.

**Required Workers Builds settings** (Workers & Pages → your Worker →
Settings → Build → Edit build configuration):

| Setting | Value |
|---|---|
| Root directory | `/` (repo root — leave default) |
| Build command | `npm install --no-audit --no-fund && npx prisma generate && npx opennextjs-cloudflare build && node scripts/cf-clean.mjs` |
| Deploy command | `node scripts/cf-verify.mjs && npx opennextjs-cloudflare deploy` |
| Build watch paths | (default) |

Why each piece is there (do not trim them to "simplify"):

- `npm install` — Cloudflare's build image runs `npx` for the tooling; the
  dependency tree must exist before `next build`. The repository has
  `bun.lock`; Workers Builds detects bun for *its own* automatic install —
  the explicit `npm install` makes the build command self-sufficient either
  way. (A `package-lock.json` is NOT committed on purpose; npm resolves the
  same `package.json` ranges that CI already proves green.)
- `npx prisma generate` — the Prisma client is generated INTO `node_modules`
  (default output, not committed). Without this step `next build` fails with
  `@prisma/client did not initialize yet`.
- `npx opennextjs-cloudflare build` — runs the real build: `next build` →
  `.open-next/worker.js` + `.open-next/assets/`. This is the step the failing
  deployment never ran.
- `node scripts/cf-clean.mjs` — **security scrub** (not optional): strips
  `.env`/`db/`/logs that `next build` standalone-mode copies into the bundle
  and removes build-time env values baked into
  `.open-next/cloudflare/next-env.mjs`, so production configuration can only
  come from Worker secrets/vars.
- `node scripts/cf-verify.mjs` — pre-deploy gate: blocks the deploy unless
  the build output exists, `wrangler.jsonc` wiring matches it, the build is
  fresh (BUILD_ID match), and no secrets leaked into the bundle.
- Deploy uses `npx opennextjs-cloudflare deploy` (not bare
  `npx wrangler deploy`) so the adapter drives wrangler with the correct
  entry/assets wiring.

**Build-time environment variables:** none are required. The build touches no
database (DB-backed pages are force-dynamic) and `cf-clean` guarantees no
build-time env value reaches the deployed bundle. Real configuration happens
AFTER deploy via `wrangler secret put` (§4) and `vars`.

**Minimal variant (works, but weaker):** Build
`npx opennextjs-cloudflare build && node scripts/cf-clean.mjs`, Deploy
`npx wrangler deploy`. This also succeeds — `wrangler.jsonc` already points at
the built entry/assets — but it loses the cf-verify gate, so a stale or leaked
build would ship undetected. Use the full variant.

**First deploy checklist:**

1. Confirm `wrangler.jsonc` and `open-next.config.ts` are visible in the file
   list of your GitHub repo's default branch.
2. Apply the settings table above exactly.
3. Push (or use "Retry deployment") and watch the log: you must see the
   install, `prisma generate`, `next build`, `cf-clean`, `cf-verify` (`RESULT:
   OK`) and only then `opennextjs-cloudflare deploy`.
4. Add the Worker secrets from §4 (`wrangler secret put` or the dashboard's
   Variables & Secrets — same names).
5. Run the §7 post-deploy checklist against the assigned
   `*.workers.dev` host.

- `.github/workflows/ci.yml` runs on every push/PR: dependency install,
  Prisma validate + generate, `tsc --noEmit`, ESLint, unit tests,
  production build and the OpenNext Cloudflare build — with placeholder
  env vars only (no secrets in CI).
- Secrets (DB URL, keys) are configured as Worker secrets, never as
  repository variables.

## Local Worker preview (`wrangler dev`)

The **local** preview loads `.env` / `.dev.vars` through wrangler's platform
proxy for convenience. **Production is different: deployed Workers see ONLY
dashboard vars and `wrangler secret put` values** — never `.env`. (The
build-time `.env` snapshot in `next-env.mjs` is scrubbed by `cf-clean`, so
local values can never leak into or back-fill production.)

To preview with explicit values (wrangler-native way):

```bash
cp .dev.vars.example .dev.vars   # then fill values (git-ignored)
bun run cf:preview               # cf-verify → opennextjs-cloudflare preview
```

With no configuration at all, the preview shows the honest "unconfigured"
state — useful for exactly the demo-screenshot scenario (health reports
`app: unconfigured`, `auth: unconfigured`, Google sign-in returns 501 with
setup instructions).

Note: a `file:` SQLite DATABASE_URL cannot open inside workerd — the preview
will report `database: unreachable` and auth endpoints return an honest
`503 database_unavailable`. For a full preview, point `DATABASE_URL` in
`.dev.vars` at a remote libSQL/Turso database.

## Backup, restore & rollback

**Database**
- Backup: Turso has platform snapshots, or `turso db shell botdock .dump > backup-$(date +%F).sql`; for Postgres use `pg_dump` (cron daily).
- Restore: recreate the DB and pipe the dump back in (`turso db shell <new> < backup.sql` / `psql < backup.sql`), then `bun run db:migrate:deploy`.
- Rollback of a bad deploy: redeploy the previous Worker version
  (`wrangler rollback` or the dashboard's deployment history). Schema
  migrations are additive — a code rollback remains compatible with a newer
  schema.
- Losing `APP_SECRET` invalidates sessions and all encrypted bot env vars /
  GitHub tokens (they must be re-entered). Keep an encrypted copy of secrets
  in a password manager.

**Bot workspaces**
- Bot files/logs live on the runtime server under `RUNTIME_DATA_DIR` —
  snapshot that directory (rsync/restic) on the same schedule; they are not
  stored in the main database.

**Rate limiting**
- Production (remote DB) uses the shared `RateLimitBucket` table — counters
  are consistent across all Worker isolates. It fails open on DB errors
  (documented in `src/lib/rate-limit.ts`); adjust `RATE_LIMIT_BACKEND` only
  if you run a dedicated store.
