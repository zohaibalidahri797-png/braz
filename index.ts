/**
 * botdock-runtime HTTP server (Bun.serve).
 *
 * - Binds to 127.0.0.1 ONLY: the Next.js web app calls this service
 *   server-to-server; the browser must never reach it directly.
 * - Every route requires the exact X-Runtime-Key header (timing-safe compare on
 *   SHA-256 hashes). Missing/mismatched key → 401.
 * - JSON responses everywhere; JSON parse failures → 400; unknown routes → 404.
 * - Graceful shutdown on SIGTERM/SIGINT: stop all bots (3s best effort),
 *   persist state, exit.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import os from "node:os";
import { BotManager, normalizeLimits } from "./manager";
import {
  PathError,
  deletePath as fsDelete,
  downloadFile,
  handleUpload,
  listFiles,
  makeDir as fsMkdir,
  readFileContent,
  workspaceUsageBytes,
  writeTemplateFiles,
  writeFileContent,
  MAX_FILE_WRITE,
} from "./files";
import { isValidId } from "./isolation";
import { isBotRuntime, isStringRecord, type BotLimits, type DeployRequest } from "./types";

const VERSION = "1.0.0";

function fatal(message: string): never {
  console.error(`FATAL: ${message}`);
  process.exit(1);
}

// --- configuration ----------------------------------------------------------

const apiKeyEnv = process.env.RUNTIME_API_KEY;
if (apiKeyEnv === undefined || apiKeyEnv.length === 0) {
  fatal(
    "RUNTIME_API_KEY is not set. Refusing to start: every request must be authenticated " +
      "with the X-Runtime-Key header, and an unauthenticated runtime would be unsafe.",
  );
}
const apiKey: string = apiKeyEnv;

const port = Number(process.env.PORT ?? "3030");
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  fatal(`PORT must be an integer in [1, 65535], got: ${process.env.PORT ?? "(unset)"}`);
}

const dataDir =
  process.env.RUNTIME_DATA_DIR !== undefined && process.env.RUNTIME_DATA_DIR.trim() !== ""
    ? process.env.RUNTIME_DATA_DIR
    : "./data";

const bins = {
  python: process.env.PYTHON_BIN?.trim() || "python3",
  node: process.env.NODE_BIN?.trim() || "node",
  bun: process.env.BUN_BIN?.trim() || "bun",
};

const manager = new BotManager(dataDir, bins);
const bootedAtMs = Date.now();

// --- helpers ----------------------------------------------------------------

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Timing-safe secret comparison: compare SHA-256 digests, not raw strings. */
function authorized(req: Request): boolean {
  const provided = req.headers.get("x-runtime-key");
  if (provided === null || provided.length === 0) return false;
  const providedHash = createHash("sha256").update(provided, "utf8").digest();
  const expectedHash = createHash("sha256").update(apiKey, "utf8").digest();
  return timingSafeEqual(providedHash, expectedHash);
}

async function readJsonObject(
  req: Request,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { ok: false };
  }
  if (text.trim() === "") return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

function parseStringRecord(v: unknown): Record<string, string> | null {
  if (v === undefined) return {};
  if (!isStringRecord(v)) return null;
  return v;
}

/** Numeric-type validation; range clamping happens in normalizeLimits(). */
function parseLimitsInput(v: unknown): BotLimits | null {
  if (v === undefined) return normalizeLimits(undefined);
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const rec = v as Record<string, unknown>;
  for (const key of ["memoryMb", "cpuPercent", "diskMb", "maxProcesses"] as const) {
    const val = rec[key];
    if (val === undefined) continue;
    if (typeof val !== "number" || !Number.isFinite(val)) return null;
  }
  const partial: Partial<BotLimits> = {};
  if (rec.memoryMb !== undefined) partial.memoryMb = rec.memoryMb as number;
  if (rec.cpuPercent !== undefined) partial.cpuPercent = rec.cpuPercent as number;
  if (rec.diskMb !== undefined) partial.diskMb = rec.diskMb as number;
  if (rec.maxProcesses !== undefined) partial.maxProcesses = rec.maxProcesses as number;
  return normalizeLimits(partial);
}

