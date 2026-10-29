/**
 * BotManager: the process registry + state machine + persistence.
 *
 * State machine (enforced, never faked):
 *   CREATED / BUILDING / DEPLOYING / RUNNING / STOPPED / FAILED
 *   - deploy:  any → BUILDING → (DEPLOYING → RUNNING) | FAILED
 *   - start:   CREATED|STOPPED|FAILED → RUNNING | FAILED (needs a current deployment)
 *   - stop:    RUNNING → STOPPED (idempotent when already stopped)
 *   - exit:    within 2s start-grace → FAILED; else exit 0 / SIGTERM / SIGINT /
 *              SIGKILL → STOPPED, anything else → FAILED. Unexpected exits
 *              increment the restarts counter.
 *
 * Every transition is persisted to {RUNTIME_DATA_DIR}/state.json via atomic
 * tmp-file + rename. On boot, bots recorded RUNNING are reconciled: because a
 * service restart invalidates process-group handles, they are marked STOPPED
 * with lastExitSignal="RUNTIME_RESTART" and a system line is written into their
 * log buffer. We do NOT pretend they still run.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  allocatePort,
  buildChildEnv,
  buildWrapperCommand,
  isValidId,
  releasePort,
  resolveStartCommand,
} from "./isolation";
import type { Bins } from "./isolation";
import { BuildLogStore, installDependencies } from "./install";
import { LineSplitter, LogBuffer } from "./logbuf";
import { MetricsSampler } from "./metrics";
import {
  DEFAULT_LIMITS,
  isBotRuntime,
  isBotState,
  isStringRecord,
  type BotLimits,
  type BotState,
  type BotStatus,
  type DeployRequest,
  type LogLine,
  type MetricsSnapshot,
  type PersistedBot,
  type RuntimeStateFile,
  type StartRequest,
} from "./types";

const START_GRACE_MS = 2000;
const STOP_TERM_GRACE_MS = 5000;
const STOP_KILL_GRACE_MS = 2000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

export function normalizeLimits(raw?: Partial<BotLimits> | null): BotLimits {
  const merged = { ...DEFAULT_LIMITS, ...(raw ?? {}) };
  return {
    memoryMb: clampInt(merged.memoryMb, 32, 8192),
    cpuPercent: clampInt(merged.cpuPercent, 1, 100),
    diskMb: clampInt(merged.diskMb, 1, 1_048_576),
    maxProcesses: clampInt(merged.maxProcesses, 1, 4096),
  };
}

function clampInstallTimeout(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 300;
  return clampInt(Math.round(raw), 5, 3600);
}

function isNonEmptyDir(path: string): boolean {
  try {
    return statSync(path).isDirectory() && readdirSync(path).length > 0;
  } catch {
    return false;
  }
}

/** Recursively removes symlinks from a staged copy (defence in depth). */
function stripSymlinks(dir: string): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) rmSync(p, { force: true });
    else if (e.isDirectory()) stripSymlinks(p);
  }
}

