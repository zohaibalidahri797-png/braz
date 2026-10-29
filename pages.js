/* ============================================================
   BotDock Cloud — pricing.js + admin.js
   pricing: renders real plans from GET /api/plans (demo plans
   when no backend); upgrade calls the billing integration and
   honestly reports when billing is not configured (501).
   admin: protected overview over users, service status and the
   audit log — every permission is enforced by the backend.
   ============================================================ */
(function () {
  "use strict";
  var App = window.BotDockApp, API = window.BotDockAPI, Demo = window.BotDockDemo;

  /* ── PRICING ───────────────────────────────────────────── */
  function check(li, ok) {
    return '<li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">' +
      (ok ? '<path d="m4 12 5 5L20 6"/>' : '<path d="M6 6l12 12M18 6 6 18"/>') + "</svg><span>" + App.escapeHtml(li) + "</span></li>";
  }

  function renderPlans(plans, currentPlanId, demo) {
    var grid = App.$("#planGrid");
    grid.innerHTML = plans.map(function (p, i) {
      var featured = p.id === "pro" || i === 1;
      var price = p.priceMonthly == null ? "Custom" :
        p.priceMonthly === 0 ? "Free" : "$" + p.priceMonthly + '<small>/mo</small>';
      var isCurrent = currentPlanId === p.id;
      var btn = isCurrent
        ? '<button class="btn" disabled>Current plan</button>'
        : p.priceMonthly == null
          ? '<a class="btn" href="/docs.html">Contact us</a>'
          : p.priceMonthly === 0
            ? '<a class="btn btn-primary" href="/register.html">Get started</a>'
            : '<button class="btn btn-primary" data-upgrade="' + App.escapeHtml(p.id) + '">Upgrade</button>';
      return '<div class="plan-card' + (featured ? ' featured' : '') + '">' +
        (featured ? '<span class="plan-flag">MOST POPULAR</span>' : "") +
        '<div class="plan-name">' + App.escapeHtml(p.name) + "</div>" +
        '<div class="price">' + price + "</div>" +
        '<div class="faint">' + App.escapeHtml(p.description || "") + "</div>" +
        "<ul>" + (p.features || []).map(function (f) { return check(f, true); }).join("") + "</ul>" + btn + "</div>";
    }).join("");
    App.$$("#planGrid [data-upgrade]").forEach(function (btn) {
      btn.addEventListener("click", function () { upgrade(btn.dataset.upgrade); });
    });
    if (demo) {
      var note = App.$("#plansNote");
      note.hidden = false;
      note.textContent = "Demo plans shown — connect a backend to load the real plan configuration.";
    }
  }

  function upgrade(planId) {
    if (App.demo) { App.demoToast(); return; }
    App.toast("Checking billing…", "", "info");
    API.platform.upgrade({ planId: planId, billingCycle: "monthly" }).then(function (r) {
      if (r && (r.checkoutUrl || r.url)) { location.href = r.checkoutUrl || r.url; return; }
      App.toast("Upgrade", "Billing accepted the request but returned no checkout URL.", "warn");
    }).catch(function (err) {
      if (err.status === 501) {
        App.toast("Billing is not configured", err.detail || "Payments are not enabled on this deployment — the free plan is fully usable.", "warn");
      } else {
        App.toast("Upgrade failed", err.detail || err.message, "err");
      }
    });
  }

  function initPricing() {
    App.boot({ mode: "public", page: "Pricing" }).then(function () {
      if (App.demo) { renderPlans(Demo.plans, null, true); return; }
      API.platform.plans().then(function (r) {
        renderPlans(r.plans || [], App.user && App.user.planId, false);
        if (r.freeOnly) {
          var note = App.$("#plansNote");
          note.hidden = false;
          note.textContent = "Free-launch mode: paid upgrades are not enabled yet — every plan is free while the platform is in launch.";
        }
      }).catch(function (err) {
        App.errorBox("#planGrid", "Could not load plans", err.detail || err.message);
        renderPlans(Demo.plans, null, true);
      });
    });
  }

  /* ── ADMIN ─────────────────────────────────────────────── */
  function renderAdminStats(s) {
    App.$("#adUsers").textContent = s.users ? s.users.total : "—";
    App.$("#adVerified").textContent = s.users ? s.users.verified : "—";
    App.$("#adBotsRunning").textContent = (s.bots && s.bots.RUNNING) || 0;
    App.$("#adBotsFailed").textContent = (s.bots && s.bots.FAILED) || 0;
    App.$("#adDeploys24").textContent = s.deployments ? s.deployments.last24h : "—";
    App.$("#adFailed24").textContent = s.deployments ? s.deployments.failedLast24h : "—";
    var rt = App.$("#adRuntime");
    if (s.runtimeError) { rt.textContent = "offline"; rt.style.color = "var(--danger)"; }
    else if (s.runtime && s.runtime.ok) { rt.textContent = "online · " + (s.runtime.activeBots || 0) + " active bots"; }
    else rt.textContent = "unknown";
  }

  function loadAdmin() {
    var p = App.demo ? Demo.adminStats() : API.admin.stats();
    p.then(renderAdminStats).catch(function (err) {
      App.errorBox("#adminStatsWrap", "Could not load admin stats", err.detail || err.message);
    });

    var up = App.demo ? Demo.adminUsers() : API.admin.users("", 1);
    up.then(function (r) {
      App.$("#adminUsers").innerHTML = '<div class="table-wrap"><table class="tbl"><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Bots</th><th>Joined</th></tr></thead><tbody>' +
        (r.users || []).map(function (u) {
          return "<tr><td><strong>" + App.escapeHtml(u.name || u.email) + "</strong><div class=\"faint\">" + App.escapeHtml(u.email) + "</div></td>" +
            '<td><span class="badge badge-ROLE">' + App.escapeHtml(u.role) + "</span></td>" +
            "<td>" + App.escapeHtml(u.status) + (u.emailVerified ? "" : ' <span class="faint">(unverified)</span>') + "</td>" +
            "<td>" + (u.botCount != null ? u.botCount : "—") + "</td><td>" + App.relTime(u.createdAt) + "</td></tr>";
        }).join("") + "</tbody></table></div>";
    }).catch(function (err) { App.errorBox("#adminUsers", "Could not load users", err.detail || err.message); });

    var ap = App.demo ? Demo.audit() : API.admin.audit(1);
    ap.then(function (r) {
      App.$("#adminAudit").innerHTML = (r.logs || []).map(function (l) {
        return '<div class="env-row"><span class="key">' + App.escapeHtml(l.action) + "</span><span>" +
          App.escapeHtml(l.actorEmail || "system") + "</span><span class=\"spacer\"></span><span class=\"faint\">" +
          App.relTime(l.createdAt) + "</span></div>";
      }).join("") || '<p class="faint">No audit entries.</p>';
    }).catch(function (err) { App.errorBox("#adminAudit", "Could not load audit log", err.detail || err.message); });
  }

  function initAdmin() {
    App.boot({ mode: "app", page: "admin.html", requireAdmin: true }).then(function () {
      if (App.demo) {
        var b = App.$("#demoBanner"); if (b) b.hidden = false;
        var badge = App.$("#demoBadge"); if (badge) badge.hidden = false;
      }
      loadAdmin();
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    if (App.$("#planGrid")) initPricing();
    if (App.$("#adminStatsWrap")) initAdmin();
  });
})();
