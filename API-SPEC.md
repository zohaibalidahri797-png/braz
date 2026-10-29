# BotDock Cloud — Backend API Specification

**Base URL**: same-origin `/api` (recommended), or any origin configured in the
static frontend (Settings → Backend connection). All bodies are JSON unless
marked multipart. **Auth**: httpOnly session cookie (`bd_session`, JWT-signed,
DB-revocable, 7-day expiry) — set automatically by `POST /api/auth/login`,
`/register` and the OAuth callbacks. No tokens are ever stored in the browser.

**Envelope** — success: the resource object directly (`200`/`201`).
Error: `{ "error": "<machine_code>", "detail": "<human message>", ...extra }`
with the appropriate HTTP status. `401 authentication_required` when signed out;
`403 admin_required` / `origin_not_allowed` (CSRF); `429 too_many_attempts`
(+ `retryAfterSec`).

---

## Auth

| Method & path | Body / query | Success | Notes |
|---|---|---|---|
| `POST /api/auth/register` | `{name, email, password, bootstrapToken?}` | `201 {ok…, sessionCreated, emailDelivered, devVerificationLink?}` | Rate-limited 5/h/IP. Password ≥10 chars. First account on a fresh **production** DB requires `ADMIN_BOOTSTRAP_TOKEN` (`403 admin_bootstrap_required` otherwise). `devVerificationLink` only when `DEV_SHOW_EMAIL_LINKS=true` and no mail provider. |
| `POST /api/auth/login` | `{email, password}` | `200 {ok:true}` + cookie | Rate-limited per IP **and** per account. `401 invalid_credentials`, `403 account_banned/account_suspended`, `503 database_unavailable`. |
| `POST /api/auth/logout` | – | `200 {ok:true}` | Revokes the DB session row, deletes the cookie. |
| `GET /api/auth/me` | – | `200 {user{id,email,name,role,status,emailVerified,image}, plan{id,name,priceLabel,status,…}}` | `401` when signed out. |
| `GET /api/auth/config` | – | `{google,githubOAuth,emailConfigured,registrationEnabled,bootstrapRequired}` | Drives which login buttons are enabled. |
| `GET/DELETE /api/auth/sessions` | `?id=` / `{all:true}` | list / `{ok:true,revoked:n}` | Revoke individual sessions or all. |
| `POST /api/auth/forgot-password` | `{email}` | `200` (always honest; no user enumeration) | Email sent only when a provider is configured. |
| `POST /api/auth/reset-password` | `{token,password}` | `200` | Token is single-use. |
| `POST /api/auth/resend-verification` | – | `200` | |
| `GET /api/auth/verify-email?token=` | – | HTML page | Consumes the token; legacy `#/verify` links are forwarded. |
| `PATCH /api/settings/profile` | `{name}` | `{ok:true}` | |
| `POST /api/settings/password` | `{currentPassword,newPassword}` | `200` | |

### OAuth 2.0 (Google / GitHub)
- Start: `GET /api/auth/oauth/{google|github}` → `302` to the provider (state
  cookie `bd_oauth_state`, 10-minute TTL). **`501 oauth_not_configured`** with
  the exact missing env vars when the provider is not configured.
- Callback: `GET /api/auth/oauth/{google|github}/callback` → validates state,
  exchanges the code **server-side**, links accounts only for
  **provider-verified emails**, then `302 /#/dashboard` or
  `302 /#/login?error=<code>` (`oauth_state_mismatch`, `oauth_email_unverified`,
  `account_blocked`, …).
- Required operator config: `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET`,
  `APP_URL`, callback URLs `<APP_URL>/api/auth/oauth/{google,github}/callback`.

## Bots

