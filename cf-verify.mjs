#!/usr/bin/env node
/**
 * cf-verify.mjs — PRE-DEPLOY GATE for the Cloudflare Worker release.
 *
 * WHY THIS EXISTS (the 404 root causes it prevents):
 *   1. `opennextjs-cloudflare deploy` does NOT build — it uploads whatever
 *      `.open-next/` currently holds. Running `cf:deploy` on a fresh clone or
 *      a cleaned tree deploys NOTHING usable (missing main/assets → 404s).
 *   2. A STALE `.open-next/` (built from older source) deploys old code with
 *      mismatched asset hashes — pages reference JS chunks that 404.
 *   3. `next build` side-effects can leak `.env` / `db/` / logs into
 *      `.open-next/server-functions/` (standalone copies the project root);
 *      deploying those would ship real secrets to Cloudflare.
 *   4. Deploying the SOURCE ZIP to Cloudflare *Pages* (static upload) can
 *      never work — there are no static HTML files; this is a Worker app.
 *
 * It FAILS LOUDLY (exit 1) before a broken deploy can happen, and prints the
 * post-deploy route checklist. It never "fixes" a 404 page — it prevents the
 * broken deploy itself.
 *
 * Usage: node scripts/cf-verify.mjs [--fix]
 *   --fix  applies the safe repairs automatically (leak cleanup via the same
 *          rules as scripts/cf-clean.mjs) before re-checking.
 */
import { existsSync, readFileSync, statSync, rmSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OPEN_NEXT = join(ROOT, ".open-next");
const WORKER = join(OPEN_NEXT, "worker.js");
const ASSETS = join(OPEN_NEXT, "assets");
const FIX = process.argv.includes("--fix");

let failed = false;
const problems = [];
const passed = [];

function check(ok, okMsg, failMsg, hint) {
  if (ok) {
    passed.push(okMsg);
    return true;
  }
  problems.push(hint ? `${failMsg}\n         → ${hint}` : failMsg);
  failed = true;
  return false;
}

// ── 1. Build output exists at all ────────────────────────────────────────────
check(
  existsSync(WORKER),
  "worker entry point present: .open-next/worker.js",
  "MISSING: .open-next/worker.js — the OpenNext build output does not exist",
  "run `bun run cf:build` FIRST (deploy/preview never build for you)",
);

check(
  existsSync(ASSETS) && statSync(ASSETS).isDirectory(),
  "static assets directory present: .open-next/assets/",
  "MISSING: .open-next/assets/ directory",
  "run `bun run cf:build` FIRST",
);

// ── 2. wrangler.jsonc wiring matches the actual output ──────────────────────
let cfgMain = null;
let cfgAssets = null;
const wranglerPath = join(ROOT, "wrangler.jsonc");
if (existsSync(wranglerPath)) {
  // JSONC: strip // comments, then drop trailing commas that comments can
  // leave behind (",\n}" — JSON.parse rejects those even though wrangler's
  // real JSONC parser accepts the file).
  const raw = readFileSync(wranglerPath, "utf8")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,(\s*[}\]])/g, "$1");
  try {
    const cfg = JSON.parse(raw);
    cfgMain = cfg.main ?? null;
    cfgAssets = cfg.assets?.directory ?? null;
  } catch (e) {
    check(false, "", `wrangler.jsonc is not parseable: ${e.message}`, "fix the JSON syntax");
  }
} else {
  check(false, "", "MISSING: wrangler.jsonc", "Worker config absent — cannot deploy as a Worker");
}
check(
  cfgMain === ".open-next/worker.js",
  "wrangler.jsonc main → .open-next/worker.js",
  `wrangler.jsonc main is ${JSON.stringify(cfgMain)} (expected ".open-next/worker.js")`,
  "point main at the OpenNext entry — a stale path 404s every route",
);
check(
  cfgAssets === ".open-next/assets",
  "wrangler.jsonc assets.directory → .open-next/assets",
  `wrangler.jsonc assets.directory is ${JSON.stringify(cfgAssets)} (expected ".open-next/assets")`,
  "wrong asset directory = missing JS/CSS chunks (404s) or empty shell",
);

