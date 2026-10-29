/* ============================================================
   BotDock Cloud — app.js
   Shared shell + UI helpers for every page (vanilla JS).
   Injects the common header/sidebar/footer, applies the saved
   theme, exposes toasts/dialogs/formatters, and guards
   authenticated pages via GET /api/auth/me (httpOnly cookie —
   no tokens in JavaScript).
   ============================================================ */
(function () {
  "use strict";

  var App = (window.BotDockApp = {});
  App.demo = false; // set true by boot() when backend is unreachable
  App.user = null;

  /* ── tiny DOM + formatting helpers ─────────────────────────── */
  App.$ = function (sel, root) { return (root || document).querySelector(sel); };
  App.$$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  App.escapeHtml = function (s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  };

  App.fmtBytes = function (n) {
    if (n == null || isNaN(n)) return "—";
    var u = ["B", "KB", "MB", "GB"], i = 0, v = Number(n);
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i === 0 ? v : v.toFixed(1)) + " " + u[i];
  };

  App.fmtUptime = function (sec) {
    if (sec == null || isNaN(sec)) return "—";
    var s = Math.floor(Number(sec));
    var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d) return d + "d " + h + "h";
    if (h) return h + "h " + m + "m";
    if (m) return m + "m " + (s % 60) + "s";
    return s + "s";
  };

  App.fmtDate = function (iso) {
    if (!iso) return "—";
    try {
      var d = new Date(iso);
      return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) +
        " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    } catch (e) { return String(iso); }
  };

  App.relTime = function (iso) {
    if (!iso) return "—";
    var diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (isNaN(diff)) return "—";
    if (diff < 5) return "just now";
    if (diff < 60) return Math.floor(diff) + "s ago";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
    return Math.floor(diff / 86400) + "d ago";
  };

  App.statusBadge = function (status) {
    var s = String(status || "UNKNOWN");
    var cls = { RUNNING: "badge-RUNNING", BUILDING: "badge-BUILDING", DEPLOYING: "badge-DEPLOYING",
      QUEUED: "badge-QUEUED", STOPPED: "badge-STOPPED", CREATED: "badge-CREATED",
      FAILED: "badge-FAILED", CANCELED: "badge-CANCELED", RUNTIME_OFFLINE: "badge-FAILED" }[s] || "";
    return '<span class="badge ' + cls + '">' + App.escapeHtml(s) + "</span>";
  };

  App.runtimeLabel = function (r) {
    return { PYTHON: "Python", NODE: "Node.js", BUN: "Bun" }[r] || String(r || "—");
  };

  /* ── theme ─────────────────────────────────────────────────── */
  App.applyTheme = function (t) {
    if (t) { try { localStorage.setItem("botdock_theme", t); } catch (e) {} }
    else { try { t = localStorage.getItem("botdock_theme") || "dark"; } catch (e) { t = "dark"; } }
    document.documentElement.setAttribute("data-theme", t);
    var btn = App.$("#themeBtn");
    if (btn) { btn.title = t === "dark" ? "Switch to light theme" : "Switch to dark theme"; }
  };
  App.toggleTheme = function () {
    var cur = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    App.applyTheme(cur);
  };

  /* ── toasts ────────────────────────────────────────────────── */
  App.toast = function (title, msg, kind) {
    var region = App.$(".toast-region");
    if (!region) { region = document.createElement("div"); region.className = "toast-region"; region.setAttribute("role", "status"); region.setAttribute("aria-live", "polite"); document.body.appendChild(region); }
    var el = document.createElement("div");
    el.className = "toast" + (kind ? " " + kind : "");
    el.innerHTML = '<div class="t-title">' + App.escapeHtml(title) + "</div>" + (msg ? '<div>' + App.escapeHtml(msg) + "</div>" : "");
    region.appendChild(el);
    setTimeout(function () { el.style.opacity = "0"; el.style.transition = "opacity .3s"; setTimeout(function () { el.remove(); }, 320); }, kind === "err" ? 6500 : 4200);
  };
  App.demoToast = function () {
    App.toast("Demo mode", "This action is simulated — connect a real backend to perform it.", "warn");
  };

  /* ── confirm dialog (promise-based) ────────────────────────── */
  App.confirm = function (opts) {
    return new Promise(function (resolve) {
      var dlg = document.createElement("dialog");
      if (opts.danger) dlg.className = "danger";
      dlg.innerHTML =
        "<h3>" + App.escapeHtml(opts.title || "Are you sure?") + "</h3>" +
        '<p class="muted" style="margin:0">' + App.escapeHtml(opts.message || "") + "</p>" +
        '<div class="d-actions"><button class="btn" data-a="cancel">Cancel</button>' +
        '<button class="btn ' + (opts.danger ? "btn-danger" : "btn-primary") + '" data-a="ok">' + App.escapeHtml(opts.confirmLabel || "Confirm") + "</button></div>";
      document.body.appendChild(dlg);
      function close(ans) { dlg.close(); dlg.remove(); resolve(ans); }
      dlg.querySelector('[data-a="cancel"]').addEventListener("click", function () { close(false); });
      dlg.querySelector('[data-a="ok"]').addEventListener("click", function () { close(true); });
      dlg.addEventListener("cancel", function () { close(false); });
      dlg.showModal();
    });
  };

  /* ── busy button helper ────────────────────────────────────── */
  App.busy = function (btn, isBusy, busyLabel) {
    if (!btn) return;
    if (isBusy) {
      btn.dataset.label = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner sm"></span> ' + App.escapeHtml(busyLabel || "Working…");
    } else {
      btn.disabled = false;
      if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
    }
  };

  /* ── polling helper (pauses when tab hidden) ───────────────── */
  App.poller = function (fn, intervalMs) {
    var stopped = false, timer = null;
    function tick() {
      if (stopped) return;
      if (document.hidden) return; // skip while hidden; next timer keeps loop alive
      Promise.resolve().then(fn).catch(function () { /* polled fn reports its own errors */ });
    }
    timer = setInterval(tick, intervalMs);
    return {
      stop: function () { stopped = true; clearInterval(timer); },
      tickNow: tick,
    };
  };

  /* ── SVG icon set ──────────────────────────────────────────── */
  App.icon = function (name) {
    var P = {
      logo: '<path d="M12 2 3 7v10l9 5 9-5V7l-9-5Zm0 2.3L18.6 8 12 11.7 5.4 8 12 4.3ZM5 9.7l6 3.4v6.6l-6-3.4V9.7Zm8 10V13.1l6-3.4v6.6l-6 3.4Z"/>',
      grid: '<path d="M3 3h8v8H3V3Zm10 0h8v8h-8V3ZM3 13h8v8H3v-8Zm10 0h8v8h-8v-8Z"/>',
      rocket: '<path d="M12 2c4 2 6 6 6 10l2 3-4 1-2 4h-4l-2-4-4-1 2-3c0-4 2-8 6-10Zm0 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z"/>',
      tag: '<path d="M2 12 12 2h8v8L10 20l-8-8Zm14-6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z"/>',
      gear: '<path d="m10 2 .4 2.6a7 7 0 0 0-1.8 1L6.2 4.5 4.5 6.2l1.1 2.4a7 7 0 0 0-1 1.8L2 10.8v2.4l2.6.4a7 7 0 0 0 1 1.8l-1.1 2.4 1.7 1.7 2.4-1.1a7 7 0 0 0 1.8 1L10 22h2.4l.4-2.6a7 7 0 0 0 1.8-1l2.4 1.1 1.7-1.7-1.1-2.4a7 7 0 0 0 1-1.8l2.6-.4v-2.4l-2.6-.4a7 7 0 0 0-1-1.8l1.1-2.4-1.7-1.7-2.4 1.1a7 7 0 0 0-1.8-1L12.4 2H10Zm1 6a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"/>',
      shield: '<path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Z"/>',
      bell: '<path d="M12 2a6 6 0 0 0-6 6v3.6L4 16h16l-2-4.4V8a6 6 0 0 0-6-6Zm-2 16a2 2 0 1 0 4 0h-4Z"/>',
      sun: '<path d="M12 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10Zm0-13V1m0 22v-3M4.2 4.2 2.1 2.1m19.8 19.8-2.1-2.1M1 12h3m17 0h3M4.2 19.8l-2.1 2.1M21.9 2.1l-2.1 2.1"/>',
      moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/>',
      menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
      bot: '<path d="M12 2a2 2 0 0 1 2 2v1h4a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4V4a2 2 0 0 1 2-2Zm-3.5 8A1.5 1.5 0 1 0 10 11.5 1.5 1.5 0 0 0 8.5 10Zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3ZM8 15h8v2H8Z"/>',
      logout: '<path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5m4-4 5-5-5-5m5 5H9"/>',
      chart: '<path d="M4 20V10m6 10V4m6 16v-7m4 7H2"/>',
      users: '<path d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 2c-4 0-7 2-7 5v3h14v-3c0-3-3-5-7-5Zm8-9a3.5 3.5 0 1 1-2 6.4M17 13c3 .5 5 2.3 5 5v3h-4"/>',
      file: '<path d="M6 2h8l6 6v14H6V2Zm8 1.5V9h5.5"/>',
      scroll: '<path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2V3Zm4 5h6m-6 4h6m-6 4h4"/>',
    };
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (P[name] || "") + "</svg>";
  };

  /* ── shared header/sidebar/footer templates ────────────────── */
  var LOGO = '<img src="/assets/images/logo.svg" alt="" width="28" height="28">';

  function publicHeader(active) {
    var links = [
      ["Features", "/index.html#features"],
      ["How it works", "/index.html#how"],
      ["Pricing", "/pricing.html"],
      ["Docs", "/docs.html"],
    ];
    return '<a class="skip-link" href="#main">Skip to content</a>' +
      '<header class="site-header"><a class="brand" href="/index.html">' + LOGO + "<span>BotDock Cloud</span>" +
      '<span class="beta">LAUNCH</span></a><nav aria-label="Main">' +
      links.map(function (l) {
        return '<a href="' + l[1] + '"' + (l[0] === active ? ' aria-current="page"' : "") + ">" + l[0] + "</a>";
      }).join("") +
      '<span id="authNav"></span></nav></header>' +
      '<div class="demo-banner" id="demoBanner" hidden><span class="badge badge-DEMO">DEMO MODE</span>' +
      "<span>Preview with sample data — no backend connected. Nothing here is a real deployment.</span></div>";
  }

  function publicFooter() {
    return '<footer class="site-footer"><div>© ' + new Date().getFullYear() +
      " BotDock Cloud — hosting for Telegram bots &amp; automations.</div>" +
      "<nav aria-label=\"Footer\"><a href=\"/pricing.html\">Pricing</a><a href=\"/index.html#features\">Features</a>" +
      '<a href="/docs.html">Docs</a><a href="/404.html">Status</a><a href="/api/download?file=botdock-pages.zip">Download static frontend</a></nav></footer>';
  }

  function appSidebar(active, isAdmin) {
    var items = [
      ["dashboard.html", "grid", "Overview"],
      ["deploy.html", "rocket", "New bot"],
      ["bots.html", "bot", "My bots"],
      ["pricing.html", "tag", "Plan & usage"],
      ["settings.html", "gear", "Settings"],
    ];
    if (isAdmin) items.push(["admin.html", "shield", "Admin"]);
    return '<nav class="sidebar" id="sidebar" aria-label="Dashboard">' +
      items.map(function (it) {
        return '<a href="/' + it[0] + '"' + (it[0] === active ? ' aria-current="page"' : "") + ">" + App.icon(it[1]) + "<span>" + it[2] + "</span></a>";
      }).join("") +
      '<div class="side-note" id="planNote">Plan: —</div></nav>' +
      '<div class="scrim" id="scrim"></div>';
  }

  function appHeader() {
    return '<a class="skip-link" href="#main">Skip to content</a>' +
      '<header class="app-header"><button class="icon-btn" id="menuBtn" aria-label="Toggle navigation" aria-controls="sidebar" aria-expanded="false">' + App.icon("menu") + "</button>" +
      '<a class="brand" href="/dashboard.html"><img src="/assets/images/logo.svg" alt="" width="26" height="26"><span>BotDock Cloud</span></a>' +
      '<span class="spacer"></span>' +
      '<span class="badge badge-DEMO" id="demoBadge" hidden>DEMO</span>' +
      '<button class="icon-btn" id="themeBtn" aria-label="Toggle color theme">' + App.icon("sun") + "</button>" +
      '<button class="icon-btn" id="notifBtn" aria-label="Notifications" hidden>' + App.icon("bell") + '<span class="badge-dot" id="notifDot" hidden>0</span></button>' +
      '<a class="avatar" id="userAvatar" href="/settings.html" title="Account settings" aria-label="Account settings">?</a>' +
      '<button class="icon-btn" id="logoutBtn" aria-label="Sign out">' + App.icon("logout") + "</button></header>" +
      '<div class="demo-banner" id="demoBanner" hidden><span class="badge badge-DEMO">DEMO MODE</span>' +
      "<span>Preview with sample data — no backend connected. Nothing here is a real deployment.</span></div>";
  }

  App.errorBox = function (container, title, detail) {
    if (typeof container === "string") container = App.$(container);
    if (!container) return;
    container.innerHTML = '<div class="note error"><span class="n-icon">⚠</span><div><strong>' +
      App.escapeHtml(title || "Something went wrong") + "</strong>" +
      (detail ? '<div class="faint">' + App.escapeHtml(detail) + "</div>" : "") + "</div></div>";
  };

  App.emptyBox = function (container, icon, title, sub, ctaHtml) {
    if (typeof container === "string") container = App.$(container);
    if (!container) return;
    container.innerHTML = '<div class="empty"><div class="big">' + (icon || "📦") + "</div>" +
      '<h3 class="mt-0">' + App.escapeHtml(title) + "</h3><p>" + App.escapeHtml(sub || "") + "</p>" + (ctaHtml || "") + "</div>";
  };

  /* ── boot ──────────────────────────────────────────────────── */
  /**
   * boot({ mode: "public" | "app", page, requireAdmin })
   *  - detects backend availability → App.demo
   *  - app mode: GET /api/auth/me; 401 → redirect to login (unless demo)
   */
  App.boot = function (opts) {
    opts = opts || {};
    App.applyTheme();
    var headerEl = App.$("[data-shell='header']");
    var root = document.body;

    function renderShell(user) {
      if (opts.mode === "app") {
        headerEl.innerHTML = appHeader();
        var body = App.$(".app-body");
        body.insertAdjacentHTML("afterbegin", appSidebar(opts.page, user && user.role === "ADMIN"));
        App.$("#menuBtn").addEventListener("click", function () {
          var sb = App.$("#sidebar");
          var open = sb.classList.toggle("open");
          App.$("#scrim").classList.toggle("show", open);
          this.setAttribute("aria-expanded", String(open));
        });
        App.$("#scrim").addEventListener("click", function () {
          App.$("#sidebar").classList.remove("open");
          App.$("#scrim").classList.remove("show");
        });
        var avatar = App.$("#userAvatar");
        if (user) {
          avatar.textContent = (user.name || user.email || "?").trim().charAt(0).toUpperCase();
          if (user.role === "ADMIN") avatar.title = "Account settings (administrator)";
        }
        App.$("#themeBtn").addEventListener("click", App.toggleTheme);
        App.$("#logoutBtn").addEventListener("click", function () { App.logout(); });
        var plan = App.$("#planNote");
        if (plan && user && (user.planName || (user.plan && user.plan.name))) plan.textContent = "Plan: " + (user.planName || user.plan.name);
        wireDemoIndicators();
        wireNotifications();
      } else {
        // Standalone auth pages (login/register/forgot/reset) have no shell
        // markers — renderShell must stay a no-op there, not throw (a throw
        // would kill the boot promise chain and leave the OAuth buttons
        // unwired and silently dead).
        if (headerEl) {
          headerEl.innerHTML = publicHeader(opts.page);
          var authNav = App.$("#authNav");
          if (user) {
            authNav.innerHTML = '<a href="/dashboard.html">Dashboard</a><a class="btn btn-primary btn-sm" href="/deploy.html" style="margin-left:6px">New bot</a>';
          } else {
            authNav.innerHTML = '<a href="/login.html">Sign in</a><a class="btn btn-primary btn-sm" href="/register.html" style="margin-left:6px">Get started</a>';
          }
          var navEl = App.$(".site-header nav");
          var th = document.createElement("button");
          th.className = "icon-btn"; th.id = "themeBtn"; th.setAttribute("aria-label", "Toggle color theme");
          th.innerHTML = App.icon("sun");
          if (navEl) { navEl.appendChild(th); th.addEventListener("click", App.toggleTheme); }
        }
      }
      var foot = App.$("[data-shell='footer']");
      if (foot) foot.innerHTML = publicFooter();
    }

    function wireDemoIndicators() {
      var badge = App.$("#demoBadge"), banner = App.$("#demoBanner");
      if (App.demo) {
        if (badge) badge.hidden = false;
        if (banner) banner.hidden = false;
      }
    }

    function wireNotifications() {
      var btn = App.$("#notifBtn"), dot = App.$("#notifDot");
      if (!btn || App.demo) return;
      BotDockAPI.platform.notifications().then(function (r) {
        if (r.notifications && r.notifications.length) {
          btn.hidden = false;
          if (r.unread > 0) { dot.hidden = false; dot.textContent = r.unread > 9 ? "9+" : r.unread; }
          btn.addEventListener("click", function () {
            App.confirm({
              title: "Notifications",
              message: r.notifications.slice(0, 8).map(function (n) { return "• " + (n.title || n.message || "—"); }).join("\n") || "No notifications.",
              confirmLabel: "Mark all read",
            }).then(function (yes) {
              if (yes) BotDockAPI.platform.markNotifications({ all: true }).then(function () { location.reload(); });
            });
          });
        }
      }).catch(function () { /* notifications are optional UI */ });
    }

    // 1) backend detection (shared promise) 2) session probe 3) shell render
    return BotDockAPI.backendAvailable().then(function (available) {
      App.demo = !available;
      if (!available) {
        // Demo mode: pretend a signed-in demo operator on app pages.
        if (opts.mode === "app") {
          App.user = { id: "demo", email: "demo@botdock.local", name: "Demo Operator", role: "ADMIN", emailVerified: true, planName: "Free (demo)" };
          renderShell(App.user);
          document.dispatchEvent(new CustomEvent("botdock:ready"));
          return App.user;
        }
        renderShell(null);
        var banner = App.$("#demoBanner"); if (banner) banner.hidden = false;
        document.dispatchEvent(new CustomEvent("botdock:ready"));
        return null;
      }
      // Real backend — probe the session for app mode + header state.
      return BotDockAPI.auth.me().then(function (r) {
        App.user = r.user || null;
        if (App.user && r.plan) App.user.planName = r.plan.name;
        if (App.user && r.plan && r.plan.id) App.user.planId = r.plan.id;
        if (opts.mode === "app" && !App.user) {
          var next = encodeURIComponent(location.pathname + location.search);
          location.replace("/login.html?next=" + next);
          return new Promise(function () { /* navigating away */ });
        }
        if (opts.requireAdmin && (!App.user || App.user.role !== "ADMIN")) {
          document.body.innerHTML = '<div class="center-page"><h2>403 — Administrators only</h2><p class="muted">Your account does not have administrator access.</p><a class="btn" href="/dashboard.html">Back to dashboard</a></div>';
          return new Promise(function () { /* stop */ });
        }
        renderShell(App.user);
        wireDemoIndicators();
        document.dispatchEvent(new CustomEvent("botdock:ready"));
        return App.user;
      }).catch(function (err) {
        if (err && err.status === 0) { App.demo = true; }
        else if (opts.mode === "app") { location.replace("/login.html"); return new Promise(function () {}); }
        renderShell(null);
        document.dispatchEvent(new CustomEvent("botdock:ready"));
        return null;
      });
    });
  };

  App.logout = function () {
    var done = function () { location.href = "/index.html"; };
    if (App.demo) { App.demoToast(); return; }
    BotDockAPI.auth.logout().then(done).catch(done); // always leave
  };

  /* OAuth start buttons (login + register share this) */
  App.wireOAuthButtons = function (config) {
    var g = App.$("#googleBtn"), h = App.$("#githubBtn");
    var note = App.$("#oauthNote");
    function base() { return BotDockAPI.apiBase(); }
    if (g) {
      if (config.google) g.addEventListener("click", function () { location.href = base() + "/api/auth/oauth/google"; });
      else g.setAttribute("aria-disabled", "true");
    }
    if (h) {
      if (config.githubOAuth) h.addEventListener("click", function () { location.href = base() + "/api/auth/oauth/github"; });
      else h.setAttribute("aria-disabled", "true");
    }
    if (note && (!config.google || !config.githubOAuth)) {
      var missing = [];
      if (!config.google) missing.push("Google");
      if (!config.githubOAuth) missing.push("GitHub");
      note.hidden = false;
      note.textContent = missing.join(" and ") + " sign-in is not configured on this deployment — an administrator must set the provider credentials first (docs/SETUP.md).";
    }
  };
})();
