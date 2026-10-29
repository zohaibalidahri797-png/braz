# BotDock Cloud — Troubleshooting Guide

## 1. 404 after deploying (the big one)

**Symptom**: you upload the project ZIP to Cloudflare and the site 404s —
or Cloudflare says *"Could not detect a directory containing static files"*.

**Root cause**: deploying the **full-stack source archive** as a static site.
BotDock is a full-stack application: the API is server code. There is no
static HTML in the source ZIP, so a static/Pages upload of it can never work.

**Fix — pick ONE of these two correct deployments:**

- **Static frontend on Pages + backend on a Worker** (recommended split):
  1. Upload **`botdock-pages.zip` contents** (only the static site!) to
     Pages Direct Upload — `index.html` must be at the root of the upload.
  2. Deploy the backend Worker: `bun run cf:build && bun run cf:deploy`.
  3. Activate the `/api/*` proxy line in `_redirects` (see
     `docs/STATIC-FRONTEND.md` §3) and redeploy the Pages project.
- **Single Worker** (simplest): from the full repository run
  `bun run cf:build && bun run cf:deploy`. The Worker serves both the static
  site and `/api/*`. `cf:deploy` runs `scripts/cf-verify.mjs` first, which
  **blocks** deployment if `.open-next/worker.js` + `.open-next/assets` are
  missing or stale — so a broken build can never ship.

**Also check**: a nested folder in the Pages upload (index.html must be at
the ROOT), and that your custom domain route is attached to the *Worker*
(WORKERS & PAGES → your Worker → Settings → Domains & Routes), not a Pages
project.

## 2. API errors in the dashboard

| Symptom | Meaning | Fix |
|---|---|---|
| Yellow **DEMO MODE** banner everywhere | `GET /api/health` failed — no backend at the API base | Deploy the backend; set the `_redirects` proxy; or set the API base in Settings → Backend connection, then **Test connection** |
| `401 authentication_required` | Session cookie missing/expired | Sign in again; if behind the proxy, confirm `/api/*` proxies to the Worker (cookie is set per-origin) |
| `403 origin_not_allowed` | Mutation from a different origin than the API host | Use the same-origin setup (`_redirects` proxy or single Worker) |
| `503 database_unavailable` | Backend can't reach its database | Production must use `libsql://` (Turso) — set `DATABASE_URL` + `LIBSQL_AUTH_TOKEN` as Worker secrets; local `file:` SQLite cannot run in Workers |
| `429 too_many_attempts` | Rate limit (register 5/h/IP, login per-IP and per-account) | Wait for the `retryAfterSec` window |

## 3. Login failures

- **"Incorrect email or password"** (`401`) — wrong credentials; use
  *Forgot password* (requires a configured email provider to receive the link).
- **"Google/GitHub sign-in is not configured on this deployment"** — honest
  behavior: the administrator must set `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`
  (and/or `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`) as Worker secrets, plus
  callback URLs `https://YOUR-DOMAIN/api/auth/oauth/{google,github}/callback`
  in the provider consoles. See `docs/SETUP.md`.
- **`oauth_state_mismatch`** — the flow was interrupted or cookies were
  blocked; start again, don't reuse old tabs.
- **`oauth_email_unverified`** — the provider did not vouch for the email;
  sign in with your password and link the provider from Settings.
- **Redirected to `/#/login?error=…` after callback** — the error code is
  displayed on the login page; each code maps to a concrete fix above.

## 4. Deployment failures (bots)

- **Deploy button disabled** — status-dependent: deploy from `CREATED`,
  `STOPPED` or `FAILED`. If the runtime is offline the button is disabled and
  a banner explains why (never fake "deployed").
- **`503 runtime_unavailable`** — the bot runtime service is down or
  `RUNTIME_SERVICE_URL`/`RUNTIME_API_KEY` are wrong/mismatched. Check the
  runtime host is up and the key equals the web app's `RUNTIME_API_KEY`.
- **FAILED status** — open the bot → **Deployments → Build log**. Typical
  causes: broken `requirements.txt`, wrong start command, dependency index
  unreachable. The error shown is the real one from the build.
- **Stuck BUILDING/DEPLOYING** — deploys time out and fail honestly; check
  the build log, fix, and deploy again.
- **Bot runs locally but not here** — check the start command (see the bot's
  *Start command* field), that dependencies are declared (no global installs),
  and that your bot reads its token from the environment (set it in
  **Env vars**, marked *secret*).

## 5. Pages-specific checks (static site)

- Blank page → wrong folder uploaded (nested). `index.html` must be at root.
- JS works but no data → backend not connected (see §2).
- `404.html` shows for real pages → file missing from the upload; compare
  against `botdock-pages.zip`.
- CSS not applied → `assets/css/style.css` missing or renamed (paths are
  case-sensitive).

## 6. Verification checklist after any deployment

```bash
curl -i https://YOUR-DOMAIN/                 # 307 → /index.html (static site)
curl -i https://YOUR-DOMAIN/index.html       # 200, HTML
curl -i https://YOUR-DOMAIN/login.html       # 200
curl -i https://YOUR-DOMAIN/api/health       # 200, per-component JSON
curl -i https://YOUR-DOMAIN/api/auth/config  # 200, provider booleans
curl -i https://YOUR-DOMAIN/api/auth/oauth/google  # 501 when unconfigured (honest)
```

The backend Worker additionally gates itself: `bun run cf:verify` must print
`RESULT: OK` before any deploy (build present, fresh, wiring exact, no leaks).