function parseTail(url: URL): number {
  const raw = url.searchParams.get("tail");
  if (raw === null) return 200;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 200;
  return Math.min(Math.max(Math.floor(n), 1), 1000);
}

// --- route handlers ----------------------------------------------------------

function handleHealth(): Response {
  const { activeBots } = manager.healthSnapshot();
  return json(
    {
      ok: true,
      service: "botdock-runtime",
      version: VERSION,
      uptimeSec: Math.floor((Date.now() - bootedAtMs) / 1000),
      activeBots,
      host: {
        platform: process.platform,
        cpus: os.cpus().length,
        totalMemMb: Math.round(os.totalmem() / 1048576),
        freeMemMb: Math.round(os.freemem() / 1048576),
      },
    },
    200,
  );
}

async function handleDeploy(req: Request): Promise<Response> {
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return json({ error: "invalid_json" }, 400);
  const body = parsed.value;

  if (!isValidId(body.botId)) {
    return json(
      { error: "invalid or missing botId (must match /^[a-zA-Z0-9_-]{1,64}$/)" },
      400,
    );
  }
  if (!isValidId(body.deploymentId)) {
    return json(
      { error: "invalid or missing deploymentId (must match /^[a-zA-Z0-9_-]{1,64}$/)" },
      400,
    );
  }
  if (!isBotRuntime(body.runtime)) {
    return json({ error: "runtime must be one of: PYTHON, NODE, BUN" }, 400);
  }
  const startCommand = body.startCommand === undefined ? "" : body.startCommand;
  if (typeof startCommand !== "string") {
    return json({ error: "startCommand must be a string" }, 400);
  }
  if (startCommand.length > 500) {
    return json({ error: "startCommand exceeds the 500 character limit" }, 400);
  }
  const env = parseStringRecord(body.env);
  if (env === null) return json({ error: "env must be an object with string values" }, 400);
  const limits = parseLimitsInput(body.limits);
  if (limits === null) {
    return json(
      { error: "limits must be an object with numeric memoryMb, cpuPercent, diskMb, maxProcesses" },
      400,
    );
  }
  let installTimeoutSec = 300;
  if (body.installTimeoutSec !== undefined) {
    if (typeof body.installTimeoutSec !== "number" || !Number.isFinite(body.installTimeoutSec)) {
      return json({ error: "installTimeoutSec must be a number" }, 400);
    }
    installTimeoutSec = body.installTimeoutSec;
  }

  const request: DeployRequest = {
    botId: body.botId,
    deploymentId: body.deploymentId,
    runtime: body.runtime,
    startCommand,
    env,
    limits,
    installTimeoutSec,
  };
  const outcome = await manager.deploy(request);
  if (outcome.kind === "staging_invalid") {
    return json({ error: outcome.error }, 422);
  }
  const payload: Record<string, unknown> = {
    ok: outcome.ok,
    state: outcome.state,
    pid: outcome.pid,
    port: outcome.port,
    buildLogTail: outcome.buildLogTail,
  };
  if (outcome.error !== null) payload.error = outcome.error;
  return json(payload, 200);
}

