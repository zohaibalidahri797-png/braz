# Static Frontend — Cloudflare Pages Direct Upload

The BotDock frontend is **pure HTML5 + CSS3 + vanilla JavaScript**. No React,
no build step, no bundler. You upload the finished folder straight to
Cloudflare Pages — this is the fix for the recurring *"Could not detect a
directory containing static files"* / 404 problem with source-ZIP uploads.

The **backend is separate** and stays deployed as a Cloudflare **Worker**
(OpenNext) plus the bot runtime service. The frontend talks to it over
`/api/*` from the **same origin** (recommended) — no CORS, cookies just work.

---

## 1. What's in the static site

```
index.html            ← must be at the folder root (Pages requirement)
login.html  register.html  forgot-password.html  reset-password.html
dashboard.html  bots.html  deploy.html  bot-details.html
pricing.html  settings.html  admin.html  docs.html
404.html              ← Pages serves this automatically for unknown paths
_redirects            ← API proxy template (activate one line — see below)
favicon.svg
assets/css/style.css
assets/js/api.js      ← API client + configurable base URL
assets/js/app.js      ← shared shell, theme, toasts, guards
assets/js/auth.js  dashboard.js  deploy.js  bot-details.js  settings.js  pages.js
assets/js/demo.js     ← clearly-labeled demo data (backend offline only)
assets/images/logo.svg
```

## 2. Deploy to Cloudflare Pages (Direct Upload) — Android-friendly steps

1. **Get the ZIP**: download `botdock-pages.zip` (link on the Docs page, or
   `/api/download?file=botdock-pages.zip` on any running BotDock instance).
2. On your phone/desktop browser open **dash.cloudflare.com** →
   **Workers & Pages → Create → Pages → Upload assets**.
3. Name the project (e.g. `botdock`), then **upload the extracted folder's
   contents** — make sure `index.html` is at the **root** of what you upload
   (not nested inside another folder — a nested folder is a classic cause of
   blank/404 Pages sites).
4. **Deploy**. Your site is live at `https://<project>.pages.dev`.
5. Pages now serves `404.html` for unknown URLs automatically — nothing else
   to configure.

> CLI alternative: `npx wrangler pages deploy <folder> --project-name botdock`
> (`wrangler pages deploy` is a plain file upload — no build step).

## 3. Connect the backend (required for anything real)

Without a backend the site runs in **DEMO MODE** (banner + sample data;
nothing is presented as a real deployment). To go live:

1. Deploy the backend Worker from the full repository:
   `bun install --frozen-lockfile && bun run cf:build && bun run cf:deploy`
   (see `docs/DEPLOYMENT.md` for secrets, database and the verification gate).
2. In your Pages project, **File manager / direct upload**: edit the included
   `_redirects` file, remove the leading `# ` from the proxy line and set your
   Worker URL:
   ```
   /api/* https://botdock-cloud.YOUR-SUBDOMAIN.workers.dev/:splat 200
   ```
   Redeploy (upload again). Now `/api/*` on your Pages domain proxies to the
   Worker — same-origin for the browser, so the session cookie works with
   zero CORS configuration.
3. Verify: open the site → Settings → **Test connection**. It should report
   `✓ Backend reachable — app: healthy, db: healthy …`.

**Alternative (single deployment, no Pages):** the backend Worker *also serves
this static site* — `public/` is bundled into the Worker's assets at
`bun run cf:build`. After `bun run cf:deploy`, the Worker URL serves the site
at `/` (redirects to `/index.html`) and the API at `/api/*`. One deploy, one
domain, no proxy. Use whichever fits.

**Advanced (separate domains):** possible but not recommended — cross-site
cookies (`SameSite=None`), CSRF origin rules and CORS would all need
re-configuration. Prefer the proxy.

## 4. Demo mode (no backend configured)

- Detected automatically: `GET /api/health` fails → every page shows a
  **DEMO MODE** banner; app pages get a DEMO badge.
- Sample bots, deployments, logs, plans and admin stats are rendered from
  `assets/js/demo.js` — all in memory, reset on reload.
- **Every mutating action shows a "Demo mode" toast** instead of pretending.
  Demo deployments are never labeled RUNNING as if real — the demo banner and
  badge stay on screen at all times.
- No secrets are involved: demo mode has no credentials anywhere.

## 5. Security notes

- Session cookie: httpOnly, SameSite=Lax, Secure (in production), signed
  (HS256) and revocable in the database. **Nothing sensitive is stored in
  localStorage** — the only localStorage keys are the UI theme and the
  API base URL (a non-secret URL you type).
- Bot tokens / env vars: entered in the dashboard, sent over HTTPS, encrypted
  at rest server-side (AES-256-GCM), write-only from the browser (masked
  `••••••••` after save).
- GitHub tokens: same — encrypted server-side, never returned to the browser.
- Server-side enforcement for everything: ownership, plan limits, roles,
  rate limits, CSRF origin checks, archive safety scans.