function procAlive(pid: number): boolean {
  if (process.platform === "linux") {
    return existsSync(`/proc/${pid}`);
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function procCmdline(pid: number): string | null {
  if (process.platform !== "linux") return null;
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
  } catch {
    return null;
  }
}

interface BotEntry {
  botId: string;
  state: BotState;
  deploymentId: string | null;
  runtime: import("./types").BotRuntime | null;
  startCommand: string;
  env: Record<string, string>;
  limits: BotLimits;
  pid: number | null;
  port: number | null;
  startedAt: number | null;
  lastExitCode: number | null;
  lastExitSignal: string | null;
  restarts: number;
  lastError: string | null;
  /** True while a manager-initiated stop is in flight (exit then counts as expected). */
  stopping: boolean;
  child: ChildProcessWithoutNullStreams | null;
  logbuf: LogBuffer;
}

export type DeployOutcome =
  | { kind: "staging_invalid"; error: string }
  | {
      kind: "done";
      ok: boolean;
      state: BotState;
      pid: number | null;
      port: number | null;
      error: string | null;
      buildLogTail: string[];
    };

export type StartOutcome =
  | { kind: "bot_not_found" }
  | { kind: "already_running" }
  | { kind: "no_current_deployment"; error: string }
  | { kind: "failed"; error: string; logTail: LogLine[] }
  | { kind: "started"; pid: number; startedAt: number; port: number };

export type StopOutcome = { kind: "bot_not_found" } | { kind: "stopped"; killed: boolean };

export type UndeployOutcome = { kind: "bot_not_found" } | { kind: "ok" };

interface InternalStartResult {
  ok: boolean;
  state: BotState;
  pid: number | null;
  startedAt: number | null;
  port: number | null;
  error: string | null;
  logTail: LogLine[];
  /** why a start could not proceed (drives HTTP status mapping) */
  failure: "no_current_deployment" | "no_runtime" | "start_error" | null;
}

export class BotManager {
  private readonly dataDir: string;
  private readonly bins: Bins;
  private readonly entries = new Map<string, BotEntry>();
  private readonly buildLogs: BuildLogStore;
  private readonly sampler: MetricsSampler;
  private readonly locks = new Map<string, Promise<unknown>>();
  private persistChain: Promise<void> = Promise.resolve();

  constructor(dataDir: string, bins: Bins) {
    this.dataDir = dataDir;
    this.bins = bins;
    for (const sub of ["staging", "bots", "logs", "builds"]) {
      mkdirSync(join(dataDir, sub), { recursive: true });
    }
    this.buildLogs = new BuildLogStore(join(dataDir, "builds"));
    this.sampler = new MetricsSampler();
    this.sampler.start(() =>
      this.entriesValuees()
        .filter((e) => this.isRunning(e) && e.pid !== null)
        .flatMap((e) => (e.pid !== null ? [e.pid] : [])),
    );
    this.loadState();
  }

  private entriesValuees(): BotEntry[] {
    return [...this.entries.values()];
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private toPersisted(entry: BotEntry): PersistedBot {
    const running = this.isRunning(entry);
    return {
      state: entry.state,
      deploymentId: entry.deploymentId,
      runtime: entry.runtime,
      startCommand: entry.startCommand,
      env: entry.env,
      limits: entry.limits,
      pid: running ? entry.pid : null,
      startedAt: running ? entry.startedAt : null,
      lastExitCode: entry.lastExitCode,
      lastExitSignal: entry.lastExitSignal,
      restarts: entry.restarts,
      updatedAt: Date.now(),
    };
  }

  /** Atomic persist: write tmp then rename; concurrent calls are serialized. */
  persist(): Promise<void> {
    const run = async (): Promise<void> => {
      const file: RuntimeStateFile = { bots: {} };
      for (const entry of this.entriesValuees()) {
        file.bots[entry.botId] = this.toPersisted(entry);
      }
      const finalPath = join(this.dataDir, "state.json");
      const tmpPath = `${finalPath}.tmp`;
      await writeFile(tmpPath, JSON.stringify(file, null, 2), "utf8");
      await rename(tmpPath, finalPath);
    };
    const next = this.persistChain.then(run).catch((err) => {
      console.error("[manager] state.json persist failed:", err);
    });
    this.persistChain = next;
    return next;
  }

  private loadState(): void {
    let raw: string;
    try {
      raw = readFileSync(join(this.dataDir, "state.json"), "utf8");
    } catch {
      return; // first boot — nothing to reconcile
    }
    let parsed: RuntimeStateFile;
    try {
      parsed = JSON.parse(raw) as RuntimeStateFile;
    } catch (err) {
      console.error("[manager] state.json is corrupt; starting with an empty registry:", err);
      return;
    }
    const bots = parsed?.bots ?? {};
    for (const [botId, p] of Object.entries(bots)) {
      if (!isValidId(botId) || typeof p !== "object" || p === null) {
        console.error(`[manager] skipping invalid bot entry in state.json: ${JSON.stringify(botId)}`);
        continue;
      }
      const entry = this.createEntry(botId);
      entry.state = isBotState(p.state) ? p.state : "STOPPED";
      entry.deploymentId = typeof p.deploymentId === "string" ? p.deploymentId : null;
      entry.runtime = isBotRuntime(p.runtime) ? p.runtime : null;
      entry.startCommand = typeof p.startCommand === "string" ? p.startCommand : "";
      entry.env = isStringRecord(p.env) ? p.env : {};
      entry.limits = normalizeLimits(p.limits);
      entry.pid = typeof p.pid === "number" ? p.pid : null;
      entry.startedAt = typeof p.startedAt === "number" ? p.startedAt : null;
      entry.lastExitCode = typeof p.lastExitCode === "number" ? p.lastExitCode : null;
      entry.lastExitSignal = typeof p.lastExitSignal === "string" ? p.lastExitSignal : null;
      entry.restarts = typeof p.restarts === "number" ? p.restarts : 0;
      if (entry.state === "RUNNING") this.reconcileRunning(entry);
    }
    if (Object.keys(bots).length > 0) {
      console.log(`[manager] loaded ${Object.keys(bots).length} bot(s) from state.json`);
    }
    void this.persist();
  }

  /**
   * A previous runtime instance recorded this bot as RUNNING. Our process-group
   * handles are gone; verify pid liveness, kill orphans that still belong to
   * this bot, and mark the bot STOPPED with lastExitSignal=RUNTIME_RESTART.
   */
  private reconcileRunning(entry: BotEntry): void {
    const pid = entry.pid;
    if (pid !== null && procAlive(pid)) {
      const cmd = procCmdline(pid);
      if (cmd !== null && cmd.includes(join("bots", entry.botId, "current"))) {
        entry.logbuf.system(
          `runtime restart reconciliation: previous runtime instance left pid ${pid} alive; sending SIGKILL to its process group (stdio cannot be re-attached)`,
        );
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // already gone
          }
        }
      } else {
        entry.logbuf.system(
          `runtime restart reconciliation: recorded pid ${pid} is alive but does not appear to belong to this bot (possible pid reuse); leaving it untouched`,
        );
      }
    }
    entry.logbuf.system(
      `runtime restart reconciliation: bot was RUNNING as pid ${pid ?? "unknown"} when the runtime restarted; marked STOPPED with lastExitSignal=RUNTIME_RESTART (it is NOT assumed to still be running)`,
    );
    entry.state = "STOPPED";
    entry.pid = null;
    entry.startedAt = null;
    entry.child = null;
    entry.port = null;
    entry.lastExitSignal = "RUNTIME_RESTART";
  }

  // -------------------------------------------------------------------------
  // Registry helpers
  // -------------------------------------------------------------------------

  private createEntry(botId: string): BotEntry {
    const entry: BotEntry = {
      botId,
      state: "CREATED",
      deploymentId: null,
      runtime: null,
      startCommand: "",
      env: {},
      limits: { ...DEFAULT_LIMITS },
      pid: null,
      port: null,
      startedAt: null,
      lastExitCode: null,
      lastExitSignal: null,
      restarts: 0,
      lastError: null,
      stopping: false,
      child: null,
      logbuf: new LogBuffer(join(this.dataDir, "logs", `${botId}.log`)),
    };
    this.entries.set(botId, entry);
    return entry;
  }

  isRunning(entry: BotEntry): boolean {
    return entry.state === "RUNNING" && entry.child !== null;
  }

  private transition(entry: BotEntry, to: BotState): void {
    const from = entry.state;
    if (from === to) {
      entry.logbuf.system(`state: ${to} (no change)`);
      return;
    }
    if (!BotManager.canTransition(from, to)) {
      throw new Error(`illegal state transition ${from} -> ${to} for bot ${entry.botId}`);
    }
    entry.state = to;
    entry.logbuf.system(`state: ${from} -> ${to}`);
  }

  private static canTransition(from: BotState, to: BotState): boolean {
    if (from === to) return true;
    if (to === "BUILDING") return true; // deploy may (re-)start from any state
    if (from === "BUILDING") return to === "DEPLOYING" || to === "FAILED";
    if (from === "DEPLOYING") return to === "RUNNING" || to === "FAILED";
    if (from === "RUNNING") return to === "STOPPED" || to === "FAILED";
    // CREATED | STOPPED | FAILED
    return to === "RUNNING" || to === "FAILED" || to === "STOPPED";
  }

  private withLock<T>(botId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(botId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(
      botId,
      next.catch(() => undefined),
    );
    return next;
  }

  // -------------------------------------------------------------------------
  // Deploy
  // -------------------------------------------------------------------------

  deploy(req: DeployRequest): Promise<DeployOutcome> {
    return this.withLock(req.botId, () => this.deployLocked(req));
  }

  private async deployLocked(req: DeployRequest): Promise<DeployOutcome> {
    const { botId, deploymentId } = req;
    const stagingDir = join(this.dataDir, "staging", botId, deploymentId);
    if (!isNonEmptyDir(stagingDir)) {
      // The runtime owns the workspace disk: stage from workspace/{botId}
      // itself. This works identically for the embedded development runtime and
      // the production runtime service (the web app may run on Cloudflare
      // Workers with no filesystem and cannot stage).
      const workspace = join(this.dataDir, "workspace", botId);
      if (!isNonEmptyDir(workspace)) {
        return {
          kind: "staging_invalid",
          error: `nothing to deploy: workspace/${botId} is empty or missing (upload files first)`,
        };
      }
      mkdirSync(join(this.dataDir, "staging", botId), { recursive: true });
      cpSync(workspace, stagingDir, { recursive: true, verbatimSymlinks: false });
      stripSymlinks(stagingDir); // defence in depth
      if (!isNonEmptyDir(stagingDir)) {
        return { kind: "staging_invalid", error: "workspace contains no deployable files" };
      }
    }

    let entry = this.entries.get(botId);
    if (entry === undefined) entry = this.createEntry(botId);

    try {
      // Stop any running process before rebuilding underneath it (best effort).
      if (this.isRunning(entry)) await this.stopInternal(entry);

      entry.deploymentId = deploymentId;
      entry.runtime = req.runtime;
      entry.startCommand = req.startCommand;
      entry.env = req.env;
      entry.limits = normalizeLimits(req.limits);
      entry.lastError = null;
      this.transition(entry, "BUILDING");
      await this.persist();

      this.buildLogs.begin(
        deploymentId,
        `deployment ${deploymentId} runtime=${req.runtime} staged=staging/${botId}/${deploymentId}`,
      );
      const buildLog = (stream: "out" | "err" | "system", text: string): void => {
        this.buildLogs.append(deploymentId, stream === "system" ? `[runtime] ${text}` : text);
      };

      const install = await installDependencies({
        dir: stagingDir,
        runtime: req.runtime,
        bins: this.bins,
        timeoutSec: clampInstallTimeout(req.installTimeoutSec),
        log: buildLog,
      });
      this.buildLogs.append(
        deploymentId,
        `[runtime] install finished: ${install.description} ok=${install.ok} timedOut=${install.timedOut} exitCode=${install.code}`,
      );

      if (install.timedOut) {
        entry.lastError = "install_timeout";
        this.transition(entry, "FAILED");
        await this.persist();
        return {
          kind: "done",
          ok: false,
          state: "FAILED",
          pid: null,
          port: null,
          error: "install_timeout",
          buildLogTail: this.buildLogs.tail(deploymentId, 100).lines,
        };
      }
      if (!install.ok) {
        entry.lastError = `install_failed (exit code ${install.code ?? "unknown"})`;
        this.transition(entry, "FAILED");
        await this.persist();
        return {
          kind: "done",
          ok: false,
          state: "FAILED",
          pid: null,
          port: null,
          error: entry.lastError,
          buildLogTail: this.buildLogs.tail(deploymentId, 100).lines,
        };
      }

      this.transition(entry, "DEPLOYING");

      // Atomic-ish swap: previous <- current (if any), current <- staging.
      const botRoot = join(this.dataDir, "bots", botId);
      mkdirSync(botRoot, { recursive: true });
      const current = join(botRoot, "current");
      const previous = join(botRoot, "previous");
      rmSync(previous, { recursive: true, force: true });
      if (existsSync(current)) renameSync(current, previous);
      renameSync(stagingDir, current);
      try {
        rmSync(join(this.dataDir, "staging", botId), { recursive: true, force: true });
      } catch {
        // best effort cleanup of the now-empty staging parent
      }
      entry.logbuf.system(`deployment ${deploymentId} swapped into bots/${botId}/current`);

      const start = await this.startInternal(entry, {});
      return {
        kind: "done",
        ok: start.state === "RUNNING",
        state: start.state,
        pid: start.pid,
        port: start.port,
        error: start.error,
        buildLogTail: this.buildLogs.tail(deploymentId, 100).lines,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[manager] deploy of ${botId}/${deploymentId} failed:`, err);
      entry.lastError = msg;
      try {
        this.transition(entry, "FAILED");
      } catch {
        // keep the current state if the machine forbids FAILED here
      }
      await this.persist();
      return {
        kind: "done",
        ok: false,
        state: "FAILED",
        pid: null,
        port: null,
        error: msg,
        buildLogTail: this.buildLogs.tail(deploymentId, 100).lines,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Start / stop / restart / undeploy
  // -------------------------------------------------------------------------

  start(botId: string, req: StartRequest): Promise<StartOutcome> {
    return this.withLock(botId, async () => {
      const entry = this.entries.get(botId);
      if (entry === undefined) return { kind: "bot_not_found" as const };
      if (this.isRunning(entry)) return { kind: "already_running" as const };
      return this.startMapped(entry, req);
    });
  }

  restart(botId: string): Promise<StartOutcome> {
    return this.withLock(botId, async () => {
      const entry = this.entries.get(botId);
      if (entry === undefined) return { kind: "bot_not_found" as const };
      if (this.isRunning(entry)) await this.stopInternal(entry);
      return this.startMapped(entry, {});
    });
  }

  private async startMapped(entry: BotEntry, req: StartRequest): Promise<StartOutcome> {
    const res = await this.startInternal(entry, req);
    if (res.ok && res.pid !== null && res.startedAt !== null && res.port !== null) {
      return { kind: "started", pid: res.pid, startedAt: res.startedAt, port: res.port };
    }
    if (res.failure === "no_current_deployment") {
      return { kind: "no_current_deployment", error: res.error ?? "no current deployment" };
    }
    return { kind: "failed", error: res.error ?? "start failed", logTail: res.logTail };
  }

  private async startInternal(entry: BotEntry, req: StartRequest): Promise<InternalStartResult> {
    const botDir = join(this.dataDir, "bots", entry.botId, "current");
    if (!isNonEmptyDir(botDir)) {
      return {
        ok: false,
        state: entry.state,
        pid: null,
        startedAt: null,
        port: null,
        error: "no current deployment for this bot; deploy first",
        logTail: [],
        failure: "no_current_deployment",
      };
    }
    if (entry.runtime === null) {
      return {
        ok: false,
        state: entry.state,
        pid: null,
        startedAt: null,
        port: null,
        error: "bot has no runtime configured; deploy first",
        logTail: [],
        failure: "no_runtime",
      };
    }

    // Merge persisted config with per-request overrides (request wins).
    const limits = normalizeLimits(req.limits ?? entry.limits);
    const userEnv: Record<string, string> = { ...entry.env, ...(req.env ?? {}) };
    const startCommand = req.startCommand !== undefined ? req.startCommand : entry.startCommand;
    entry.limits = limits;
    entry.env = userEnv;
    entry.startCommand = startCommand;

    const resolved = resolveStartCommand({
      runtime: entry.runtime,
      startCommand,
      botDir,
      bins: this.bins,
    });
    if (!resolved.ok) {
      entry.lastError = resolved.error;
      entry.logbuf.system(`start failed: ${resolved.error}`);
      this.transition(entry, "FAILED");
      await this.persist();
      return {
        ok: false,
        state: "FAILED",
        pid: null,
        startedAt: null,
        port: null,
        error: resolved.error,
        logTail: entry.logbuf.tail(20).lines,
        failure: "start_error",
      };
    }

    const port = allocatePort();
    const { env, warnings } = buildChildEnv({
      botDir,
      runtime: entry.runtime,
      userEnv,
      limits,
      port,
    });
    for (const w of warnings) entry.logbuf.system(`env warning: ${w}`);

    const wrapper = buildWrapperCommand(resolved.command, limits);
    // bash supports `ulimit -u` (max processes); dash (/bin/sh on Debian) does not.
    const shell = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
    entry.logbuf.system(
      `starting: ${shell} -c ${JSON.stringify(wrapper)} (cwd=${botDir}, port=${port})`,
    );

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(shell, ["-c", wrapper], {
        cwd: botDir,
        env,
        detached: true, // own process group → group kills with kill(-pid)
        stdio: ["ignore", "pipe", "pipe"],
      }) as unknown as ChildProcessWithoutNullStreams;
    } catch (err) {
      releasePort(port);
      const msg = `spawn failed: ${err instanceof Error ? err.message : String(err)}`;
      entry.logbuf.system(msg);
      entry.lastError = msg;
      this.transition(entry, "FAILED");
      await this.persist();
      return {
        ok: false,
        state: "FAILED",
        pid: null,
        startedAt: null,
        port: null,
        error: msg,
        logTail: entry.logbuf.tail(20).lines,
        failure: "start_error",
      };
    }

    entry.child = child;
    entry.pid = child.pid ?? null;
    entry.port = port;
    entry.startedAt = Date.now();
    entry.stopping = false;
    entry.lastError = null;
    entry.logbuf.system(`process started with pid ${entry.pid}`);

    const outSplit = new LineSplitter();
    const errSplit = new LineSplitter();
    child.stdout.on("data", (chunk: Buffer) => {
      for (const line of outSplit.push(chunk.toString("utf8"))) entry.logbuf.push("out", line);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      for (const line of errSplit.push(chunk.toString("utf8"))) entry.logbuf.push("err", line);
    });
    child.on("error", (err: Error) => {
      entry.logbuf.system(`process error event: ${err.message}`);
    });
    child.on("close", () => {
      const outRest = outSplit.flush();
      if (outRest !== null) entry.logbuf.push("out", outRest);
      const errRest = errSplit.flush();
      if (errRest !== null) entry.logbuf.push("err", errRest);
    });
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      this.handleExit(entry, code, signal);
    });

    this.sampler.prime(entry.pid);
    this.transition(entry, "RUNNING");
    await this.persist();

    // 2s startup grace: the response only reports RUNNING if the process is
    // still alive after the window. The exit handler already flips to FAILED
    // (and captures logs) if it dies during the window.
    const graceEnd = entry.startedAt + START_GRACE_MS;
    while (Date.now() < graceEnd && this.isRunning(entry)) {
      await sleep(100);
    }
    if (!this.isRunning(entry)) {
      return {
        ok: false,
        state: entry.state,
        pid: entry.pid,
        startedAt: null,
        port: null,
        error:
          entry.lastError ??
          `process exited during the ${START_GRACE_MS / 1000}s startup grace period`,
        logTail: entry.logbuf.tail(20).lines,
        failure: "start_error",
      };
    }
    return {
      ok: true,
      state: "RUNNING",
      pid: entry.pid,
      startedAt: entry.startedAt,
      port,
      error: null,
      logTail: [],
      failure: null,
    };
  }

  private handleExit(entry: BotEntry, code: number | null, signal: NodeJS.Signals | null): void {
    const pid = entry.pid;
    const startedAt = entry.startedAt;
    entry.child = null;
    releasePort(entry.port);
    entry.port = null;
    entry.pid = null;
    entry.startedAt = null;
    entry.lastExitCode = code;
    entry.lastExitSignal = signal ?? null;

    const uptimeMs = startedAt !== null ? Date.now() - startedAt : null;
    entry.logbuf.system(
      `process (pid ${pid ?? "unknown"}) exited code=${code ?? "null"} signal=${signal ?? "null"} uptimeMs=${uptimeMs ?? "unknown"}`,
    );

    const withinStartGrace =
      startedAt !== null && Date.now() - startedAt < START_GRACE_MS && !entry.stopping;
    const wasStopping = entry.stopping;
    entry.stopping = false;

    if (withinStartGrace) {
      entry.lastError = `process exited during startup grace period (code=${code ?? "null"}, signal=${signal ?? "none"})`;
      entry.restarts += 1;
      this.transition(entry, "FAILED");
    } else if (wasStopping) {
      entry.lastError = null;
      this.transition(entry, "STOPPED");
    } else if (
      code === 0 ||
      signal === "SIGTERM" ||
      signal === "SIGINT" ||
      signal === "SIGKILL"
    ) {
      // Clean or signal-terminated exit that the manager did not initiate:
      // still an unexpected exit → count it.
      entry.lastError = null;
      entry.restarts += 1;
      this.transition(entry, "STOPPED");
    } else {
      entry.lastError = `process exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "none"})`;
      entry.restarts += 1;
      this.transition(entry, "FAILED");
    }
    void this.persist();
  }

  private signalTree(entry: BotEntry, sig: NodeJS.Signals): void {
    const pid = entry.pid;
    if (pid === null) return;
    try {
      process.kill(-pid, sig); // negative pid = whole process group
      return;
    } catch (err) {
      entry.logbuf.system(
        `group kill (${sig}) for pid ${pid} failed: ${err instanceof Error ? err.message : String(err)}; falling back to single-pid kill`,
      );
    }
    try {
      process.kill(pid, sig);
    } catch {
      // already gone
    }
  }

  private async stopInternal(entry: BotEntry): Promise<{ killed: boolean }> {
    if (!this.isRunning(entry)) {
      if (entry.state !== "STOPPED") {
        this.transition(entry, "STOPPED");
        await this.persist();
      }
      return { killed: false };
    }
    const pid = entry.pid;
    entry.stopping = true;
    entry.logbuf.system(`stop requested: sending SIGTERM to process group ${pid !== null ? -pid : "?"}`);
    this.signalTree(entry, "SIGTERM");
    const exited = await this.waitForExit(entry, STOP_TERM_GRACE_MS);
    if (!exited) {
      entry.logbuf.system(
        `process group did not exit within ${STOP_TERM_GRACE_MS / 1000}s; sending SIGKILL`,
      );
      this.signalTree(entry, "SIGKILL");
      await this.waitForExit(entry, STOP_KILL_GRACE_MS);
    }
    if (this.isRunning(entry)) {
      // Exit event has not fired yet (stuck child): force the transition so the
      // reported state is truthful about what we know.
      entry.child = null;
      releasePort(entry.port);
      entry.port = null;
      entry.pid = null;
      entry.startedAt = null;
      entry.lastExitSignal = entry.lastExitSignal ?? "SIGKILL";
      entry.lastExitCode = entry.lastExitCode ?? null;
      this.transition(entry, "STOPPED");
      await this.persist();
    }
    return { killed: true };
  }

  private async waitForExit(entry: BotEntry, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.isRunning(entry)) return true;
      await sleep(50);
    }
    return !this.isRunning(entry);
  }

  // -------------------------------------------------------------------------
  // Public surface used by the HTTP layer
  // -------------------------------------------------------------------------

  stop(botId: string): Promise<StopOutcome> {
    return this.withLock(botId, async () => {
      const entry = this.entries.get(botId);
      if (entry === undefined) return { kind: "bot_not_found" as const };
      const { killed } = await this.stopInternal(entry);
      return { kind: "stopped" as const, killed };
    });
  }

  undeploy(botId: string): Promise<UndeployOutcome> {
    return this.withLock(botId, async () => {
      const entry = this.entries.get(botId);
      if (entry === undefined) return { kind: "bot_not_found" as const };
      if (this.isRunning(entry)) await this.stopInternal(entry);
      rmSync(join(this.dataDir, "bots", botId, "current"), { recursive: true, force: true });
      rmSync(join(this.dataDir, "bots", botId, "previous"), { recursive: true, force: true });
      // Full cleanup: the workspace and any staging leftovers belong to this
      // bot. The web app no longer needs local filesystem access to delete it.
      rmSync(join(this.dataDir, "workspace", botId), { recursive: true, force: true });
      rmSync(join(this.dataDir, "staging", botId), { recursive: true, force: true });
      entry.logbuf.system(`undeployed: removed bots/, workspace/ and staging/ for ${botId}`);
      this.entries.delete(botId);
      await this.persist();
      return { kind: "ok" as const };
    });
  }

  getStatus(botId: string): { kind: "bot_not_found" } | { kind: "ok"; status: BotStatus } {
    const entry = this.entries.get(botId);
    if (entry === undefined) return { kind: "bot_not_found" };
    return { kind: "ok", status: this.statusOf(entry) };
  }

  private statusOf(entry: BotEntry): BotStatus {
    const running = this.isRunning(entry);
    const sample =
      running && entry.pid !== null ? this.sampler.get(entry.pid) : undefined;
    return {
      botId: entry.botId,
      state: entry.state,
      pid: running ? entry.pid : null,
      startedAt: running ? entry.startedAt : null,
      uptimeSec:
        running && entry.startedAt !== null
          ? Math.floor((Date.now() - entry.startedAt) / 1000)
          : null,
      memoryMb: sample?.memoryMb ?? "unknown",
      cpuPercent: sample?.cpuPercent ?? null,
      lastExitCode: entry.lastExitCode,
      lastExitSignal: entry.lastExitSignal,
      restarts: entry.restarts,
      deploymentId: entry.deploymentId,
      runtime: entry.runtime,
      startCommand: entry.startCommand,
      port: running ? entry.port : null,
      limits: entry.limits,
      lastError: entry.lastError,
    };
  }

  getLogs(
    botId: string,
    tail: number,
  ): { kind: "bot_not_found" } | { kind: "ok"; lines: LogLine[]; truncated: boolean } {
    const entry = this.entries.get(botId);
    if (entry === undefined) return { kind: "bot_not_found" };
    const { lines, truncated } = entry.logbuf.tail(tail);
    return { kind: "ok", lines, truncated };
  }

  getBuildLogs(
    botId: string,
    deploymentId: string | null,
    tail: number,
  ):
    | { kind: "bot_not_found" }
    | { kind: "log_not_found" }
    | { kind: "ok"; lines: string[]; truncated: boolean } {
    const entry = this.entries.get(botId);
    if (entry === undefined) return { kind: "bot_not_found" };
    const depId = deploymentId ?? entry.deploymentId;
    if (depId === null) return { kind: "log_not_found" };
    const { lines, truncated, exists } = this.buildLogs.tail(depId, tail);
    if (!exists) return { kind: "log_not_found" };
    return { kind: "ok", lines, truncated };
  }

  metricsSnapshot(): MetricsSnapshot {
    const bots = this.entriesValuees().map((entry) => {
      const running = this.isRunning(entry);
      const sample =
        running && entry.pid !== null ? this.sampler.get(entry.pid) : undefined;
      return {
        botId: entry.botId,
        state: entry.state,
        uptimeSec:
          running && entry.startedAt !== null
            ? Math.floor((Date.now() - entry.startedAt) / 1000)
            : null,
        memoryMb: sample?.memoryMb ?? "unknown",
        cpuPercent: sample?.cpuPercent ?? null,
        restarts: entry.restarts,
      };
    });
    const running = bots.filter((b) => b.state === "RUNNING").length;
    const failed = bots.filter((b) => b.state === "FAILED").length;
    return {
      bots,
      totals: { active: running, running, failed },
    };
  }

  healthSnapshot(): { activeBots: number } {
    return {
      activeBots: this.entriesValuees().filter((e) => this.isRunning(e)).length,
    };
  }

  /** Best-effort shutdown: TERM all groups, 3s wait, KILL stragglers, persist. */
  async shutdown(): Promise<void> {
    const running = this.entriesValuees().filter((e) => this.isRunning(e));
    for (const entry of running) {
      entry.stopping = true;
      entry.logbuf.system("runtime shutting down: sending SIGTERM to process group");
      this.signalTree(entry, "SIGTERM");
    }
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && running.some((e) => this.isRunning(e))) {
      await sleep(100);
    }
    for (const entry of running) {
      if (this.isRunning(entry)) {
        this.signalTree(entry, "SIGKILL");
        entry.child = null;
        releasePort(entry.port);
        entry.port = null;
        entry.pid = null;
        entry.startedAt = null;
        entry.lastExitSignal = entry.lastExitSignal ?? "SIGKILL";
        this.transition(entry, "STOPPED");
      }
    }
    this.sampler.stop();
    await this.persist();
  }
}
