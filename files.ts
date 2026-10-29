/**
 * Workspace file operations for the botdock-runtime service.
 *
 * The runtime owns ALL bot filesystem access — the web app (which may run on
 * Cloudflare Workers with no persistent disk) calls these over HTTP. The
 * workspace lives at {RUNTIME_DATA_DIR}/workspace/{botId}/.
 *
 * Security (mirrors the original web-app implementation):
 *  - every path is resolved and must stay inside the bot workspace root
 *  - symlinks are refused / never surfaced
 *  - per-file write cap 512KB, upload archive cap 20MB
 *  - zip extraction validates every entry (no absolute paths, no "..", no
 *    symlink entries) before writing — prevents zip-slip
 *  - tar / tar.gz validated by listing entries first, then extracted with
 *    safe flags; smuggled symlinks are removed
 *  - platform-managed names (.env, .ssh, …) cannot be written
 */

import AdmZip from "adm-zip";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { join } from "node:path";

export const MAX_FILE_WRITE = 512 * 1024;
export const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const FORBIDDEN_BASENAMES = new Set([".env", ".env.local", ".bashrc", ".profile", ".ssh"]);

export class PathError extends Error {}

export function workspaceRoot(dataDir: string, botId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(botId)) throw new PathError("invalid bot id");
  return join(dataDir, "workspace", botId);
}

function lstatSafe(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/** Resolves a user-supplied relative path inside the workspace. Throws on escape. */
export function safeResolve(dataDir: string, botId: string, relPath: string): string {
  const root = workspaceRoot(dataDir, botId);
  const clean = relPath.replace(/^\/+/, "");
  if (clean.includes("\0")) throw new PathError("invalid path");
  const resolved = path.resolve(root, clean);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new PathError("path escapes the bot workspace");
  }
  const rel = path.relative(root, resolved);
  for (const seg of rel.split(path.sep)) {
    if (FORBIDDEN_BASENAMES.has(seg)) {
      throw new PathError(`"${seg}" is managed by the platform and cannot be used here`);
    }
  }
  return resolved;
}

export interface FileEntry {
  path: string;
  type: "file" | "dir";
  size: number;
  modifiedAt: string;
}

export function listFiles(dataDir: string, botId: string, relDir = ""): FileEntry[] {
  const root = workspaceRoot(dataDir, botId);
  const absDir = safeResolve(dataDir, botId, relDir || ".");
  if (!lstatSafe(root)) return []; // empty/never-created workspace → empty listing
  const st = lstatSafe(absDir);
  if (!st || !st.isDirectory()) throw new PathError("not a directory");
  const out: FileEntry[] = [];
  for (const name of fs.readdirSync(absDir)) {
    if (name === ".botdock-deps" || name === "node_modules") continue; // noise
    const abs = join(absDir, name);
    const s = lstatSafe(abs);
    if (!s) continue;
    if (s.isSymbolicLink()) continue; // never surface symlinks
    const rel = path.relative(workspaceRoot(dataDir, botId), abs).split(path.sep).join("/");
    out.push({
      path: rel,
      type: s.isDirectory() ? "dir" : "file",
      size: s.size,
      modifiedAt: s.mtime.toISOString(),
    });
  }
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
  return out;
}

export function readFileContent(
  dataDir: string,
  botId: string,
  relPath: string,
): { content: string; size: number; binary: boolean } {
  const abs = safeResolve(dataDir, botId, relPath);
  const st = lstatSafe(abs);
  if (!st) throw new PathError("file not found");
  if (st.isSymbolicLink()) throw new PathError("symlinks are not supported");
  if (!st.isFile()) throw new PathError("not a file");
  if (st.size > MAX_FILE_WRITE) throw new PathError(`file exceeds the ${Math.round(MAX_FILE_WRITE / 1024)}KB viewer limit`);
  const buf = fs.readFileSync(abs);
  const binary = buf.includes(0);
  return { content: binary ? "" : buf.toString("utf8"), size: st.size, binary };
}

