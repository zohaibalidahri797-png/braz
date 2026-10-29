/**
 * Post-`cf:build` hygiene cleanup.
 *
 * WHY THIS EXISTS
 * Next.js `output: standalone` copies the project root — including `.env`,
 * the local SQLite `db/` and runtime data — into `.next/standalone`, and the
 * OpenNext build propagates that directory to
 * `.open-next/server-functions/default/`.
 *
 * The Cloudflare Worker itself never uploads those files (`wrangler deploy`
 * bundles only the import graph of `.open-next/worker.js` — verified by
 * `wrangler deploy --dry-run`: total upload ≈ 9.9 MB), so this is defense in
 * depth against:
 *   - secrets (.env with APP_SECRET / RUNTIME_API_KEY) leaking via shared
 *     build artifacts or CI uploads,
 *   - user bot workspaces (bot-data/) and the user database (db/) ending up
 *     in any archive of the build output.
 *
 * Workers never read `.env` (secrets come from `wrangler secret put`), and
 * they never touch a local SQLite file (production uses remote libSQL), so
 * removing these files from the build output changes nothing functionally.
 *
 * Files that ARE required by the deploy bundle are never touched:
 * handler.mjs, index.mjs, .next/, node_modules/, package.json,
 * open-next.config.mjs, cache.cjs, composable-cache.cjs,
 * patchedAsyncStorage.cjs, prisma/, public/, src/.
 */
import { rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(process.cwd(), ".open-next", "server-functions", "default");

// Secrets / private data / pure junk — safe to delete from the Worker build.
const REMOVE = [
  ".env",
  ".env.local",
  ".env.production",
  "dev.log",
  "server.log",
  "bot-runtime.log",
  "bot-data",
  "db",
  "download",
  "tool-results",
  "upload",
  "worklog.md",
  ".wrangler",
];

let removed = 0;
for (const name of REMOVE) {
  const p = join(root, name);
  if (existsSync(p)) {
    rmSync(p, { recursive: true, force: true });
    removed++;
    console.log(`cf-clean: removed ${name}`);
  }
}

// ── Scrub BAKED-IN .env values from the deployable Worker bundle ────────────
// OpenNext snapshots the build-time .env into .open-next/cloudflare/next-env.mjs
// (imported by worker.js → init.js → populateProcessEnv: `process.env[k] ??= baked`).
// Without this scrub, (a) local secret VALUES ship inside the uploaded bundle and
// (b) production vars the operator did NOT set silently fall back to local dev
// values — masking misconfiguration. Production must come from `wrangler secret
// put` / [vars] ONLY.
const NEXT_ENV = join(process.cwd(), ".open-next", "cloudflare", "next-env.mjs");
if (existsSync(NEXT_ENV)) {
  const original = readFileSync(NEXT_ENV, "utf8");
  // Actual shape: `export const production = {...};` / `export const development = {...};`
  // (namespace-imported by init.js as nextEnvVars[mode]). Object values are JSON
  // strings with no semicolons, so `\{[^;]*\}` matches exactly one literal.
  const scrubbed = original.replace(/(export\s+const\s+\w+\s*=\s*)\{[^;]*\}/g, '$1{};');
  if (scrubbed !== original) {
    writeFileSync(NEXT_ENV, scrubbed);
    console.log("cf-clean: scrubbed baked-in .env values from .open-next/cloudflare/next-env.mjs");
  }
} else {
  console.log("cf-clean: no .open-next/cloudflare/next-env.mjs (nothing to scrub)");
}

console.log(removed ? `cf-clean: ${removed} item(s) removed from build output` : "cf-clean: nothing to remove");
