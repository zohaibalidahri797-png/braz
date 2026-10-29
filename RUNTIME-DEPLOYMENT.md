# Deploying the bot runtime service

The runtime service (`mini-services/bot-runtime`) is the component that
actually runs user bots. **It cannot run on Cloudflare Workers** (no long-lived
processes, no process spawning) — it needs a normal Linux host: a VPS, a
container platform, or a bare-metal box.

## Architecture recap

```
┌──────────────────────┐        HTTPS + X-Runtime-Key        ┌──────────────────────────┐
│  Web app (Workers)   │ ───────────────────────────────────► │  botdock-runtime (Bun)   │
│  control plane       │                                      │  isolated bot processes  │
│  DB / auth / billing │ ◄─────────────────────────────────── │  /proc metrics, logs     │
└──────────────────────┘            JSON responses            └──────────────────────────┘
```

- The web app calls the runtime server-to-server only; every request carries
  the shared secret header `X-Runtime-Key`.
- The runtime binds to `127.0.0.1` — expose it through a reverse proxy with
  TLS (Caddy/nginx) or a private network, never raw to the internet.

## Deployment on a Linux server (systemd)

```bash
# 1. install bun (https://bun.sh)
curl -fsSL https://bun.sh/install | bash

# 2. copy the folder to the server, e.g. /opt/botdock-runtime
rsync -a mini-services/bot-runtime/ server:/opt/botdock-runtime/

# 3. create /opt/botdock-runtime/.env
cat > /opt/botdock-runtime/.env <<'EOF'
PORT=3030
RUNTIME_API_KEY=<openssl rand -hex 32>     # SAME value as the web app secret
RUNTIME_DATA_DIR=/var/lib/botdock-runtime  # bot files, logs, state
PYTHON_BIN=python3
NODE_BIN=node
BUN_BIN=/root/.bun/bin/bun
EOF

# 4. systemd unit
cat > /etc/systemd/system/botdock-runtime.service <<'EOF'
[Unit]
Description=BotDock bot runtime service
After=network.target

[Service]
WorkingDirectory=/opt/botdock-runtime
EnvironmentFile=/opt/botdock-runtime/.env
ExecStart=/root/.bun/bin/bun run start
Restart=always
RestartSec=3
# hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/botdock-runtime
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl enable --now botdock-runtime
```

## Web app wiring

In the web app environment:

```ini
RUNTIME_SERVICE_URL="https://runtime.your-domain.com"   # or private address
RUNTIME_API_KEY="<same secret as above>"
RUNTIME_EMBEDDED="false"
```

`/api/health` on the web app shows `runtime.ok=true` when the pair works.

### Endpoints the web app calls (all require `X-Runtime-Key`)

| Method + path | Purpose |
|---|---|
| `GET /health`, `GET /metrics` | liveness + per-bot stats |
| `POST /deploy` | stage workspace → install deps → start (returns real state) |
| `POST /bots/:id/start · stop · restart · undeploy` | lifecycle |
| `GET /bots/:id/status · logs · build-logs` | truthful state + logs |
| `GET /bots/:id/files?path=` · `GET /bots/:id/files/read` | file manager list/read |
| `PUT /bots/:id/files` · `POST /bots/:id/files/mkdir` · `DELETE /bots/:id/files` | write/mkdir/delete |
| `GET /bots/:id/files/download` · `POST /bots/:id/files/upload` | download / upload (archives extracted safely) |
| `GET /bots/:id/usage` · `POST /bots/:id/templates` | workspace bytes / template write |

The runtime owns ALL bot filesystem access (workspaces, staging, extraction).
The web app never reads or writes bot files locally — mandatory on Cloudflare
Workers and identical in development.

## Container option (recommended for stronger isolation)

The runtime currently isolates bots with rlimits + process groups + sanitized
environments. For a real security boundary, run **each bot in its own
container** in production. Two supported paths:

1. **Run the whole runtime service per-host with gVisor/Firecracker** on the
   host — the service code is unchanged.
2. **Modify the runtime's `startInternal`** to launch bots through
   `docker run --rm --memory=<limit> --cpus=<share> --pids-limit=<n>
   --network=none --read-only` instead of the ulimit wrapper. The state
   machine, logging and metrics APIs stay identical.

The repository keeps the process-level implementation because it runs
everywhere (including this sandbox); container hardening is a deployment-time
choice, documented rather than hidden.

## What the service guarantees

- **Truthful state**: `RUNNING` is only reported after a process survived a
  2-second grace check; exits are recorded with code/signal; service restarts
  reconcile previous RUNNING entries to `STOPPED (RUNTIME_RESTART)` instead of
  pretending they survived.
- **Real metrics**: RSS and CPU% sampled from `/proc` every 5 s; `unknown` is
  reported when a value cannot be measured — numbers are never fabricated.
- **Logs**: per-bot ring buffer (1000 lines) + rotated 5 MB files; build logs
  capped at 1 MB per deployment.
- **Data layout** (under `RUNTIME_DATA_DIR`):
  - `workspace/<botId>/` — persistent project files (web app file manager)
  - `staging/<botId>/<deploymentId>/` — deployment payloads (transient)
  - `bots/<botId>/current` — deployed code the process runs from
  - `logs/<botId>.log`, `builds/<deploymentId>.log`, `state.json`

## Backups

Snapshot `RUNTIME_DATA_DIR` (rsync/restic). `state.json` is rebuilt-safe: a
missing/corrupt file yields an empty registry; running bots are reconciled to
STOPPED on the next boot — nothing is invented.

## Monitoring

- `GET /health` (with the API key) — liveness + host stats
- `GET /metrics` — per-bot state/memory/CPU summary
- The web app's Admin → Overview surfaces both; the landing page badge shows
  runtime online/offline honestly.