export function writeFileContent(dataDir: string, botId: string, relPath: string, content: string): void {
  const abs = safeResolve(dataDir, botId, relPath);
  const buf = Buffer.from(content, "utf8");
  if (buf.length > MAX_FILE_WRITE) throw new PathError(`file exceeds the ${Math.round(MAX_FILE_WRITE / 1024)}KB editor limit`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
}

/** Binary-safe single-file write used by the file-manager upload endpoint. */
export function writeFileBytes(dataDir: string, botId: string, relPath: string, data: Buffer): void {
  const abs = safeResolve(dataDir, botId, relPath);
  if (data.length > MAX_FILE_WRITE) {
    throw new PathError(`file exceeds the ${Math.round(MAX_FILE_WRITE / 1024)}KB upload limit — archives up to 20MB are supported instead`);
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
}

export function makeDir(dataDir: string, botId: string, relPath: string): void {
  const abs = safeResolve(dataDir, botId, relPath);
  fs.mkdirSync(abs, { recursive: true });
}

export function deletePath(dataDir: string, botId: string, relPath: string): void {
  const abs = safeResolve(dataDir, botId, relPath);
  const st = lstatSafe(abs);
  if (!st) throw new PathError("not found");
  if (abs === workspaceRoot(dataDir, botId)) throw new PathError("cannot delete workspace root");
  fs.rmSync(abs, { recursive: true, force: false });
}

export function downloadFile(
  dataDir: string,
  botId: string,
  relPath: string,
): { data: Buffer; filename: string } {
  const abs = safeResolve(dataDir, botId, relPath);
  const st = lstatSafe(abs);
  if (!st) throw new PathError("file not found");
  if (st.isSymbolicLink()) throw new PathError("symlinks are not supported");
  if (!st.isFile()) throw new PathError("not a file");
  if (st.size > 20 * 1024 * 1024) throw new PathError("file exceeds the 20MB download limit");
  const data = fs.readFileSync(abs);
  const filename = relPath.split("/").pop() || "file";
  return { data, filename };
}

export function workspaceUsageBytes(dataDir: string, botId: string): number {
  const root = workspaceRoot(dataDir, botId);
  let total = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try {
          total += fs.statSync(p).size;
        } catch {
          // vanished mid-walk
        }
      }
    }
  };
  walk(root);
  return total;
}

export function writeTemplateFiles(dataDir: string, botId: string, files: Record<string, string>): void {
  const root = workspaceRoot(dataDir, botId);
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const target = safeResolve(dataDir, botId, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

// ── Archive extraction ───────────────────────────────────────────────────────

interface ArchiveEntry {
  name: string;
  size: number;
}

function validateEntries(entries: ArchiveEntry[]): { strip: number } {
  const prefixes = new Set<string>();
  for (const e of entries) {
    const norm = e.name.replace(/\\/g, "/");
    if (norm.startsWith("/") || norm.includes("../") || norm.endsWith("/..") || norm.includes("\0")) {
      throw new PathError(`unsafe archive entry: ${e.name.slice(0, 100)}`);
    }
    const parts = norm.split("/").filter(Boolean);
    if (parts.length > 1) prefixes.add(parts[0]!);
  }
  // strip exactly one top-level dir if all entries share it
  let strip = 0;
  if (prefixes.size === 1 && entries.every((e) => e.name.replace(/\\/g, "/").split("/").filter(Boolean).length > 1)) {
    strip = 1;
  }
  return { strip };
}

function workspaceTarget(dataDir: string, botId: string, into?: string): string {
  if (!into || into === "" || into === "." || into === "/") return workspaceRoot(dataDir, botId);
  const abs = safeResolve(dataDir, botId, into);
  const st = lstatSafe(abs);
  if (!st || !st.isDirectory()) throw new PathError("target is not a directory inside the workspace");
  return abs;
}

/** Detect archive format from magic bytes (falls back to filename extension). */
export function detectArchiveFormat(filename: string, data: Buffer): "zip" | "targz" | "tar" | null {
  if (data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && (data[2] === 0x03 || data[2] === 0x05 || data[2] === 0x07)) return "zip";
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) return "targz";
  const lower = filename.toLowerCase();
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "targz";
  if (lower.endsWith(".tar")) return "tar";
  if (lower.endsWith(".zip")) return "zip";
  if (data.length >= 262 && data.subarray(257, 262).toString("ascii") === "ustar") return "tar";
  return null;
}

export function extractZipIntoWorkspace(
  dataDir: string,
  botId: string,
  data: Buffer,
  opts?: { into?: string },
): { files: number; bytes: number } {
  if (data.length > MAX_ARCHIVE_BYTES) throw new PathError("archive exceeds the 20MB limit");
  let zip: AdmZip;
  try {
    zip = new AdmZip(data);
  } catch {
    throw new PathError("invalid or corrupted zip archive");
  }
  const infos = zip.getEntries().filter((e) => !e.isDirectory);
  const entries: ArchiveEntry[] = infos.map((e) => ({ name: e.entryName, size: e.header.size }));
  if (entries.length === 0) throw new PathError("archive is empty");
  if (entries.length > 2000) throw new PathError("archive contains too many entries (max 2000)");
  const total = entries.reduce((a, e) => a + e.size, 0);
  if (total > MAX_ARCHIVE_BYTES * 2) throw new PathError("archive expands beyond limits (zip bomb protection)");
  const { strip } = validateEntries(entries);

  const root = workspaceTarget(dataDir, botId, opts?.into);
  fs.mkdirSync(root, { recursive: true });
  let files = 0;
  let bytes = 0;
  for (const e of infos) {
    const normParts = e.entryName.replace(/\\/g, "/").split("/").filter(Boolean);
    const targetParts = normParts.slice(strip);
    if (targetParts.length === 0) continue;
    if (FORBIDDEN_BASENAMES.has(targetParts[targetParts.length - 1]!)) continue; // skip platform-managed files
    const target = path.resolve(root, ...targetParts);
    if (target !== root && !target.startsWith(root + path.sep)) continue; // defensive
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, e.getData());
    files += 1;
    bytes += e.header.size;
  }
  return { files, bytes };
}

