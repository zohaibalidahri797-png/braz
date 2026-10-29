/**
 * Process isolation building blocks (NO Docker on this host — see README):
 *  - rlimit wrapper command executed via /bin/sh (ulimit -v/-t/-u/-f),
 *  - sanitized child environment (fixed PATH, HOME jailed to bot dir,
 *    user-supplied PATH/HOME/LD_PRELOAD stripped),
 *  - internal port allocator (counter starting at 3100),
 *  - start command resolution with entry-file existence validation.
 *
 * Isolation here is process-level and best-effort. Production must use
 * containers/VMs — documented honestly in README.md.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BotLimits, BotRuntime } from "./types";

const BASE_PATH = "/home/z/.venv/bin:/usr/local/bin:/usr/bin:/bin";
const FORBIDDEN_ENV_KEYS = new Set(["PATH", "HOME", "LD_PRELOAD"]);
const SOURCE_FILE_EXT = /\.(py|js|ts|mjs|cjs|jsx|tsx|mts|cts)$/;

export interface Bins {
  python: string;
  node: string;
  bun: string;
}

// ---------------------------------------------------------------------------
// Port allocation
// ---------------------------------------------------------------------------

let nextPort = 3100;
const portsInUse = new Set<number>();

/** Allocates a port from the internal counter, never reusing one while in use. */
export function allocatePort(): number {
  for (let i = 0; i < 62000; i++) {
    const candidate = nextPort;
    nextPort = candidate >= 65000 ? 3100 : candidate + 1;
    if (!portsInUse.has(candidate)) {
      portsInUse.add(candidate);
      return candidate;
    }
  }
  throw new Error("port pool exhausted (3100..65000 all in use)");
}

export function releasePort(port: number | null): void {
  if (port !== null) portsInUse.delete(port);
}

// ---------------------------------------------------------------------------
// Identifier validation (path-traversal defence)
// ---------------------------------------------------------------------------

export const ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export function isValidId(id: unknown): id is string {
  return typeof id === "string" && ID_PATTERN.test(id);
}

// ---------------------------------------------------------------------------
// Shell wrapper
// ---------------------------------------------------------------------------

/**
 * Builds the /bin/sh command string. The hard rlimits are set before exec so a
 * user command cannot raise them (unprivileged processes can only lower limits).
 * `nice -n 10` is prepended (inside exec, preserving the pid) when cpuPercent < 50.
 *
 * Memory note: `ulimit -v` bounds VIRTUAL address space, which for Python/Node
 * runtimes is much larger than resident memory (thread stacks, mmapped libs,
 * reserved arenas). We therefore set -v to a generous multiple of the plan's
 * RSS-oriented memory limit (8×, min 1GB, max 6GB) so normal runtimes can map
 * what they need while runaway processes are still bounded. Real RSS is measured
 * via /proc and enforced through NODE_OPTIONS for JS runtimes. This is a
 * documented approximation of container memory limits, not an exact quota.
 */
export function buildWrapperCommand(startCommand: string, limits: BotLimits): string {
  const vaKb = Math.min(
    Math.max(Math.floor(limits.memoryMb) * 8 * 1024, 1024 * 1024),
    6 * 1024 * 1024,
  );
  // RLIMIT_NPROC is per-USER, not per-bot: in shared-uid environments the uid
  // may already own processes outside our PID namespace, so a small value
  // (e.g. 64) breaks even single-thread creation. Floor at 4096 (still stops
  // trivial fork bombs; exact per-bot protection requires containers — see
  // README). The plan's maxProcesses is additionally enforced logically.
  const maxProcs = Math.max(4096, Math.floor(limits.maxProcesses));
  const nice = limits.cpuPercent < 50 ? "nice -n 10 " : "";
  return [
    `ulimit -v ${vaKb}`,
    "ulimit -t 86400",
    `ulimit -u ${maxProcs}`,
    "ulimit -f 262144",
    `exec ${nice}${startCommand}`,
  ].join("; ");
}

// ---------------------------------------------------------------------------
// Environment sanitization
// ---------------------------------------------------------------------------

export interface SanitizedEnv {
  env: Record<string, string>;
  /** Warnings to be surfaced into the bot's log buffer as "system" lines. */
  warnings: string[];
}