| Method & path | Body / query | Success | Notes |
|---|---|---|---|
| `GET /api/bots` | – | `{bots:[{id,name,description,runtime,status,runtimeStatus,runtimeReachable,memoryMb,uptimeSec,sourceType,sourceRef,currentDeploymentId,lastDeployedAt,createdAt}], plan, usage, runtimeReachable, runtimeNote}` | `runtimeStatus` is live from the runtime service; `RUNTIME_OFFLINE` when unreachable. |
| `POST /api/bots` | `{name, runtime: PYTHON\|NODE\|BUN, sourceType:"TEMPLATE", templateId, description?, startCommand?}` | `201 {ok:true, bot{id,name}}` | Template files are written **via the runtime service**; rolled back on failure (`503 runtime_unavailable`). |
| `POST /api/bots/upload` | multipart: `file` (.zip/.tar/.tar.gz/.tgz ≤20 MB), `name`, `runtime`, `description?`, `startCommand?` | `201 {ok:true, bot{id,name}, extracted{files,bytes}}` | Archives are scanned (path traversal, zip-slip, symlinks, bombs) **before** storage. Rate-limited 20/h. |
| `GET /api/bots/:id` | – | `{bot{…}, runtime{state,memoryMb,cpuPercent,uptimeSec}|null, runtimeError, deployments:[…]}` | Ownership enforced server-side (admins may view). |
| `PATCH /api/bots/:id` | `{name?,description?,runtime?,startCommand?}` | `{ok:true, bot}` | |
| `DELETE /api/bots/:id` | – | `{deleted:true}` | Full teardown: stop → undeploy → delete workspace → delete row. |
| `POST /api/bots/:id/deploy` *(alias)* | – | `{ok:true,…}` | |
| `POST /api/bots/:id/start` *(alias)* | – | `{ok:true,…}` | |
| `POST /api/bots/:id/stop` *(alias)* | – | `{ok:true,…}` | |
| `POST /api/bots/:id/restart` *(alias)* | – | `{ok:true,…}` | |
| `POST /api/bots/:id/action` | `{action: deploy\|start\|stop\|restart}` | `{ok:true,…}` / `{ok:false,error,detail}` | Canonical action endpoint. Deploy runs BUILD→START and reflects what the runtime actually reported — never fabricated. |
| `GET /api/bots/:id/logs` | `?tail=200` (max 1000) · `?build=<deploymentId>` | `{lines:[{ts,stream:"out"\|"err"\|"sys",text}], truncated, kind, note?}` | `runtimeUnavailable:true` + note when the runtime is offline (honest empty, not fake logs). |
| `GET /api/bots/:id/deployments` | – | `{deployments:[{id,number,status,sourceType,sourceRef,commitSha,commitMessage,error,startedAt,finishedAt,createdAt}]}` | Last 30. |
| `GET /api/deployments` | `?limit=50&status=&botId=` | `{deployments:[…], limit}` | Cross-bot view (user-scoped; admins see all). |
| `GET /api/bots/:id/env` | – | `{vars:[{key,isSecret,preview,updatedAt}], note}` | Values never leave the server after saving. |
| `PUT /api/bots/:id/env` | `{key,value,isSecret}` | `{ok:true,note}` | Encrypted at rest (AES-256-GCM). Max 64 vars. |
| `DELETE /api/bots/:id/env` | `?key=` | `{ok:true}` | |
| `GET /api/bots/:id/files` | `?path=` (+`&read=1` for content) | `{entries:[{name,type,size}]}` / `{file:{content}}` | Served by the runtime service through the API proxy; `.env` reads are forbidden. |
| `PUT /api/bots/:id/files` | `{path,content}` | `{ok:true}` | |
| `DELETE /api/bots/:id/files` | `?path=` | `{ok:true}` | |
| `POST /api/bots/:id/files/upload` | multipart `file`, `path?` | `{ok:true}` | ≤512 KB per file; archives extracted safely. |

## GitHub integration

| Method & path | Body / query | Success | Notes |
|---|---|---|---|
| `GET /api/github/token` | – | `{configured,label,scopes}` | Never returns the token itself. |
| `PUT /api/github/token` | `{token,label?}` | `{ok:true,scopes,note}` | Validated against GitHub before storing; encrypted (AES-256-GCM). |
| `DELETE /api/github/token` | – | `{ok:true}` | |
| `GET /api/github/repos` | – | `{repos:[…]}` | `400 no_github_token` when none stored. |
| `GET /api/github/branches` | `?repo=owner/name` | `{branches:[…]}` | |
| `POST /api/github/import` | `{name,repo,branch,runtime,description?}` | `201 {ok:true,bot,commit,extracted}` | Tarball is fetched server-side and extracted by the runtime service with the same archive-safety rules. |

## Platform

| Method & path | Success | Notes |
|---|---|---|
| `GET /api/health` | `{ok,degraded,service,time,app{status,appUrlConfigured,appSecretConfigured,…},database{status,transport},auth{status,googleConfigured,githubConfigured,registrationEnabled,bootstrapRequired},email{status,provider,fromConfigured},runtime{status,ok,embedded,version,uptimeSec,activeBots}}` | Every component **independent**; statuses: `healthy` / `unconfigured` / `unreachable` / `error`. No secret values ever. |
| `GET /api/plans` | `{plans:[…], paymentProvider, freeOnly}` | |
| `GET /api/usage` | `{botsTotal,botsRunning,botsStopped,botsFailed,statusCounts,plan,deploymentsToday,storageBytes,resourcePolicy,capacityNote,bots,recentDeployments}` | |
| `GET /api/templates` | `{templates:[{id,name,runtime,description}]}` | |
| `GET /api/subscription` | `{plan,payments:[…]}` | |
| `POST /api/subscription` | `{planId,billingCycle}` | **`501 free_only_launch`** until a payment provider is configured — never a fake upgrade. |
| `GET /api/notifications` | `{notifications,unread}` | `POST {ids?|all?}` marks read. |
| `GET /api/download?file=BotDock-Cloud-Fixed.zip\|BotDock-Cloud-Fixed.tar.gz\|botdock-pages.zip` | archive | Release artifacts (aliases: `BotDock-Cloudflare-Fixed.zip`, `botdock-cloud-fixed.zip`, `botdock-cloud.zip`, `botdock-cloud.tar.gz`). |

## Admin (session role checked server-side on every call)

| Method & path | Success |
|---|---|
| `GET /api/admin/stats` | `{users{total,verified,suspendedOrBanned},bots{RUNNING,…},deployments{last24h,failedLast24h},emails,auditLogEntries,runtime,runtimeError}` |
| `GET /api/admin/users` | `{users,total,page,pageSize,pages}` — `?q=&page=`; `PATCH /api/admin/users/:id` role/status changes (self-demotion and last-admin protected). |
| `GET /api/admin/audit` | `{logs,total,page,pageSize,pages}` |
| `GET /api/admin/plans` / `GET /api/admin/settings` / `GET /api/admin/deployments` | Plan/settings/deployment administration. |

## Statuses
Bot: `CREATED → BUILDING → DEPLOYING → RUNNING | FAILED`, plus `STOPPED`,
`RUNTIME_OFFLINE` (runtime down — honest, not inferred). Deployment:
`QUEUED → BUILDING → DEPLOYING → RUNNING | FAILED | CANCELED`.