export function extractTarGzIntoWorkspace(
  dataDir: string,
  botId: string,
  data: Buffer,
  opts?: { into?: string },
): { files: number; bytes: number } {
  return extractTarArchive(dataDir, botId, data, { gz: true, into: opts?.into });
}

export function extractTarIntoWorkspace(
  dataDir: string,
  botId: string,
  data: Buffer,
  opts?: { into?: string },
): { files: number; bytes: number } {
  return extractTarArchive(dataDir, botId, data, { gz: false, into: opts?.into });
}

function extractTarArchive(
  dataDir: string,
  botId: string,
  data: Buffer,
  opts: { gz: boolean; into?: string },
): { files: number; bytes: number } {
  if (data.length > MAX_ARCHIVE_BYTES) throw new PathError("archive exceeds the 20MB limit");
  const suffix = opts.gz ? ".tar.gz" : ".tar";
  const tmp = join(dataDir, `tmp-tar-${botId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${suffix}`);
  const root = workspaceTarget(dataDir, botId, opts.into);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(tmp, data);
  try {
    const zFlag = opts.gz ? "z" : "";
    const list = spawnSync("tar", [`-t${zFlag}f`, tmp], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    if (list.status !== 0) throw new PathError(`invalid or corrupted ${opts.gz ? "tar.gz" : "tar"} archive`);
    const names = list.stdout.toString("utf8").split("\n").filter((l) => l.trim().length > 0);
    if (names.length === 0) throw new PathError("archive is empty");
    if (names.length > 2000) throw new PathError("archive contains too many entries (max 2000)");
    const entries = names.map((n) => ({ name: n, size: 0 }));
    const { strip } = validateEntries(entries);

    const extractDir = `${tmp}.extract`;
    fs.mkdirSync(extractDir, { recursive: true });
    const ex = spawnSync("tar", [`-x${zFlag}f`, tmp, "-C", extractDir, "--no-same-owner", "--no-same-permissions"], {
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (ex.status !== 0) throw new PathError(`failed to extract ${opts.gz ? "tar.gz" : "tar"} archive`);

    let srcDir = extractDir;
    const top = fs.readdirSync(extractDir);
    if (top.length === 1 && fs.statSync(join(extractDir, top[0]!)).isDirectory()) {
      srcDir = join(extractDir, top[0]!);
    }
    if (strip === 1 && srcDir === extractDir) {
      for (const name of top) {
        fs.cpSync(join(extractDir, name), join(root, name), { recursive: true, verbatimSymlinks: false });
      }
    } else {
      fs.cpSync(srcDir, root, { recursive: true, verbatimSymlinks: false });
    }
    fs.rmSync(extractDir, { recursive: true, force: true });

    let files = 0;
    let bytes = 0;
    const count = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isSymbolicLink()) {
          fs.rmSync(p, { force: true }); // remove any symlinks the archive smuggled in
          continue;
        }
        if (e.isDirectory()) count(p);
        else {
          files += 1;
          try {
            bytes += fs.statSync(p).size;
          } catch {
            // ignore
          }
        }
      }
    };
    count(root);
    return { files, bytes };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Handles a file-manager upload (multipart): single file (≤512KB, written
 * as-is) or archive (≤20MB, detected via magic bytes + extension, extracted
 * into the target directory). Used by POST /bots/:id/files/upload.
 */
export function handleUpload(
  dataDir: string,
  botId: string,
  filename: string,
  data: Buffer,
  targetDir: string,
): { kind: "archive"; format: string; files: number; bytes: number } | { kind: "file"; path: string; bytes: number } {
  if (data.length === 0) throw new PathError("the uploaded file is empty");
  const format = detectArchiveFormat(filename, data);
  if (format !== null) {
    if (data.length > MAX_ARCHIVE_BYTES) throw new PathError("archive exceeds the 20MB limit");
    const result =
      format === "zip"
        ? extractZipIntoWorkspace(dataDir, botId, data, { into: targetDir })
        : format === "targz"
          ? extractTarGzIntoWorkspace(dataDir, botId, data, { into: targetDir })
          : extractTarIntoWorkspace(dataDir, botId, data, { into: targetDir });
    return { kind: "archive", format, ...result };
  }
  if (data.length > MAX_FILE_WRITE) {
    throw new PathError(
      `single files are limited to ${Math.round(MAX_FILE_WRITE / 1024)}KB — zip your project into an archive (≤ 20MB) to upload more`,
    );
  }
  const dirPart = targetDir.replace(/^\/+|\/+$/g, "");
  const base = filename.split(/[/\\]/).pop() ?? "upload";
  const cleaned = base.replace(/[^a-zA-Z0-9._ ()-]/g, "_").replace(/^\.+/, "");
  const safeName = cleaned.length > 0 ? cleaned.slice(0, 200) : "upload";
  const targetPath = dirPart ? `${dirPart}/${safeName}` : safeName;
  writeFileBytes(dataDir, botId, targetPath, data);
  return { kind: "file", path: targetPath, bytes: data.length };
}