async function handleStart(req: Request, botId: string): Promise<Response> {
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return json({ error: "invalid_json" }, 400);
  const body = parsed.value;
  const env = parseStringRecord(body.env);
  if (env === null) return json({ error: "env must be an object with string values" }, 400);
  const limits = parseLimitsInput(body.limits);
  if (limits === null) {
    return json(
      { error: "limits must be an object with numeric memoryMb, cpuPercent, diskMb, maxProcesses" },
      400,
    );
  }
  let startCommand: string | undefined;
  if (body.startCommand !== undefined) {
    if (typeof body.startCommand !== "string") {
      return json({ error: "startCommand must be a string" }, 400);
    }
    if (body.startCommand.length > 500) {
      return json({ error: "startCommand exceeds the 500 character limit" }, 400);
    }
    startCommand = body.startCommand;
  }

  const outcome = await manager.start(botId, {
    env,
    limits: limits ?? undefined,
    startCommand,
  });
  switch (outcome.kind) {
    case "bot_not_found":
      return json({ error: "bot_not_found" }, 404);
    case "already_running":
      return json({ error: "already_running" }, 409);
    case "no_current_deployment":
      return json({ error: "no_current_deployment", message: outcome.error }, 404);
    case "failed":
      return json(
        {
          ok: false,
          state: "FAILED",
          pid: null,
          startedAt: null,
          port: null,
          error: outcome.error,
          logTail: outcome.logTail,
        },
        200,
      );
    case "started":
      return json(
        {
          ok: true,
          state: "RUNNING",
          pid: outcome.pid,
          startedAt: outcome.startedAt,
          port: outcome.port,
        },
        200,
      );
  }
}

async function handleRestart(req: Request, botId: string): Promise<Response> {
  // Body is ignored; restart always uses the persisted config.
  await req.text().catch(() => "");
  const outcome = await manager.restart(botId);
  switch (outcome.kind) {
    case "bot_not_found":
      return json({ error: "bot_not_found" }, 404);
    case "already_running":
      return json({ error: "already_running" }, 409);
    case "no_current_deployment":
      return json({ error: "no_current_deployment", message: outcome.error }, 404);
    case "failed":
      return json(
        {
          ok: false,
          state: "FAILED",
          pid: null,
          startedAt: null,
          port: null,
          error: outcome.error,
          logTail: outcome.logTail,
        },
        200,
      );
    case "started":
      return json(
        {
          ok: true,
          state: "RUNNING",
          pid: outcome.pid,
          startedAt: outcome.startedAt,
          port: outcome.port,
        },
        200,
      );
  }
}

// --- file management handlers ------------------------------------------------

function filePathError(err: unknown): Response {
  if (err instanceof PathError) return json({ error: "file_error", message: err.message }, 400);
  return json({ error: "file_error", message: err instanceof Error ? err.message : String(err) }, 400);
}

function handleFilesList(botId: string, url: URL): Response {
  try {
    const entries = listFiles(dataDir, botId, url.searchParams.get("path") ?? "");
    return json({ ok: true, entries }, 200);
  } catch (err) {
    return filePathError(err);
  }
}

function handleFilesRead(botId: string, url: URL): Response {
  try {
    const file = readFileContent(dataDir, botId, url.searchParams.get("path") ?? "");
    return json({ ok: true, file: { path: url.searchParams.get("path") ?? "", ...file } }, 200);
  } catch (err) {
    return filePathError(err);
  }
}

async function handleFilesWrite(req: Request, botId: string): Promise<Response> {
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return json({ error: "invalid_json" }, 400);
  const { path: p, content } = parsed.value;
  if (typeof p !== "string" || p.length === 0 || p.length > 400) return json({ error: "path must be a string (1..400 chars)" }, 400);
  if (typeof content !== "string" || content.length > MAX_FILE_WRITE) return json({ error: "content must be a string within the size limit" }, 400);
  try {
    writeFileContent(dataDir, botId, p, content);
    return json({ ok: true }, 200);
  } catch (err) {
    return filePathError(err);
  }
}

async function handleFilesMkdir(req: Request, botId: string): Promise<Response> {
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return json({ error: "invalid_json" }, 400);
  const { path: p } = parsed.value;
  if (typeof p !== "string" || p.length === 0 || p.length > 400) return json({ error: "path must be a string (1..400 chars)" }, 400);
  try {
    fsMkdir(dataDir, botId, p);
    return json({ ok: true }, 200);
  } catch (err) {
    return filePathError(err);
  }
}

