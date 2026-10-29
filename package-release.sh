#!/usr/bin/env bash
#
# BotDock Cloud release packaging.
#
# Produces the required deliverables from the same verified tree:
#   download/BotDock-Cloud-Responsive-Fixed.zip      → extracts to BotDock-Cloud/
#   download/BotDock-Cloud-Responsive-Fixed.tar.gz   → extracts to BotDock-Cloud/
#   download/BotDock-Cloud-Fixed.zip / .tar.gz       → same tree (deploy-repair names)
#
# Legacy alias names (byte-identical copies of the validated archives, kept so
# existing documentation/UI links keep working):
#   download/BotDock-Cloudflare-Fixed.zip, download/botdock-cloud-fixed.zip,
#   download/botdock-cloud.zip, download/botdock-cloud.tar.gz
# plus download/botdock-pages.zip (static Pages frontend, direct upload).
#
# Then validates everything: integrity, extraction, tree diff, essential files,
# and confirms no archive contains another archive and no secrets are staged.
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/download"
STAGE="$(mktemp -d)"
PKG_NAME="BotDock-Cloud"

trap 'rm -rf "$STAGE"' EXIT

echo "==> staging $PKG_NAME"
mkdir -p "$STAGE/$PKG_NAME" "$OUT_DIR"

# ── Copy the project, excluding runtime/build/sandbox-only artifacts ─────────
# (Exclusions are deliberate and documented; the lockfile and deployment
#  configs are preserved. tests/tmp holds throwaway E2E fixtures — never
#  distributed.)
rsync -a \
  --exclude node_modules/ \
  --exclude .next/ \
  --exclude .open-next/ \
  --exclude .git/ \
  --exclude .zscripts/ \
  --exclude .wrangler/ \
  --exclude .claude/ \
  --exclude .z-ai-config \
  --include '.env.example' \
  --include '.dev.vars.example' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude '.dev.vars' \
  --exclude skills/ \
  --exclude bot-data/ \
  --exclude '/upload/' \
  --exclude '/download/' \
  --exclude tool-results/ \
  --exclude .tmp-verify/ \
  --exclude public/releases/ \
  --exclude 'tests/tmp/' \
  --exclude 'db/*.db' \
  --exclude 'db/*.db.backup-*' \
  --exclude 'db/*.db-journal' \
  --exclude 'db/*.db-wal' \
  --exclude 'db/*.db-shm' \
  --exclude '*.log' \
  --exclude dev.out.log \
  --exclude server.log \
  --exclude worklog.md \
  --exclude '*.tsbuildinfo' \
  --exclude 'BotDock-Cloud-Fixed.zip' \
  --exclude 'BotDock-Cloud-Fixed.tar.gz' \
  --exclude 'BotDock-Cloudflare-Fixed.zip' \
  --exclude botdock-cloud.zip \
  --exclude botdock-cloud.tar.gz \
  --exclude botdock-cloud.tar \
  "$ROOT/" "$STAGE/$PKG_NAME/"

# keep the (now empty) db folder in the archives
mkdir -p "$STAGE/$PKG_NAME/db"
touch "$STAGE/$PKG_NAME/db/.gitkeep"

# ── Build archives ───────────────────────────────────────────────────────────
# NOTE: `zip -r` MERGES into an existing archive instead of replacing it —
# remove stale outputs first or old (possibly non-compliant) content survives.
rm -f "$OUT_DIR/BotDock-Cloud-Responsive-Fixed.zip" "$OUT_DIR/BotDock-Cloud-Responsive-Fixed.tar.gz" \
      "$OUT_DIR/BotDock-Cloud-Fixed.zip" "$OUT_DIR/BotDock-Cloud-Fixed.tar.gz" \
      "$OUT_DIR/BotDock-Cloudflare-Fixed.zip" \
      "$OUT_DIR/botdock-cloud-fixed.zip" "$OUT_DIR/botdock-cloud.zip" \
      "$OUT_DIR/botdock-cloud.tar.gz" "$OUT_DIR/botdock-cloud.tar" \
      "$OUT_DIR/botdock-pages.zip"

echo "==> building BotDock-Cloud-Fixed.zip"
( cd "$STAGE" && zip -q -r -X "$OUT_DIR/BotDock-Cloud-Fixed.zip" "$PKG_NAME" )

echo "==> building BotDock-Cloud-Fixed.tar.gz"
( cd "$STAGE" && tar -czf "$OUT_DIR/BotDock-Cloud-Fixed.tar.gz" "$PKG_NAME" )

# ── Validation ───────────────────────────────────────────────────────────────
echo "==> validating"
fail() { echo "VALIDATION FAILED: $1" >&2; exit 1; }

# 1. integrity
unzip -t "$OUT_DIR/BotDock-Cloud-Fixed.zip" > /dev/null || fail "zip integrity"
tar -tzf "$OUT_DIR/BotDock-Cloud-Fixed.tar.gz" > /dev/null || fail "tar integrity"

