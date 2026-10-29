/**
 * Shared types for the botdock-runtime service.
 *
 * The state machine is: CREATED / BUILDING / DEPLOYING / RUNNING / STOPPED / FAILED.
 * All persisted state lives in {RUNTIME_DATA_DIR}/state.json (atomic tmp+rename writes).
 */

export type BotRuntime = "PYTHON" | "NODE" | "BUN";

export type BotState =
  | "CREATED"
  | "BUILDING"
  | "DEPLOYING"
  | "RUNNING"
  | "STOPPED"
  | "FAILED";

export type LogStream = "out" | "err" | "system";

export interface LogLine {
  /** Wall-clock timestamp (Date.now()) at the moment the line was observed. */
  ts: number;
  stream: LogStream;
  text: string;
}

export interface BotLimits {
  memoryMb: number;
  cpuPercent: number;
  diskMb: number;
  maxProcesses: number;
}

/**
 * Defaults applied when a start/deploy request omits limits.
 * Values are clamped into sane ranges by normalizeLimits() in manager.ts.
 */
export const DEFAULT_LIMITS: BotLimits = {
  memoryMb: 256,
  cpuPercent: 100,
  diskMb: 1024,
  maxProcesses: 64,
};

export interface DeployRequest {
  botId: string;
  deploymentId: string;
  runtime: BotRuntime;
  startCommand: string;
  env: Record<string, string>;
  limits: BotLimits;
  installTimeoutSec: number;
}

export interface StartRequest {
  env?: Record<string, string>;
  limits?: Partial<BotLimits>;
  startCommand?: string;
}

/** Shape of each bot entry inside state.json. */
export interface PersistedBot {
  state: BotState;
  deploymentId: string | null;
  runtime: BotRuntime | null;
  startCommand: string;
  env: Record<string, string>;
  limits: BotLimits;
  pid: number | null;
  startedAt: number | null;
  lastExitCode: number | null;
  lastExitSignal: string | null;
  restarts: number;
  updatedAt: number;
}

/** Top-level state.json shape. */
export interface RuntimeStateFile {
  bots: Record<string, PersistedBot>;
}

/** Response body of GET /bots/:botId/status. */
export interface BotStatus {
  botId: string;
  state: BotState;
  pid: number | null;
  startedAt: number | null;
  uptimeSec: number | null;
  /** Measured RSS from /proc, or the literal string "unknown" when unmeasurable. Never fabricated. */
  memoryMb: number | "unknown";
  /** Measured CPU% over the last sampling window, or null when unmeasurable. */
  cpuPercent: number | null;
  lastExitCode: number | null;
  lastExitSignal: string | null;
  restarts: number;
  deploymentId: string | null;
  runtime: BotRuntime | null;
  startCommand: string;
  /** Port assigned for this run (informational; bots are usually long-polling). */
  port: number | null;
  limits: BotLimits;
  /** Last human-readable failure reason, if any. */
  lastError: string | null;
}

export interface MetricsBotEntry {
  botId: string;
  state: BotState;
  uptimeSec: number | null;
  memoryMb: number | "unknown";
  cpuPercent: number | null;
  restarts: number;
}

export interface MetricsSnapshot {
  bots: MetricsBotEntry[];
  totals: {
    /** Alias of `running`; kept for API stability. */
    active: number;
    running: number;
    failed: number;
  };
}

export function isBotRuntime(v: unknown): v is BotRuntime {
  return v === "PYTHON" || v === "NODE" || v === "BUN";
}

export function isBotState(v: unknown): v is BotState {
  return (
    v === "CREATED" ||
    v === "BUILDING" ||
    v === "DEPLOYING" ||
    v === "RUNNING" ||
    v === "STOPPED" ||
    v === "FAILED"
  );
}

export function isStringRecord(v: unknown): v is Record<string, string> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const rec = v as Record<string, unknown>;
  for (const value of Object.values(rec)) {
    if (typeof value !== "string") return false;
  }
  return true;
}
