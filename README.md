# botdock-runtime

BotDock Cloud **persistent bot runtime service**. Executes user-submitted bot code
(Python / Node / Bun) as isolated child processes and reports **truthful, measured
status** — every number it serves comes from `/proc` or the actual process tree.
There is no fake data anywhere: when a value cannot be measured it is reported as
`"unknown"` / `null`.

- Runtime: Bun + TypeScript, **zero external npm dependencies** (bun/node stdlib only).
- Listen address: `http://127.0.0.1:3030` — bound to loopback ONLY.
- Sole intended client: the Next.js web app (server-to-server). The browser can
  never reach this service and must never be given the runtime key.

## Configuration (environment variables)

| Variable           | Default   | Meaning                                                        |
| ------------------ | --------- | -------------------------------------------------------------- |
| `PORT`             | `3030`    | Listen port (only this variable is read for the listen port).  |
| `RUNTIME_API_KEY`  | —         | **Required.** If unset at boot the service logs a fatal error and `exit(1)`. |
| `RUNTIME_DATA_DIR` | `./data`  | Root for all state: `staging/`, `bots/`, `logs/`, `builds/`, `state.json`. |
| `PYTHON_BIN`       | `python3` | Python interpreter used for PYTHON bots and pip installs.      |
| `NODE_BIN`         | `node`    | Node binary used for default NODE start commands.              |
| `BUN_BIN`          | `bun`     | Bun binary used for installs and BUN bots / `bun run start`.   |

## Isolation model — honest limitations

There is **no Docker on this host**. Isolation is process-level only:

- rlimits via a `/bin/sh` wrapper: `ulimit -v <memoryMb*1024 KB>` (floor 65536),
  `ulimit -t 86400`, `ulimit -u <maxProcesses>`, `ulimit -f 262144`.
  Hard limits are set before `exec`, and unprivileged processes can only *lower*
  a hard limit, so a bot cannot raise them back.
- `setsid`-equivalent: children are spawned `detached` into their own process
  group; stops target the whole group via `kill(-pid, sig)` with a pid-kill fallback.
