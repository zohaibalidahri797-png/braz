/**
 * /proc-based RSS + CPU% sampling for Linux.
 *
 * Every 5 seconds the sampler walks /proc once and aggregates, per process
 * group leader pid (a bot's pid), over ALL member processes of that group:
 *   - memory: sum of VmRSS from /proc/<p>/status
 *   - cpu:    sum of utime+stime from /proc/<p>/stat (fields 14/15, clock ticks)
 * cpuPercent = deltaTicks / deltaMs * 100 / (CLK_TCK / 1000)
 *
 * On non-Linux hosts (or when /proc is missing) the sampler is disabled and
 * memory is reported as "unknown", cpuPercent as null. Numbers are NEVER
 * fabricated: when a value cannot be measured it is reported as such.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

export type MemoryMb = number | "unknown";

export interface ProcSample {
  memoryMb: MemoryMb;
  cpuPercent: number | null;
}

interface ProcAgg {
  rssKb: number;
  rssKnown: boolean;
  ticks: number;
}

interface TickBaseline {
  ticks: number;
  atMs: number;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const SAMPLE_PERIOD_MS = 5000;

export class MetricsSampler {
  readonly enabled: boolean;
  readonly clkTck: number;
  private readonly latest = new Map<number, ProcSample>();
  private readonly baselines = new Map<number, TickBaseline>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.enabled = process.platform === "linux" && existsSync("/proc/self/stat");
    this.clkTck = this.detectClkTck();
    if (!this.enabled) {
      console.error(
        '[metrics] /proc unavailable on this platform; memoryMb will be "unknown" and cpuPercent null',
      );
    }
  }

  start(getRunningPids: () => number[]): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      try {
        this.tick(getRunningPids());
      } catch (err) {
        console.error("[metrics] tick failed:", err);
      }
    }, SAMPLE_PERIOD_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get(pid: number): ProcSample | undefined {
    return this.latest.get(pid);
  }

  /**
   * Prime a CPU baseline immediately after spawn so the first 5s sample has a
   * real delta instead of reporting a fabricated 0%.
   */
  prime(pid: number | null): void {
    if (!this.enabled || pid === null) return;
    const parsed = this.readStat(pid);
    if (parsed !== null) {
      this.baselines.set(pid, { ticks: parsed.ticks, atMs: Date.now() });
    }
  }

  tick(runningPids: number[]): void {
    if (!this.enabled) return;
    const now = Date.now();
    const snapshot = runningPids.length > 0 ? this.walkProc() : new Map<number, ProcAgg>();
    const alive = new Set(runningPids);

    for (const pid of runningPids) {
      const agg = snapshot.get(pid);
      if (!agg) {
        this.latest.delete(pid);
        this.baselines.delete(pid);
        continue;
      }
      const prev = this.baselines.get(pid);
      let cpuPercent: number | null = null;
      if (prev) {
        const deltaMs = now - prev.atMs;
        const deltaTicks = agg.ticks - prev.ticks;
        if (deltaMs > 0 && deltaTicks >= 0) {
          // deltaTicks/deltaMs * 100 / (CLK_TCK/1000)  →  percent of one core
          cpuPercent = round1((deltaTicks / deltaMs) * 100 / (this.clkTck / 1000));
        }
      }
      this.baselines.set(pid, { ticks: agg.ticks, atMs: now });
      this.latest.set(pid, {
        memoryMb: agg.rssKnown ? round1(agg.rssKb / 1024) : "unknown",
        cpuPercent,
      });
    }

    for (const pid of this.latest.keys()) {
      if (!alive.has(pid)) this.latest.delete(pid);
    }
    for (const pid of this.baselines.keys()) {
      if (!alive.has(pid)) this.baselines.delete(pid);
    }
  }

  /** One /proc walk; aggregates per process group id. */
  private walkProc(): Map<number, ProcAgg> {
    const out = new Map<number, ProcAgg>();
    let entries: string[];
    try {
      entries = readdirSync("/proc");
    } catch {
      return out;
    }
    for (const name of entries) {
      if (!/^\d+$/.test(name)) continue;
      const parsed = this.readStat(Number(name));
      if (parsed === null) continue;
      let rssKb: number | null = null;
      try {
        const status = readFileSync(`/proc/${name}/status`, "utf8");
        const m = /VmRSS:\s+(\d+)\s+kB/.exec(status);
        if (m && m[1] !== undefined) rssKb = Number(m[1]);
      } catch {
        // Process vanished or RSS not exposed (e.g. kernel thread/zombie) — leave null.
      }
      const agg = out.get(parsed.pgrp) ?? { rssKb: 0, rssKnown: false, ticks: 0 };
      agg.ticks += parsed.ticks;
      if (rssKb !== null) {
        agg.rssKb += rssKb;
        agg.rssKnown = true;
      }
      out.set(parsed.pgrp, agg);
    }
    return out;
  }

  private readStat(pid: number): { pgrp: number; ticks: number } | null {
    try {
      const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = raw.lastIndexOf(")");
      if (close === -1) return null;
      const fields = raw.slice(close + 1).trim().split(" ");
      // fields[0] is field 3 (state). utime = field 14 → index 11,
      // stime = field 15 → index 12, pgrp = field 5 → index 2.
      const utime = Number(fields[11]);
      const stime = Number(fields[12]);
      const pgrp = Number(fields[2]);
      if (!Number.isFinite(utime) || !Number.isFinite(stime) || !Number.isFinite(pgrp)) {
        return null;
      }
      return { pgrp, ticks: utime + stime };
    } catch {
      return null;
    }
  }

  private detectClkTck(): number {
    if (!this.enabled) return 100;
    try {
      const res = spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8", timeout: 3000 });
      if (res.status === 0 && typeof res.stdout === "string") {
        const v = Number(res.stdout.trim());
        if (Number.isFinite(v) && v > 0) return v;
      }
    } catch {
      // fall through to fallback
    }
    console.error("[metrics] could not detect CLK_TCK; falling back to 100");
    return 100;
  }
}
