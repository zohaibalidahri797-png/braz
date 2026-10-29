/**
 * Dependency installers for the BUILDING phase, plus the build-log store.
 *
 *  - PYTHON: requirements.txt  → "$PYTHON_BIN -m pip install -r requirements.txt --target .botdock-deps --quiet"
 *            pyproject.toml    → "$PYTHON_BIN -m pip install . --target .botdock-deps"
 *            neither           → no-op
 *  - NODE/BUN: package.json    → "bun install --production --no-progress" (in the staging dir)
 *              no package.json → no-op
 *
 * Full stdout/stderr is captured into {RUNTIME_DATA_DIR}/builds/{deploymentId}.log
 * (capped at 1 MB with an explicit truncation note). Installs run detached in
 * their own process group so a timeout can kill the whole tree.
 */

import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { LineSplitter } from "./logbuf";
import type { BotRuntime } from "./types";

const BUILD_LOG_CAP_BYTES = 1024 * 1024;
const INSTALL_ENV_PATH = "/home/z/.venv/bin:/usr/local/bin:/usr/bin:/bin";

export interface InstallResult {
  ok: boolean;
  timedOut: boolean;
  code: number | null;
  skipped: boolean;
  description: string;
}

export type InstallLogFn = (stream: "out" | "err" | "system", text: string) => void;

// ---------------------------------------------------------------------------
// Build log store ({RUNTIME_DATA_DIR}/builds/{deploymentId}.log, 1MB cap)
// ---------------------------------------------------------------------------

export class BuildLogStore {
  private readonly dir: string;
  private readonly capped = new Set<string>();

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  private path(deploymentId: string): string {
    return join(this.dir, `${deploymentId}.log`);
  }

  /** Starts a fresh log (overwrites any previous log with the same deploymentId). */
  begin(deploymentId: string, header: string): void {
    this.capped.delete(deploymentId);
    try {
      writeFileSync(this.path(deploymentId), `=== botdock-runtime build ===\n${header}\n`, "utf8");
    } catch (err) {
      console.error(`[build-log] begin failed for ${deploymentId}:`, err);
    }
  }

  append(deploymentId: string, text: string): void {
    if (this.capped.has(deploymentId)) return;
    const file = this.path(deploymentId);
    try {
      let current = 0;
      try {
        current = statSync(file).size;
      } catch {
        current = 0;
      }
      const remaining = BUILD_LOG_CAP_BYTES - current;
      if (remaining <= 0) {
        this.capped.add(deploymentId);
        appendFileSync(file, "\n[build log truncated at 1MB cap]\n", "utf8");
        return;
      }
      if (text.length + 1 > remaining) {
        appendFileSync(file, `${text.slice(0, Math.max(0, remaining - 1))}\n`, "utf8");
        this.capped.add(deploymentId);
        appendFileSync(file, "[build log truncated at 1MB cap]\n", "utf8");
        return;
      }
      appendFileSync(file, `${text}\n`, "utf8");
    } catch (err) {
      console.error(`[build-log] append failed for ${deploymentId}:`, err);
    }
  }

  tail(
    deploymentId: string,
    n: number,
  ): { lines: string[]; truncated: boolean; exists: boolean } {
    let raw: string;
    try {
      raw = readFileSync(this.path(deploymentId), "utf8");
    } catch {
      return { lines: [], truncated: false, exists: false };
    }
    const all = raw.split("\n");
    if (all.length > 0 && all[all.length - 1] === "") all.pop();
    const count = Math.max(0, Math.min(n, all.length));
    return { lines: all.slice(all.length - count), truncated: all.length > count, exists: true };
  }
}

// ---------------------------------------------------------------------------
// Process runner for installs
// ---------------------------------------------------------------------------