- Sanitized environment: fixed `PATH`, `HOME` jailed to the bot dir, no platform
  secrets; user-supplied `PATH`/`HOME`/`LD_PRELOAD` are stripped (logged as
  `system` lines in the bot's log).

Known caveats (documented, not hidden):

- `ulimit -u` (RLIMIT_NPROC) is enforced **per user**, not per bot: the check
  counts all of the user's processes/threads at fork time. A bot whose
  `maxProcesses` is far below the user's current process count may fail to fork.
- `ulimit -v` caps **virtual** address space. Bun/Node reserve large virtual
  ranges — give BUN bots `memoryMb >= 512` or they may fail to start.
- `nice -n 10` (applied when `cpuPercent < 50`) is a scheduling *priority*, not a
  hard CPU quota. `diskMb` is persisted and reported but **not enforceable**
  without filesystem quotas/containers. CPU% and memory are *measured* and
  reported truthfully every 5s; they are not hard-enforced either.
- There is **no filesystem, network, or syscall isolation**. `startCommand` is
  executed through `/bin/sh` by design (users may need shell syntax); a malicious
  user could read/write files the service user can access or open network
  connections. **Production must run each bot in a container or VM** (gVisor/
  Firecracker/seccomp + namespaces + network policy). This service is a
  development/sandbox-grade runtime only.

## API contract

All requests and responses are JSON. Every route — including `/health` — requires
header `X-Runtime-Key: <RUNTIME_API_KEY>` (missing/mismatched → `401 {"error":"unauthorized"}`).
Unknown routes/methods → `404 {"error":"not_found"}`. Malformed JSON bodies → `400 {"error":"invalid_json"}`.
`botId`/`deploymentId` must match `/^[a-zA-Z0-9_-]{1,64}$/` (checked before any filesystem use).

| Method & path | Body | Success response | Errors |
| --- | --- | --- | --- |
| `GET /health` | — | `200 {ok:true, service:"botdock-runtime", version:"1.0.0", uptimeSec, activeBots, host:{platform,cpus,totalMemMb,freeMemMb}}` | 401 |
| `POST /deploy` | `{botId, deploymentId, runtime:"PYTHON"\|"NODE"\|"BUN", startCommand, env, limits:{memoryMb,cpuPercent,diskMb,maxProcesses}, installTimeoutSec?}` | `200 {ok, state:"RUNNING"\|"FAILED", pid, port, buildLogTail:string[], error?}` (`ok` is `true` only when `state==="RUNNING"`) | `422` staging dir missing/empty; `400` validation; `200 {ok:false, state:"FAILED", error:"install_timeout", ...}` on install timeout |
| `POST /bots/:botId/start` | `{env?, limits?, startCommand?}` (all optional when persisted config exists) | `200 {ok:true, state:"RUNNING", pid, startedAt, port}` or `200 {ok:false, state:"FAILED", pid:null, startedAt:null, error, logTail}` | `404 bot_not_found` / `404 no_current_deployment`; `409 already_running`; `400` |
| `POST /bots/:botId/stop` | — | `200 {state:"STOPPED", killed:boolean}` (idempotent) | `404 bot_not_found` |
| `POST /bots/:botId/restart` | — | same shape as start | `404` / `409` |
| `POST /bots/:botId/undeploy` | — | `200 {ok:true}` (stops process, deletes `current`+`previous`, bot is removed from the registry → 404 afterwards) | `404 bot_not_found` |
| `GET /bots/:botId/status` | — | `200 {botId, state, pid, startedAt, uptimeSec, memoryMb, cpuPercent, lastExitCode, lastExitSignal, restarts, deploymentId, runtime, startCommand, port, limits, lastError}` (`memoryMb` is a number or `"unknown"`) | `404 bot_not_found` |
| `GET /bots/:botId/logs?tail=200` | — | `200 {lines:[{ts,stream:"out"\|"err"\|"system",text}], truncated}` (ring buffer, 1000 lines) | `404 bot_not_found` |
| `GET /bots/:botId/build-logs?deploymentId=&tail=200` | — | `200 {lines:string[], truncated}` (raw text lines from `builds/{deploymentId}.log`; `deploymentId` defaults to the bot's current deployment) | `404 bot_not_found` / `404 build_log_not_found` |
| `GET /metrics` | — | `200 {bots:[{botId,state,uptimeSec,memoryMb,cpuPercent,restarts}], totals:{active,running,failed}}` (`active` aliases `running`) | 401 |

A bot is "known" if it appears in `state.json` (loaded at boot) or the active
registry; anything else → `404`. `RUNNING` is only reported after the process has
survived a 2s startup grace check; a process that dies within the window yields
`FAILED` plus a log tail.

## State machine

`CREATED / BUILDING / DEPLOYING / RUNNING / STOPPED / FAILED`

- **deploy**: any → `BUILDING` → (`DEPLOYING` → `RUNNING`) or `FAILED`.
  Build = dependency install into the staging dir (pip `--target .botdock-deps`,
  or `bun install --production --no-progress`), then the staging dir is swapped
  into `bots/{botId}/current` (old `current` becomes `previous`, old `previous`
  is deleted), then the process starts.
- **start**: `STOPPED|FAILED|CREATED` → `RUNNING` or `FAILED` (requires a current deployment).
- **stop**: `RUNNING` → `STOPPED` (SIGTERM to the group, 5s grace, then SIGKILL).
- **exit**: within the 2s start grace → `FAILED`; else exit code 0 or signal
  SIGTERM/SIGINT/SIGKILL → `STOPPED`, anything else → `FAILED`. Every unexpected
  exit increments `restarts`.
- **boot reconciliation**: bots recorded `RUNNING` in `state.json` are marked
  `STOPPED` with `lastExitSignal="RUNTIME_RESTART"`, a `system` line is written
  into their log, and orphaned pids that still belong to the bot are SIGKILLed.
  The service never claims a restarted-away process is still running.

Every transition is persisted to `{RUNTIME_DATA_DIR}/state.json`
(`{bots:{[botId]:{state,deploymentId,runtime,startCommand,env,limits,pid,startedAt,lastExitCode,lastExitSignal,restarts,updatedAt}}}`)
using tmp-file + rename (atomic).

## Data layout

```
$RUNTIME_DATA_DIR/
  staging/{botId}/{deploymentId}/   # upload target; validated non-empty at deploy
  bots/{botId}/current/             # live deployment (atomically swapped)
  bots/{botId}/previous/            # previous deployment
  logs/{botId}.log                  # runtime logs, 5MB rotation to .old
  builds/{deploymentId}.log         # install/build output, 1MB cap + truncation note
  state.json                        # persisted state machine
```

## Metrics

Every 5s, for each RUNNING bot, the sampler walks `/proc` and aggregates over the
bot's whole process group: `memoryMb` = Σ `VmRSS` (from `/proc/<pid>/status`),
`cpuPercent` = Δ(utime+stime)/Δt against the previous sample (baseline primed at
spawn; `CLK_TCK` detected via `getconf CLK_TCK`, fallback 100). Unmeasurable →
`"unknown"` / `null`. Never fabricated.

## Running

```bash
RUNTIME_API_KEY=... PORT=3030 RUNTIME_DATA_DIR=/var/lib/botdock-runtime bun src/index.ts
# or: bun run dev   (hot reload)
```

Graceful shutdown: `SIGTERM`/`SIGINT` → all running bots get SIGTERM (3s wait,
then SIGKILL), state is persisted, process exits.
