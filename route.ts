/**
 * POST /api/bots/:id/files/upload — upload into a bot workspace (file manager).
 * Forwards the upload to the botdock-runtime service, which owns the disk:
 *   - archives (.zip / .tar / .tar.gz / .tgz, ≤ 20MB) → extracted safely
 *   - single files (≤ 512KB) → written as-is
 * Multipart form fields: file (required), path (target dir, default root).
 */
import { ok, fail, requireUser, originCheck } from "@/lib/api";
import { db } from "@/lib/db";
import { uploadToWorkspace, FileOpError, RuntimeOfflineError, MAX_ARCHIVE_BYTES } from "@/lib/bot-fs";
import { audit } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";

const MAX_REQUEST_BYTES = MAX_ARCHIVE_BYTES + 1024 * 1024; // archive + multipart overhead

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrf = originCheck(req);
  if (csrf) return csrf;
  const auth = await requireUser();
  if ("response" in auth) return auth.response;
  const { id } = await params;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return fail(400, "invalid_id");

  const bot = await db.bot.findUnique({ where: { id } });
  if (!bot || (bot.userId !== auth.user.id && auth.user.role !== "ADMIN")) return fail(404, "bot_not_found");
  if (["BUILDING", "DEPLOYING", "DELETING"].includes(bot.status)) {
    return fail(409, "operation_in_progress", { detail: `Bot is ${bot.status}; wait for it to finish before editing files.` });
  }

  const rl = await rateLimit(`file-upload:${auth.user.id}`, 60, 3600);
  if (!rl.ok) {
    return fail(429, "too_many_uploads", {
      detail: `Too many uploads from this account — try again in about ${Math.ceil(rl.retryAfterSec / 60)} minute(s).`,
    });
  }

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_REQUEST_BYTES) {
    return fail(413, "file_too_large", { detail: "Upload exceeds the 20MB archive limit." });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail(400, "invalid_form", { detail: "Expected a multipart form with a file field." });
  }

  const file = form.get("file");
  if (!(file instanceof File)) return fail(400, "file_required", { detail: "Attach a file." });
  if (file.size === 0) return fail(400, "empty_file", { detail: "The uploaded file is empty." });
  if (file.size > MAX_REQUEST_BYTES) {
    return fail(413, "file_too_large", { detail: "Upload exceeds the 20MB archive limit." });
  }

  const rawDir = String(form.get("path") ?? "").trim();
  const data = Buffer.from(await file.arrayBuffer());

  try {
    const result = await uploadToWorkspace(id, file.name, data, rawDir);
    await audit({
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: result.kind === "archive" ? "BOT_FILES_UPLOAD_ARCHIVE" : "BOT_FILES_UPLOAD",
      targetType: "bot",
      targetId: id,
      detail: result.kind === "archive" ? { path: rawDir || ".", archive: file.name.slice(0, 100), format: result.format, files: result.files } : { path: result.path, bytes: result.bytes },
      ip: req.headers.get("x-forwarded-for") ?? "",
      userAgent: req.headers.get("user-agent"),
    });
    return ok({ ok: true, ...result });
  } catch (err) {
    if (err instanceof RuntimeOfflineError) {
      return fail(503, "runtime_unavailable", {
        detail: "The bot runtime service is not reachable, so uploads are unavailable right now.",
      });
    }
    const msg = err instanceof FileOpError ? err.message : err instanceof Error ? err.message : "upload_failed";
    return fail(400, "file_error", { detail: msg });
  }
}