# 2. extract both
EX1="$STAGE/zip-extract"; EX2="$STAGE/tar-extract"
mkdir -p "$EX1" "$EX2"
unzip -q "$OUT_DIR/BotDock-Cloud-Fixed.zip" -d "$EX1"
tar -xzf "$OUT_DIR/BotDock-Cloud-Fixed.tar.gz" -C "$EX2"

[ -d "$EX1/$PKG_NAME" ] || fail "zip does not extract to $PKG_NAME/"
[ -d "$EX2/$PKG_NAME" ] || fail "tar does not extract to $PKG_NAME/"

# 3. same file lists + same contents (ZIP and TAR.GZ must be identical trees)
diff <( cd "$EX1/$PKG_NAME" && find . -type f | sort ) \
     <( cd "$EX2/$PKG_NAME" && find . -type f | sort ) \
     || fail "extracted file lists differ"
diff -r "$EX1/$PKG_NAME" "$EX2/$PKG_NAME" || fail "extracted contents differ"

# 4. essential files
for f in package.json bun.lock src/app/page.tsx prisma/schema.prisma \
         prisma/migrations/20260320000000_init/migration.sql \
         wrangler.jsonc open-next.config.ts next.config.ts .env.example \
         .dev.vars.example scripts/cf-verify.mjs scripts/cf-clean.mjs \
         scripts/package-release.sh tests/worker-route-matrix.sh \
         README.md FIX-REPORT.md UI-RESPONSIVE-FIX-REPORT.md \
         .github/workflows/ci.yml tests/runtime-config.test.ts \
         tests/health.test.ts src/lib/platform-health.ts \
         mini-services/bot-runtime/package.json docs/DEPLOYMENT.md \
         docs/RUNTIME-DEPLOYMENT.md docs/SETUP.md docs/ARCHITECTURE.md \
         docs/SECURITY-HYGIENE.md \
         src/app/api/bots/upload/route.ts \
         'src/app/api/bots/[id]/files/upload/route.ts'; do
  [ -f "$EX1/$PKG_NAME/$f" ] || fail "missing essential file: $f"
done

