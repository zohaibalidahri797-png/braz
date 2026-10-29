/* ============================================================
   BotDock Cloud — settings.js
   Profile, password, active sessions, GitHub token (server-side
   encrypted), and the backend connection settings (configurable
   API base URL + live connection test).
   ============================================================ */
(function () {
  "use strict";
  var App = window.BotDockApp, API = window.BotDockAPI;

  function loadProfile() {
    if (App.demo || !App.user) return;
    App.$("#pfName").value = App.user.name || "";
    App.$("#pfEmail").value = App.user.email || "";
    App.$("#pfVerified").textContent = App.user.emailVerified ? "✓ verified" : "not verified";
    App.$("#pfRole").textContent = App.user.role;
    if (!App.user.emailVerified) {
      var row = App.$("#resendRow");
      row.hidden = false;
      App.$("#resendBtn").addEventListener("click", function (ev) {
        var btn = ev.currentTarget;
        App.busy(btn, true, "Sending…");
        API.auth.resendVerification().then(function () {
          App.busy(btn, false);
          App.toast("Sent", "Verification email sent (if a provider is configured).", "ok");
        }).catch(function (err) { App.busy(btn, false); App.toast("Could not send", err.detail || err.message, "err"); });
      });
    }
  }

  function loadSessions() {
    if (App.demo) {
      App.$("#sessionsList").innerHTML = '<p class="faint">Demo mode — no real sessions.</p>';
      return;
    }
    API.auth.sessions().then(function (r) {
      var list = r.sessions || [];
      App.$("#sessionsList").innerHTML = list.map(function (s) {
        return '<div class="env-row"><span>' + App.escapeHtml(s.ip || "unknown ip") + '</span><span class="faint">' +
          App.escapeHtml((s.userAgent || "").slice(0, 60)) + "</span><span class=\"faint\">" +
          (s.current ? "this session · " : "") + App.relTime(s.createdAt) + '</span><span class="spacer"></span>' +
          (s.current ? "" : '<button class="btn btn-sm btn-danger" data-revoke="' + App.escapeHtml(s.id) + '">Revoke</button>') + "</div>";
      }).join("") || '<p class="faint">No sessions.</p>';
      App.$$("#sessionsList [data-revoke]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          API.auth.revokeSession(btn.dataset.revoke).then(loadSessions).catch(function (e) { App.toast("Failed", e.detail || e.message, "err"); });
        });
      });
      var all = App.$("#revokeAllBtn");
      if (all) {
        all.disabled = list.length < 2;
        all.onclick = function () {
          App.confirm({ title: "Sign out everywhere?", message: "Revokes every session including this one.", confirmLabel: "Revoke all", danger: true })
            .then(function (yes) {
              if (!yes) return;
              API.auth.revokeAllSessions().then(function () { location.href = "/login.html"; });
            });
        };
      }
    }).catch(function (e) { App.errorBox("#sessionsList", "Could not load sessions", e.detail || e.message); });
  }

  function loadGithub() {
    var wrap = App.$("#ghPanel");
    if (App.demo) { wrap.innerHTML = '<p class="faint">Demo mode — GitHub tokens require a backend.</p>'; return; }
    API.github.status().then(function (r) {
      App.$("#ghStatus").innerHTML = r.configured
        ? '✓ token stored' + (r.label ? ' (<strong>' + App.escapeHtml(r.label) + "</strong>)" : "") + (r.scopes ? ' <span class="faint">scopes: ' + App.escapeHtml(r.scopes) + "</span>" : "")
        : "No token stored.";
      App.$("#ghRemove").disabled = !r.configured;
    }).catch(function (e) { App.$("#ghStatus").textContent = e.detail || e.message; });
  }

  function saveGithub(btn) {
    var token = App.$("#ghToken").value.trim();
    var label = App.$("#ghLabel").value.trim();
    if (token.length < 20) { App.$("#ghError").textContent = "A GitHub token is at least 20 characters."; return; }
    App.busy(btn, true, "Validating…");
    API.github.saveToken({ token: token, label: label || undefined }).then(function (r) {
      App.busy(btn, false);
      App.$("#ghToken").value = "";
      App.toast("Token saved", r.note || "Encrypted at rest.", "ok");
      loadGithub();
    }).catch(function (err) {
      App.busy(btn, false);
      App.$("#ghError").textContent = err.detail || err.message;
    });
  }

  function backendPanel() {
    var input = App.$("#apiBaseInput");
    input.value = API.apiBase();
    App.$("#apiBaseSave").addEventListener("click", function () {
      API.setApiBase(input.value.trim());
      App.toast("Saved", "API base URL updated. Reloading…", "ok");
      setTimeout(function () { location.reload(); }, 800);
    });
    App.$("#apiBaseReset").addEventListener("click", function () {
      API.setApiBase("");
      App.toast("Reset", "Using same-origin API. Reloading…", "ok");
      setTimeout(function () { location.reload(); }, 800);
    });
    App.$("#apiTestBtn").addEventListener("click", function (ev) {
      var btn = ev.currentTarget, out = App.$("#apiTestOut");
      btn.disabled = true;
      out.textContent = "Testing " + (API.apiBase() || "same-origin") + "/api/health …";
      fetch(API.apiBase() + "/api/health", { credentials: "include" })
        .then(function (r) { return r.json().then(function (j) { return { okRes: r.ok, j: j }; }); })
        .then(function (r) {
          var d = r.j || {};
          out.textContent = r.okRes
            ? "✓ Backend reachable — app: " + (d.app && d.app.status) + ", db: " + (d.database && d.database.status) + ", auth: " + (d.auth && d.auth.status) + ", runtime: " + (d.runtime && d.runtime.status)
            : "✗ Backend responded but reported problems (HTTP " + r.j.status + ").";
        })
        .catch(function () { out.textContent = "✗ Could not reach the backend — the site runs in demo mode."; })
        .finally(function () { btn.disabled = false; });
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    App.boot({ mode: "app", page: "settings.html" }).then(function () {
      loadProfile();
      loadSessions();
      loadGithub();
      backendPanel();

      App.$("#pfSave").addEventListener("click", function (ev) {
        var btn = ev.currentTarget, name = App.$("#pfName").value.trim();
        if (!name) return;
        if (App.demo) { App.demoToast(); return; }
        App.busy(btn, true, "Saving…");
        API.auth.updateProfile({ name: name }).then(function () {
          App.busy(btn, false);
          App.toast("Saved", "Profile updated.", "ok");
        }).catch(function (e) { App.busy(btn, false); App.toast("Failed", e.detail || e.message, "err"); });
      });

      App.$("#pwSave").addEventListener("click", function (ev) {
        var btn = ev.currentTarget;
        var cur = App.$("#pwCur").value, next = App.$("#pwNew").value;
        var err = App.$("#pwError");
        if (next.length < 10) { err.textContent = "New password must be at least 10 characters."; return; }
        err.textContent = "";
        if (App.demo) { App.demoToast(); return; }
        App.busy(btn, true, "Updating…");
        API.auth.changePassword({ currentPassword: cur, newPassword: next }).then(function () {
          App.busy(btn, false);
          App.$("#pwCur").value = ""; App.$("#pwNew").value = "";
          App.toast("Password changed", "", "ok");
        }).catch(function (e) { App.busy(btn, false); err.textContent = e.detail || e.message; });
      });

      App.$("#ghSave").addEventListener("click", function () { saveGithub(this); });
      App.$("#ghRemove").addEventListener("click", function () {
        App.confirm({ title: "Remove GitHub token?", confirmLabel: "Remove", danger: true }).then(function (yes) {
          if (!yes) return;
          API.github.removeToken().then(function () { App.toast("Token removed", "", "ok"); loadGithub(); });
        });
      });
    });
  });
})();