function handleFilesDelete(botId: string, url: URL): Response {
  const p = url.searchParams.get("path") ?? "";
  if (!p) return json({ error: "path_required" }, 400);
  try {
    fsDelete(dataDir, botId, p);
    return json({ ok: true }, 200);
  } catch (err) {
    return filePathError(err);
  }
}

function handleFilesDownload(botId: string, url: URL): Response {
  try {
    const { data, filename } = downloadFile(dataDir, botId, url.searchParams.get("path") ?? "");
    return new Response(new Uint8Array(data), {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${filename.replace(/[^\w.\-]/g, "_")}"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    return filePathError(err);
  }
}

async function handleFilesUpload(req: Request, botId: string): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "invalid_form", message: "expected multipart form with a file field" }, 400);
  }
  const file = form.get("file");
  if (!(file instanceof File)) return json({ error: "file_required" }, 400);
  const targetDir = String(form.get("path") ?? "");
  try {
    const data = Buffer.from(await file.arrayBuffer());
    const result = handleUpload(dataDir, botId, file.name, data, targetDir);
    return json({ ok: true, ...result }, 200);
  } catch (err) {
    return filePathError(err);
  }
}

function handleUsage(botId: string): Response {
  try {
    return json({ ok: true, bytes: workspaceUsageBytes(dataDir, botId) }, 200);
  } catch {
    return json({ ok: true, bytes: 0 }, 200);
  }
}

async function handleTemplates(req: Request, botId: string): Promise<Response> {
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return json({ error: "invalid_json" }, 400);
  const files = parsed.value.files;
  if (!isStringRecord(files)) return json({ error: "files must be an object of path→content strings" }, 400);
  for (const [k, v] of Object.entries(files)) {
    if (typeof v !== "string") return json({ error: "files must be an object of path→content strings" }, 400);
    if (k.length > 400 || v.length > MAX_FILE_WRITE) return json({ error: "template file exceeds limits" }, 400);
  }
  try {
    writeTemplateFiles(dataDir, botId, files as Record<string, string>);
    return json({ ok: true }, 200);
  } catch (err) {
    return filePathError(err);
  }
}