# 4b. no private data or dev artifacts staged
if ls "$EX1/$PKG_NAME"/db/*.db >/dev/null 2>&1; then fail "database files must not be packaged"; fi
if [ -f "$EX1/$PKG_NAME/.env" ]; then fail ".env must not be packaged"; fi
if [ -f "$EX1/$PKG_NAME/.dev.vars" ]; then fail ".dev.vars must not be packaged"; fi
if [ -f "$EX1/$PKG_NAME/worklog.md" ]; then fail "internal worklog must not be packaged"; fi
if ls "$EX1/$PKG_NAME"/*.tsbuildinfo >/dev/null 2>&1; then fail "build artifacts must not be packaged"; fi
if [ -d "$EX1/$PKG_NAME/tests/tmp" ]; then fail "tests/tmp fixtures must not be packaged"; fi

# 5. no nested archive copies (never an archive that only contains an archive)
if ( cd "$EX1/$PKG_NAME" && find . -type f \( \
      -iname 'BotDock-Cloud-Responsive-Fixed.zip' -o -iname 'BotDock-Cloud-Responsive-Fixed.tar.gz' -o \
      -iname 'BotDock-Cloud-Fixed.zip' -o -iname 'BotDock-Cloud-Fixed.tar.gz' -o \
      -iname 'BotDock-Cloudflare-Fixed.zip' -o \
      -name 'botdock-cloud.zip' -o -name 'botdock-cloud.tar.gz' -o -name 'botdock-cloud.tar' \
   \) | grep -q . ); then
  fail "archives must not contain copies of themselves"
fi

# 6. no secrets staged
# Cross-check: every non-empty VALUE of a secret-keyed line in the local .env
# (if present) must not appear anywhere in the staged tree. Values are never
# printed. Only real secret keys are scanned — non-credentials like APP_URL or
# DATABASE_URL (a local file path) legitimately appear in docs/examples.
if [ -f "$ROOT/.env" ]; then
  SECRET_KEYS='^(APP_SECRET|RUNTIME_API_KEY|ADMIN_BOOTSTRAP_TOKEN|LIBSQL_AUTH_TOKEN|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|RESEND_API_KEY|GOOGLE_CLIENT_SECRET|GITHUB_CLIENT_SECRET|TELEGRAM_BOT_TOKEN)='
  while IFS='=' read -r k v; do
    v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
    [ -n "$v" ] || continue
    if grep -rqF -- "$v" "$EX1/$PKG_NAME" 2>/dev/null; then
      fail "secret value of $k from local .env leaked into the staged tree"
    fi
  done < <(grep -E "$SECRET_KEYS" "$ROOT/.env" || true)
fi
# Placeholder hygiene: .env.example must contain no real-looking keys.
if grep -Eq '(sk_live_|whsec_[A-Za-z0-9]{8,}|postgres://[^@\s]+:[^@\s]+@|libsql://[a-z0-9-]+\.turso\.io)' "$EX1/$PKG_NAME/.env.example" 2>/dev/null; then
  fail ".env.example contains a real-looking credential pattern"
fi

FILES=$(cd "$EX1/$PKG_NAME" && find . -type f | wc -l)
ZIP_MB=$(du -m "$OUT_DIR/BotDock-Cloud-Fixed.zip" | cut -f1)
TAR_MB=$(du -m "$OUT_DIR/BotDock-Cloud-Fixed.tar.gz" | cut -f1)

echo "==> OK: $FILES files; zip ${ZIP_MB}MB; tar.gz ${TAR_MB}MB"

# ── Required deliverables (byte-identical copies of the validated archives) ──
alias_check() { unzip -t "$1" > /dev/null || fail "alias integrity: $1"; }
cp "$OUT_DIR/BotDock-Cloud-Fixed.zip"     "$OUT_DIR/BotDock-Cloud-Responsive-Fixed.zip";     alias_check "$OUT_DIR/BotDock-Cloud-Responsive-Fixed.zip"
cp "$OUT_DIR/BotDock-Cloud-Fixed.tar.gz"  "$OUT_DIR/BotDock-Cloud-Responsive-Fixed.tar.gz"
cp "$OUT_DIR/BotDock-Cloud-Fixed.zip"     "$OUT_DIR/BotDock-Cloudflare-Fixed.zip"; alias_check "$OUT_DIR/BotDock-Cloudflare-Fixed.zip"
cp "$OUT_DIR/BotDock-Cloud-Fixed.zip"     "$OUT_DIR/botdock-cloud-fixed.zip";      alias_check "$OUT_DIR/botdock-cloud-fixed.zip"
cp "$OUT_DIR/BotDock-Cloud-Fixed.zip"     "$OUT_DIR/botdock-cloud.zip";            alias_check "$OUT_DIR/botdock-cloud.zip"
cp "$OUT_DIR/BotDock-Cloud-Fixed.tar.gz"  "$OUT_DIR/botdock-cloud.tar.gz"
echo "==> required deliverables + legacy aliases ready (byte-identical copies)"

# ── botdock-pages.zip (static frontend, Cloudflare Pages Direct Upload) ──────
# The contents of public/ (index.html at the archive ROOT — Pages requires
# that — plus assets/, _redirects, favicon.svg, 404.html). Validated: every
# referenced local path in every HTML file must exist in the archive.
echo "==> building botdock-pages.zip (static frontend, Pages Direct Upload)"
PAGES_STAGE="$STAGE/pages/site"
mkdir -p "$PAGES_STAGE"
rsync -a --exclude '/logo.svg' "$ROOT/public/" "$PAGES_STAGE/"
[ -f "$PAGES_STAGE/index.html" ] || fail "pages: index.html missing at archive root"
( cd "$PAGES_STAGE" && zip -q -r -X "$OUT_DIR/botdock-pages.zip" . )

# every local href/src referenced by the HTML must exist in the archive
PAGE_HITS=$(grep -hoE '(href|src)="/[^"#?]*' "$PAGES_STAGE"/*.html | sed -E 's/(href|src)="\///' | sort -u || true)
MISSING=""
while IFS= read -r rel; do
  [ -z "$rel" ] && continue
  # _redirects-proxied API paths are allowed to be "virtual"
  case "$rel" in api/*) continue ;; esac
  if [ ! -e "$PAGES_STAGE/$rel" ]; then MISSING="$MISSING $rel"; fi
done <<EOF
$PAGE_HITS
EOF
if [ -n "$MISSING" ]; then fail "pages: missing referenced files:$MISSING"; fi
unzip -t "$OUT_DIR/botdock-pages.zip" > /dev/null || fail "botdock-pages.zip integrity"
PAGES_FILES=$(cd "$PAGES_STAGE" && find . -type f | wc -l)
PAGES_KB=$(du -k "$OUT_DIR/botdock-pages.zip" | cut -f1)
echo "==> optional deliverable ready: $OUT_DIR/botdock-pages.zip (${PAGES_KB}KB, $PAGES_FILES files)"

echo "==> outputs:"
echo "    $OUT_DIR/BotDock-Cloud-Responsive-Fixed.zip   (REQUIRED)"
echo "    $OUT_DIR/BotDock-Cloud-Responsive-Fixed.tar.gz (REQUIRED)"
echo "    $OUT_DIR/BotDock-Cloud-Fixed.zip              (deploy-repair name)"
echo "    $OUT_DIR/BotDock-Cloud-Fixed.tar.gz           (deploy-repair name)"
echo "    $OUT_DIR/BotDock-Cloudflare-Fixed.zip         (alias)"
echo "    $OUT_DIR/botdock-cloud-fixed.zip              (alias)"
echo "    $OUT_DIR/botdock-cloud.zip                    (alias)"
echo "    $OUT_DIR/botdock-cloud.tar.gz                 (alias)"
echo "    $OUT_DIR/botdock-pages.zip                    (static frontend option)"