interface RunOutcome {
  code: number | null;
  timedOut: boolean;
  spawnError: string | null;
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
    return;
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

function runInstallProcess(opts: {
  cwd: string;
  file: string;
  args: string[];
  timeoutMs: number;
  log: InstallLogFn;
}): Promise<RunOutcome> {
  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const child = spawn(opts.file, opts.args, {
      cwd: opts.cwd,
      env: { PATH: INSTALL_ENV_PATH, HOME: opts.cwd, LANG: "C.UTF-8" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const outSplit = new LineSplitter();
    const errSplit = new LineSplitter();
    child.stdout?.on("data", (chunk: Buffer) => {
      for (const line of outSplit.push(chunk.toString("utf8"))) opts.log("out", line);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      for (const line of errSplit.push(chunk.toString("utf8"))) opts.log("err", line);
    });

    const finish = (code: number | null, spawnError: string | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      const outRest = outSplit.flush();
      if (outRest !== null) opts.log("out", outRest);
      const errRest = errSplit.flush();
      if (errRest !== null) opts.log("err", errRest);
      resolve({ code, timedOut, spawnError });
    };

    timer = setTimeout(() => {
      timedOut = true;
      opts.log(
        "system",
        `install exceeded ${Math.round(opts.timeoutMs / 1000)}s timeout; killing install process tree`,
      );
      killTree(child.pid);
      // Safety net in case the exit event is delayed by stuck children.
      setTimeout(() => finish(null, null), 2000);
    }, opts.timeoutMs);

    child.on("error", (err: Error) => finish(null, err.message));
    child.on("exit", (code: number | null) => finish(code, null));
  });
}

function fromOutcome(
  r: RunOutcome,
  timedOutOk: boolean,
  skipped: boolean,
  description: string,
): InstallResult {
  if (r.spawnError !== null) {
    return { ok: false, timedOut: r.timedOut, code: null, skipped, description };
  }
  return { ok: timedOutOk ? !r.timedOut : r.code === 0, timedOut: r.timedOut, code: r.code, skipped, description };
}

// ---------------------------------------------------------------------------
// Public installer
// ---------------------------------------------------------------------------

export async function installDependencies(opts: {
  dir: string;
  runtime: BotRuntime;
  bins: { python: string; node: string; bun: string };
  timeoutSec: number;
  log: InstallLogFn;
}): Promise<InstallResult> {
  const { dir, runtime, bins, log } = opts;
  const timeoutMs = opts.timeoutSec * 1000;

  const runPip = async (args: string[], description: string): Promise<InstallResult> => {
    log("system", `install start: ${description}`);
    const r = await runInstallProcess({ cwd: dir, file: bins.python, args, timeoutMs, log });
    if (r.spawnError !== null) {
      log("system", `install spawn error: ${r.spawnError}`);
    } else {
      log("system", `install exit code: ${r.code ?? "null (killed)"}`);
    }
    return fromOutcome(r, true, false, description);
  };

  if (runtime === "PYTHON") {
    if (existsSync(join(dir, "requirements.txt"))) {
      return runPip(
        ["-m", "pip", "install", "-r", "requirements.txt", "--target", ".botdock-deps", "--quiet"],
        `${bins.python} -m pip install -r requirements.txt --target .botdock-deps --quiet`,
      );
    }
    if (existsSync(join(dir, "pyproject.toml"))) {
      return runPip(
        ["-m", "pip", "install", ".", "--target", ".botdock-deps"],
        `${bins.python} -m pip install . --target .botdock-deps`,
      );
    }
    log("system", "no python dependency file (requirements.txt / pyproject.toml) found; skipping dependency install");
    return { ok: true, timedOut: false, code: 0, skipped: true, description: "no dependency file (skipped)" };
  }

  // NODE / BUN
  if (existsSync(join(dir, "package.json"))) {
    const description = `${bins.bun} install --production --no-progress`;
    log("system", `install start: ${description}`);
    const r = await runInstallProcess({ cwd: dir, file: bins.bun, args: ["install", "--production", "--no-progress"], timeoutMs, log });
    if (r.spawnError !== null) {
      log("system", `install spawn error: ${r.spawnError}`);
    } else {
      log("system", `install exit code: ${r.code ?? "null (killed)"}`);
    }
    return fromOutcome(r, true, false, description);
  }
  log("system", "no package.json found; skipping dependency install");
  return { ok: true, timedOut: false, code: 0, skipped: true, description: "no dependency file (skipped)" };
}