// ── 3. Assets are complete and FRESH ────────────────────────────────────────
const assetsBuildId = join(ASSETS, "BUILD_ID");
const nextBuildId = join(ROOT, ".next", "BUILD_ID");
let assetsId = null;
try {
  assetsId = readFileSync(assetsBuildId, "utf8").trim();
} catch {
  check(false, "", "MISSING: .open-next/assets/BUILD_ID", "incomplete OpenNext output — rebuild");
}
check(
  assetsId !== null && existsSync(join(ASSETS, "_next", "static")),
  `assets contain _next/static (hashed chunks for the UI)`,
  "assets/_next/static missing — deployed pages would reference JS/CSS that 404s",
  "rebuild with `bun run cf:build`",
);
if (assetsId && existsSync(nextBuildId)) {
  const nextId = readFileSync(nextBuildId, "utf8").trim();
  check(
    nextId === assetsId,
    `build is FRESH (BUILD_ID ${assetsId.slice(0, 8)}… matches last next build)`,
    `STALE BUILD: .next BUILD_ID ${nextId.slice(0, 8)}… ≠ .open-next BUILD_ID ${assetsId.slice(0, 8)}… — source changed after the last cf:build`,
    "rebuild: `bun run cf:build`",
  );
}

// ── 4. Secret-leak scan inside the bundle that gets uploaded ────────────────
const LEAKS = [
  ".env",
  ".env.local",
  ".env.production",
  "dev.log",
  "server.log",
  "bot-runtime.log",
  "bot-data",
  "db",
  "download",
  "upload",
  "worklog.md",
  ".wrangler",
];
const sfDir = join(OPEN_NEXT, "server-functions", "default");
const found = LEAKS.filter((n) => existsSync(join(sfDir, n)));
if (found.length > 0) {
  if (FIX) {
    for (const n of found) {
      rmSync(join(sfDir, n), { recursive: true, force: true });
    }
    console.log(`  --fix: removed ${found.join(", ")} from server-functions/ (same rules as cf-clean)`);
    passed.push(`secret-leak cleanup applied (--fix): ${found.join(", ")}`);
  } else {
    problems.push(
      `SECRET LEAK in deploy bundle: ${found.join(", ")} inside .open-next/server-functions/default/\n         → re-run \`bun run cf:build\` (cf-clean) or pass --fix`,
    );
    failed = true;
  }
} else {
  passed.push("no secrets/databases/logs leaked into the deploy bundle");
}

// ── 4b. Baked-in .env values must NOT survive inside the deployable bundle ──
// OpenNext snapshots build-time .env into .open-next/cloudflare/next-env.mjs
// (worker.js → init.js → populateProcessEnv). cf-clean scrubs it; this check
// is the safety net that BLOCKS deploy if any local secret value survived.
const nextEnvPath = join(OPEN_NEXT, "cloudflare", "next-env.mjs");
if (existsSync(nextEnvPath)) {
  const content = readFileSync(nextEnvPath, "utf8");
  // Clean = every export is an empty object (`export const production = {};`).
  // Anything matching `= { "KEY":...` means build-time .env values survived.
  const hasBakedValues = /=\s*\{\s*"/.test(content);
  if (!hasBakedValues) {
    passed.push("no build-time .env values baked into next-env.mjs (production vars come only from wrangler secrets/vars)");
  } else {
    problems.push(
      "BAKED ENV VALUES IN DEPLOY BUNDLE: .open-next/cloudflare/next-env.mjs still contains build-time .env values (possibly local secrets like APP_SECRET/RUNTIME_API_KEY/DATABASE_URL)\n         → re-run `bun run cf:build` (cf-clean scrubs it)",
    );
    failed = true;
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
console.log("\n┌──────────────────────────────────────────────────────────┐");
console.log("│ cf-verify — pre-deploy gate for the Cloudflare Worker    │");
console.log("└──────────────────────────────────────────────────────────┘");
for (const p of passed) console.log(`  ✔ ${p}`);
for (const p of problems) console.log(`  ✘ ${p}`);

if (failed) {
  console.log("\nRESULT: FAILED — deploy blocked so it cannot produce a 404-ing Worker.");
  process.exit(1);
}

console.log("\nRESULT: OK — build output, config wiring, freshness and hygiene verified.");
console.log("\nPost-deploy route checklist (run these against the live host):");
console.log("  curl -i https://<your-host>/                    # expect 200 (landing)");
console.log("  curl -i https://<your-host>/login               # expect 307 → /#/login");
console.log("  curl -i https://<your-host>/register            # expect 307 → /#/register");
console.log("  curl -i https://<your-host>/api/health          # expect 200, per-component statuses");
console.log("  curl -i https://<your-host>/api/auth/config     # expect 200, provider booleans");
console.log("  curl -i https://<your-host>/api/auth/oauth/google       # 302 (configured) / 501 (not configured)");
console.log("  curl -i https://<your-host>/api/auth/oauth/google/callback  # 302 → /#/login?error=… (no state)");
console.log("  curl -i https://<your-host>/_next/static/BUILD_ID-check: fetch any hashed chunk from the page HTML");
process.exit(0);