export function buildChildEnv(opts: {
  botDir: string;
  runtime: BotRuntime;
  userEnv: Record<string, string>;
  limits: BotLimits;
  port: number;
}): SanitizedEnv {
  const warnings: string[] = [];
  const userEnv = opts.userEnv ?? {};
  const filtered: Record<string, string> = {};

  for (const [key, value] of Object.entries(userEnv)) {
    if (FORBIDDEN_ENV_KEYS.has(key)) {
      warnings.push(`ignored forbidden env var "${key}" from user config (PATH/HOME/LD_PRELOAD are not overridable)`);
      continue;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      warnings.push(`ignored env var with invalid name: ${JSON.stringify(key)}`);
      continue;
    }
    filtered[key] = String(value);
  }

  const env: Record<string, string> = {
    PATH: BASE_PATH,
    HOME: opts.botDir,
    LANG: "C.UTF-8",
    PYTHONUNBUFFERED: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PORT: String(opts.port),
    NODE_ENV: "production",
  };
  if (existsSync(join(opts.botDir, ".botdock-deps"))) {
    env.PYTHONPATH = ".botdock-deps";
  }
  if (opts.runtime === "NODE" || opts.runtime === "BUN") {
    env.NODE_OPTIONS = `--max-old-space-size=${Math.max(32, Math.floor(opts.limits.memoryMb))}`;
  }

  // User values override the base — except the stripped keys above.
  for (const [key, value] of Object.entries(filtered)) {
    env[key] = value;
  }
  return { env, warnings };
}

// ---------------------------------------------------------------------------
// Start command resolution
// ---------------------------------------------------------------------------

export type ResolvedCommand = { ok: true; command: string } | { ok: false; error: string };

interface PackageJsonInfo {
  scripts: Record<string, string>;
}

function readPackageJson(botDir: string): PackageJsonInfo | null {
  try {
    const raw = readFileSync(join(botDir, "package.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const scripts = (parsed as Record<string, unknown>).scripts;
    if (typeof scripts !== "object" || scripts === null) return { scripts: {} };
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(scripts as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return { scripts: out };
  } catch {
    return null;
  }
}

function fileExists(botDir: string, rel: string): boolean {
  return existsSync(join(botDir, rel));
}

/**
 * For explicit user commands: verify any referenced source entry file actually
 * exists in the bot dir, so we fail with "entry file not found: X" instead of a
 * fake success. Commands without obvious source-file tokens (e.g. `python3 -m pkg`)
 * are allowed through.
 */
function checkEntryFiles(command: string, botDir: string): string | null {
  const tokens = command.trim().split(/\s+/).map((t) => t.replace(/^["']|["']$/g, ""));
  const candidates: string[] = [];
  for (const token of tokens) {
    if (!SOURCE_FILE_EXT.test(token)) continue;
    candidates.push(token.startsWith("/") ? token : join(botDir, token.replace(/^\.\//, "")));
  }
  if (candidates.length === 0) return null;
  if (candidates.some((p) => existsSync(p))) return null;
  return `entry file not found: ${candidates.join(", ")}`;
}

export function resolveStartCommand(opts: {
  runtime: BotRuntime;
  startCommand: string;
  botDir: string;
  bins: Bins;
}): ResolvedCommand {
  const { runtime, botDir, bins } = opts;
  const explicit = opts.startCommand.trim();

  if (explicit.length > 0) {
    const entryError = checkEntryFiles(explicit, botDir);
    if (entryError !== null) return { ok: false, error: entryError };
    return { ok: true, command: explicit };
  }

  const pkg = readPackageJson(botDir);
  if (runtime === "PYTHON") {
    if (fileExists(botDir, "main.py")) return { ok: true, command: `${bins.python} main.py` };
    if (fileExists(botDir, "bot.py")) return { ok: true, command: `${bins.python} bot.py` };
    return {
      ok: false,
      error: "entry file not found: main.py (also tried bot.py); provide an explicit startCommand",
    };
  }
  if (runtime === "NODE") {
    if (pkg !== null && (pkg.scripts.start ?? "").length > 0) {
      return { ok: true, command: `${bins.bun} run start` };
    }
    if (fileExists(botDir, "index.js")) return { ok: true, command: `${bins.node} index.js` };
    if (fileExists(botDir, "bot.js")) return { ok: true, command: `${bins.node} bot.js` };
    return {
      ok: false,
      error: "entry file not found: index.js (also tried bot.js and package.json scripts.start); provide an explicit startCommand",
    };
  }
  // BUN
  if (pkg !== null && (pkg.scripts.start ?? "").length > 0) {
    return { ok: true, command: `${bins.bun} run start` };
  }
  if (fileExists(botDir, "main.ts")) return { ok: true, command: `${bins.bun} run main.ts` };
  return {
    ok: false,
    error: "entry file not found: package.json scripts.start or main.ts; provide an explicit startCommand",
  };
}
