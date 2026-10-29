# BotDock Cloud — Architecture

## Components

```
                    Browser (single / route, hash-routed SPA)
                                   │  JSON /api/*
                                   ▼
        ┌──────────────────────────────────────────────────────────┐
        │                  Web application (Next.js 16)            │
        │  • Auth: bcrypt, JWT-wrapped DB sessions, OAuth (Google/ │
        │    GitHub), email verification, password reset           │
        │  • Control plane: plans, quotas, bot lifecycle           │
        │    orchestration, file staging, notifications,           │
        │    broadcasts, audit, admin                              │
        │  • Prisma ORM ──► SQLite (dev) / Postgres-Turso (prod)   │
        │  • runtime-supervisor (dev): spawns & monitors the       │
        │    runtime service; disabled via RUNTIME_EMBEDDED=false  │
        └───────────────┬──────────────────────────────────────────┘
                        │ HTTP + X-Runtime-Key (server-to-server only)
                        ▼
        ┌──────────────────────────────────────────────────────────┐
        │            botdock-runtime (Bun, 127.0.0.1:3030)          │
        │  • /deploy: install deps (pip --target / bun install),    │
        │    atomic swap, start with 2 s grace                      │
        │  • /bots/:id/{start,stop,restart,status,logs,build-logs}  │
        │  • isolation: ulimit (v/t/u/f) + bash wrapper + detached  │
        │    process groups + sanitized env + cwd jail              │
        │  • metrics: /proc RSS + utime/stime deltas every 5 s      │
        │  • persistence: atomic state.json + boot reconciliation   │
        └──────────────────────────────────────────────────────────┘
```

## Deployment topology (production)

1. **Cloudflare Workers (OpenNext)** — web app + control plane. Static assets
   served from the Worker's asset binding. Cannot host the runtime.
2. **Runtime server(s)** — one or more Linux hosts running `botdock-runtime`
   (systemd or container). Holds `RUNTIME_DATA_DIR` (workspaces, logs, state).
3. **Database** — managed Postgres/Turso (Prisma). Never a local SQLite file
   across Workers.
4. **Email** — Resend. **Payments** — none at launch (free-first platform;
   Stripe code exists dormant behind `MONETIZATION_ENABLED`).

## Key data flows

- **Deploy**: web app calls `POST /deploy` → the RUNTIME stages the bot
  workspace itself (`workspace/<botId>` → `staging/<botId>/<depId>`) → installs
  deps, swaps into `bots/<botId>/current`, starts the process, returns the
  *actual* state → web app records Deployment/Bot rows + usage + audit +
  notifications. (The web app never touches a local filesystem — it may run on
  Cloudflare Workers.)
- **Files**: the runtime owns ALL bot workspace I/O. The web app's file-manager
  endpoints (list/read/write/mkdir/delete/download/upload) proxy to the runtime
  over HTTP with the shared `X-Runtime-Key`. Archive extraction (zip/tar/tar.gz
  with zip-slip, symlink and bomb protection) happens inside the runtime.
- **Status**: web app merges the DB record with the runtime's live snapshot
  (state, pid, RSS, CPU%, uptime). If the runtime is unreachable the UI says
  so — DB values are shown as stale, never re-labeled as live.
- **Env vars**: encrypted at rest (AES-256-GCM with APP_SECRET), decrypted
  server-side only when passing to the runtime, never returned to browsers.
- **Broadcasts**: audience resolved from the DB; INAPP always deliverable;
  EMAIL/TELEGRAM rows recorded as SKIPPED with reasons when providers are not
  configured; per-recipient delivery status stored.

## Security model

| Threat | Defense |
|---|---|
| Credential stuffing | per-IP + per-account rate limits, bcrypt cost 12 |
| Session theft | httpOnly SameSite=Lax cookie, JWT tamper check, DB revocation, IP/UA recorded, revoke-all |
| CSRF | Origin check on all mutations + SameSite cookies |
| Unauthorized admin actions | `requireAdmin()` on every admin route (server-side), audit entries |
| Path traversal in file manager | resolve-and-prefix check, symlink refusal, forbidden basenames (.env etc.) |
| Zip-slip / archive attacks | entry validation (absolute paths, `..`), zip-bomb caps, symlink stripping, tar with safe flags |
| Secret leakage | AES-256-GCM at rest, write-only env UI, redacting audit logger, secrets never in client bundles |
| Untrusted bot code | separate service process; ulimit walls; env scrubbing (PATH/HOME/LD_PRELOAD not overridable); process-group kills; no platform secrets in bot env |
| Payment spoofing | irrelevant at launch (no payments exist; checkout/webhook return 501). When monetization is enabled: plans change only via Stripe signed webhooks or explicit admin action |
| Runtime impersonation | timing-safe shared-secret header; runtime binds 127.0.0.1 |

## Known limitations (documented, not hidden)

- Process-level isolation is not a container boundary; production runtimes
  should containerize bots (see RUNTIME-DEPLOYMENT.md).
- `ulimit -v` bounds virtual memory (8× plan RSS, max 6 GB) — an approximation
  of container memory quotas; real RSS is what the UI displays.
- `ulimit -u` is per-user on Linux; floored at 4096 to remain workable on
  shared-uid hosts — per-bot process caps need containers.
- The in-memory rate limiter suits a single instance; multi-instance
  deployments should swap in a shared store.
- SQLite dev DB holds no production data; migrations + provider snapshots are
  documented in DEPLOYMENT.md.
- Log retention beyond the configured days is not yet garbage-collected
  automatically (delete old `logs/`/`builds/` files on a cron).
