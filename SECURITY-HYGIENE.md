# Security & repository hygiene report

Status: audited and cleaned in the working tree. Git **history** cleanup is
deliberately NOT performed (shared-history rewrites need explicit approval) —
see §History below.

## What was tracked and is now untracked

| Path | Why it was private | Action |
|---|---|---|
| `.env` | local environment file | `git rm --cached`; `.gitignore` already ignores `.env*` (with `!.env.example`) |
| `db/custom.db` | **private user data** — account row(s) (bcrypt password hashes), sessions, bot records, audit logs | `git rm --cached`; `.gitignore` now ignores `db/*.db`, `db/*.db.backup-*`, `*.db-journal/-wal/-shm` |
| `.zscripts/dev.pid` | runtime artifact (PID file) | `git rm --cached` |

Retained on purpose: `.env.example` (placeholders only), all source code,
`prisma/migrations/`, deployment configs, docs, CI workflow.

## Credential exposure assessment (git history audit)

Full history inspected (`git log --all -p`):

- `.env` was committed in both commits and ever contained exactly **one**
  line: `DATABASE_URL` pointing at the local SQLite file path. **No real
  credential was ever committed.**
- `db/custom.db` was committed in the second commit. It contains only
  **local development test data** (one test admin account, one QA bot,
  audit entries). Still: treat it as private user data — it is now excluded
  from releases and tracking.

**Rotation required: none.** No API keys, OAuth secrets, payment keys or
runtime keys have ever been committed. (If this repository is ever published
as-is, rotate the *test admin password* — its bcrypt hash is public data at
that point — and purge the files as described below.)

## Git history cleanup (requires approval — not executed)

Both files remain reachable in the two existing commits. If the repository
will be pushed to a shared/public remote, purge them from history first:

```bash
pip install git-filter-repo
git filter-repo --invert-paths --path .env --path db/custom.db --force
# then re-add the remote and force-push (rewrites ALL commit hashes)
```

Alternatively publish the validated release archives (which never contain
`.env` or `*.db`) as the public artifact and keep this repository private.

## Release packaging guarantees

`scripts/package-release.sh` excludes: `node_modules`, `.next`, `.open-next`,
`.env*` (except `.env.example`), all local databases and backups, `bot-data/`,
logs, `.zscripts`, `download/`, `.git`, and any nested archives. The script
validates both archives (zip + tar.gz) after creation: integrity test,
extraction to clean directories, file-list and checksum comparison, essential
file presence, and absence of nested archives or databases.