// --- router ------------------------------------------------------------------

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  const method = req.method;

  // Auth first: every route, known or not, requires the exact runtime key.
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);

  if (segments.length === 1 && segments[0] === "health" && method === "GET") {
    return handleHealth();
  }
  if (segments.length === 1 && segments[0] === "metrics" && method === "GET") {
    return json(manager.metricsSnapshot(), 200);
  }
  if (segments.length === 1 && segments[0] === "deploy" && method === "POST") {
    return handleDeploy(req);
  }

  if (segments[0] === "bots" && segments.length === 3) {
    const botId = segments[1];
    if (!isValidId(botId)) return json({ error: "invalid_bot_id" }, 400);
    const sub = segments[2];

    if (method === "GET" && sub === "status") {
      const outcome = manager.getStatus(botId);
      return outcome.kind === "bot_not_found"
        ? json({ error: "bot_not_found" }, 404)
        : json(outcome.status, 200);
    }
    if (method === "GET" && sub === "logs") {
      const outcome = manager.getLogs(botId, parseTail(url));
      return outcome.kind === "bot_not_found"
        ? json({ error: "bot_not_found" }, 404)
        : json({ lines: outcome.lines, truncated: outcome.truncated }, 200);
    }
    if (method === "GET" && sub === "build-logs") {
      const deploymentIdParam = url.searchParams.get("deploymentId");
      if (deploymentIdParam !== null && !isValidId(deploymentIdParam)) {
        return json({ error: "invalid_deployment_id" }, 400);
      }
      const outcome = manager.getBuildLogs(botId, deploymentIdParam, parseTail(url));
      if (outcome.kind === "bot_not_found") return json({ error: "bot_not_found" }, 404);
      if (outcome.kind === "log_not_found") return json({ error: "build_log_not_found" }, 404);
      return json({ lines: outcome.lines, truncated: outcome.truncated }, 200);
    }
    if (method === "POST" && sub === "start") return handleStart(req, botId);
    if (method === "POST" && sub === "restart") return handleRestart(req, botId);
    if (method === "POST" && sub === "stop") {
      const outcome = await manager.stop(botId);
      return outcome.kind === "bot_not_found"
        ? json({ error: "bot_not_found" }, 404)
        : json({ state: "STOPPED", killed: outcome.killed }, 200);
    }
    if (method === "POST" && sub === "undeploy") {
      const outcome = await manager.undeploy(botId);
      return outcome.kind === "bot_not_found"
        ? json({ error: "bot_not_found" }, 404)
        : json({ ok: true }, 200);
    }
    // no match in this block → fall through to the file-management routes below
  }

  if (segments[0] === "bots" && segments.length >= 3) {
    const botId = segments[1]!;
    if (!isValidId(botId)) return json({ error: "invalid_bot_id" }, 400);
    const sub = segments[2]!;

    if (sub === "files" && segments.length === 3 && method === "GET") return handleFilesList(botId, url);
    if (sub === "files" && segments.length === 4 && segments[3] === "read" && method === "GET") return handleFilesRead(botId, url);
    if (sub === "files" && segments.length === 4 && segments[3] === "download" && method === "GET") return handleFilesDownload(botId, url);
    if (sub === "files" && segments.length === 4 && segments[3] === "upload" && method === "POST") return handleFilesUpload(req, botId);
    if (sub === "files" && segments.length === 3 && method === "PUT") return handleFilesWrite(req, botId);
    if (sub === "files" && segments.length === 4 && segments[3] === "mkdir" && method === "POST") return handleFilesMkdir(req, botId);
    if (sub === "files" && segments.length === 3 && method === "DELETE") return handleFilesDelete(botId, url);
    if (sub === "usage" && segments.length === 3 && method === "GET") return handleUsage(botId);
    if (sub === "templates" && segments.length === 3 && method === "POST") return handleTemplates(req, botId);
  }

  return json({ error: "not_found" }, 404);
}

// --- server + lifecycle ------------------------------------------------------

let shuttingDown = false;
let server: ReturnType<typeof Bun.serve>;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[runtime] ${signal} received: stopping all bots (3s best effort) and persisting state`);
  try {
    await manager.shutdown();
  } catch (err) {
    console.error("[runtime] error during shutdown:", err);
  }
  server.stop(true);
  console.log("[runtime] goodbye");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  console.error("[runtime] unhandled promise rejection:", reason);
});

try {
  server = Bun.serve({
    hostname: "127.0.0.1", // never directly reachable from outside the host
    port,
    async fetch(req) {
      const startedAt = Date.now();
      let res: Response;
      try {
        res = await route(req);
      } catch (err) {
        console.error("[http] handler error:", err);
        res = json(
          { error: "internal_error", message: err instanceof Error ? err.message : String(err) },
          500,
        );
      }
      console.log(
        `[http] ${req.method} ${new URL(req.url).pathname} -> ${res.status} (${Date.now() - startedAt}ms)`,
      );
      return res;
    },
    error(err) {
      console.error("[http] server error:", err);
      return json({ error: "internal_error" }, 500);
    },
  });
} catch (err) {
  fatal(
    `could not bind http://127.0.0.1:${port} — ${err instanceof Error ? err.message : String(err)}`,
  );
}

console.log(
  `[runtime] botdock-runtime ${VERSION} listening on http://127.0.0.1:${port} (data dir: ${dataDir})`,
);
console.log(`[runtime] bins: python=${bins.python} node=${bins.node} bun=${bins.bun}`);
