/**
 * Per-bot log capture:
 *  - a 1000-line in-memory ring buffer (served by GET /bots/:botId/logs), and
 *  - a rotated on-disk log file at {RUNTIME_DATA_DIR}/logs/{botId}.log
 *    (rotated to .old when it exceeds 5 MB; the previous .old is overwritten).
 *
 * File lines are prefixed "<ts> [stream] " for grep-ability; ring buffer lines keep
 * the raw text plus a numeric ts field.
 *
 * All file I/O is synchronous and wrapped in try/catch: a logging failure must
 * never take down the runtime or a bot.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { LogLine, LogStream } from "./types";

const RING_CAPACITY = 1000;
const ROTATE_BYTES = 5 * 1024 * 1024;

export class LogBuffer {
  private readonly ring: LogLine[] = [];
  private readonly filePath: string | null;

  constructor(filePath: string | null) {
    this.filePath = filePath;
    if (filePath !== null) {
      try {
        mkdirSync(dirname(filePath), { recursive: true });
      } catch (err) {
        console.error(`[logbuf] could not create log dir for ${filePath}:`, err);
      }
    }
  }

  push(stream: LogStream, text: string): void {
    const line: LogLine = { ts: Date.now(), stream, text };
    this.ring.push(line);
    if (this.ring.length > RING_CAPACITY) this.ring.shift();
    this.appendToFile(line);
  }

  /** Convenience for lifecycle events (spawn, exit, reconciliation, ...). */
  system(text: string): void {
    this.push("system", text);
  }

  /**
   * Returns the last `n` lines plus whether anything was omitted
   * (either because the ring had more lines than requested, or because it
   * already wrapped and older history was dropped).
   */
  tail(n: number): { lines: LogLine[]; truncated: boolean } {
    const total = this.ring.length;
    const count = Math.max(0, Math.min(n, total));
    return {
      lines: this.ring.slice(total - count),
      truncated: total > count || total === RING_CAPACITY,
    };
  }

  private appendToFile(line: LogLine): void {
    if (this.filePath === null) return;
    const text = `${line.ts} [${line.stream}] ${line.text}\n`;
    try {
      if (existsSync(this.filePath)) {
        if (statSync(this.filePath).size + text.length > ROTATE_BYTES) {
          renameSync(this.filePath, `${this.filePath}.old`);
        }
      }
      appendFileSync(this.filePath, text, "utf8");
    } catch (err) {
      console.error(`[logbuf] append failed for ${this.filePath}:`, err);
    }
  }
}

/**
 * Splits an arbitrary byte stream into complete lines, retaining any trailing
 * partial line until it is completed or explicitly flushed.
 */
export class LineSplitter {
  private pending = "";

  push(chunk: string): string[] {
    const lines: string[] = [];
    this.pending += chunk;
    let idx = this.pending.indexOf("\n");
    while (idx !== -1) {
      let line = this.pending.slice(0, idx);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      lines.push(line);
      this.pending = this.pending.slice(idx + 1);
      idx = this.pending.indexOf("\n");
    }
    return lines;
  }

  /** Returns any unterminated remainder (or null when the stream ended on a newline). */
  flush(): string | null {
    const rest = this.pending;
    this.pending = "";
    return rest.length > 0 ? rest : null;
  }
}
