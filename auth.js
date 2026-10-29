/* ============================================================
   BotDock Cloud — auth.js
   Login / register / forgot-password flows for the static pages.
   Uses the httpOnly session cookie — never stores credentials.
   Falls back to a clearly-labeled demo session when no backend
   is reachable.
   ============================================================ */
(function () {
  "use strict";
  var App = window.BotDockApp, API = window.BotDockAPI, Demo = window.BotDockDemo;

  function params() { return new URLSearchParams(location.search); }
  function showErr(msg) { var el = App.$("#formError"); if (el) el.textContent = msg || ""; }

  /* ── LOGIN ─────────────────────────────────────────────── */
  function initLogin() {
    var form = App.$("#loginForm");
    if (!form) return;

    // Error codes bounced back by the OAuth callback (#/login?error=…)
    var oauthErr = params().get("error");
    if (oauthErr) {
      var msgs = {
        oauth_state_mismatch: "The sign-in flow could not be verified (state mismatch). Start again.",
        oauth_provider_error: "The provider returned an error: " + (params().get("detail") || "unknown"),
        oauth_email_unverified: "Your provider email is not verified, so it was not linked. Sign in with your password, then connect the provider from Settings.",
        account_blocked: "This account is suspended or banned.",
        oauth_failed: "Sign-in failed: " + (params().get("detail") || "unknown error"),
        unknown_provider: "Unknown provider.",
        oauth_missing_params: "The sign-in flow was interrupted. Start again.",
      };
      showErr(msgs[oauthErr] || ("Sign-in error: " + oauthErr));
    }

    App.boot({ mode: "public", page: "Sign in" }).then(function (user) {
      if (user && !App.demo) { location.replace(params().get("next") || "/dashboard.html"); return; }
      // OAuth provider availability (real backend only)
      if (!App.demo) {
        API.auth.config().then(function (c) { App.wireOAuthButtons(c); }).catch(function () { /* buttons stay disabled */ });
      } else {
        var note = App.$("#oauthNote");
        if (note) { note.hidden = false; note.textContent = "Demo mode: OAuth providers are not available without a backend. Use the demo sign-in below."; }
      }
      var demoBtn = App.$("#demoBtn");
      if (demoBtn) demoBtn.hidden = !App.demo;
    });

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      showErr("");
      var email = App.$("#email").value.trim();
      var password = App.$("#password").value;
      if (!email || !password) { showErr("Enter your email and password."); return; }
      if (App.demo) {
        App.toast("Demo session", "Signed in to the DEMO workspace. No real backend is connected.", "info");
        setTimeout(function () { location.href = "/dashboard.html"; }, 600);
        return;
      }
      var btn = App.$("#loginSubmit");
      App.busy(btn, true, "Signing in…");
      API.auth.login({ email: email, password: password }).then(function () {
        var next = params().get("next");
        location.href = next && next.indexOf("/logout") !== 0 ? next : "/dashboard.html";
      }).catch(function (err) {
        App.busy(btn, false);
        showErr(err.status === 429 ? (err.detail || "Too many attempts — try again later.")
          : err.status === 401 ? (err.detail || "Incorrect email or password.")
          : err.status === 403 ? (err.detail || "Account suspended or banned.")
          : err.detail || err.message);
      });
    });
  }

  /* ── REGISTER ──────────────────────────────────────────── */
  function initRegister() {
    var form = App.$("#registerForm");
    if (!form) return;

    App.boot({ mode: "public", page: "Create account" }).then(function (user) {
      if (user && !App.demo) { location.replace("/dashboard.html"); return; }
      if (!App.demo) {
        API.auth.config().then(function (c) {
          App.wireOAuthButtons(c);
          var tok = App.$("#bootstrapField");
          if (tok && c.bootstrapRequired) tok.hidden = false;
        }).catch(function () {});
      } else {
        var note = App.$("#oauthNote");
        if (note) { note.hidden = false; note.textContent = "Demo mode: OAuth and real registration are unavailable without a backend. The demo account lets you explore the UI."; }
        var demoBtn = App.$("#demoBtn");
        if (demoBtn) demoBtn.hidden = false;
      }
    });

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      showErr("");
      var name = App.$("#name").value.trim();
      var email = App.$("#email").value.trim();
      var password = App.$("#password").value;
      var bootstrapToken = App.$("#bootstrapToken") ? App.$("#bootstrapToken").value.trim() : "";
      if (!name || !email || !password) { showErr("Fill in every field."); return; }
      if (App.demo) {
        App.toast("Demo mode", "Registration is simulated. Connect a backend to create a real account.", "info");
        setTimeout(function () { location.href = "/dashboard.html"; }, 600);
        return;
      }
      var btn = App.$("#registerSubmit");
      App.busy(btn, true, "Creating account…");
      var body = { name: name, email: email, password: password };
      if (bootstrapToken) body.bootstrapToken = bootstrapToken;
      API.auth.register(body).then(function (res) {
        // 201: session created; email verification may still be pending.
        var v = App.$("#verifyPanel");
        form.hidden = true;
        v.hidden = false;
        if (res && res.devVerificationLink) {
          var a = App.$("#devLink");
          a.href = res.devVerificationLink;
          App.$("#devWrap").hidden = false;
        }
        App.$("#verifyMsg").textContent =
          (res && res.emailDelivered === false)
            ? "Account created. No email provider is configured on this deployment, so the verification link could not be sent — an administrator must configure RESEND_API_KEY."
            : "Account created! Check your inbox for the verification link" + (email ? " (" + email + ")" : "") + ".";
        App.toast("Account created", "Welcome to BotDock Cloud!", "ok");
      }).catch(function (err) {
        App.busy(btn, false);
        showErr(err.detail || err.message || "Registration failed.");
      });
    });
  }

  /* ── FORGOT PASSWORD ───────────────────────────────────── */
  function initForgot() {
    var form = App.$("#forgotForm");
    if (!form) return;
    App.boot({ mode: "public", page: "" });
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      showErr("");
      var email = App.$("#email").value.trim();
      if (!email) { showErr("Enter your account email."); return; }
      if (App.demo) { App.toast("Demo mode", "Password reset is simulated.", "info"); return; }
      var btn = App.$("#forgotSubmit");
      App.busy(btn, true, "Sending…");
      API.auth.forgotPassword({ email: email }).then(function (res) {
        App.busy(btn, false);
        var panel = App.$("#sentPanel");
        form.hidden = true;
        panel.hidden = false;
        if (res && res.devVerificationLink !== undefined && res.resetLink) {
          App.$("#devResetWrap").hidden = false;
          App.$("#devResetLink").href = res.resetLink;
        }
      }).catch(function (err) { App.busy(btn, false); showErr(err.detail || err.message); });
    });
  }

  /* ── RESET PASSWORD (linked from email) ────────────────── */
  function initReset() {
    var form = App.$("#resetForm");
    if (!form) return;
    App.boot({ mode: "public", page: "" });
    var token = params().get("token") || "";
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      showErr("");
      var pw = App.$("#password").value, pw2 = App.$("#password2").value;
      if (!token) { showErr("Missing reset token — use the link from your email."); return; }
      if (pw.length < 10) { showErr("Password must be at least 10 characters."); return; }
      if (pw !== pw2) { showErr("Passwords do not match."); return; }
      if (App.demo) { App.toast("Demo mode", "Reset simulated.", "info"); return; }
      API.auth.resetPassword({ token: token, password: pw }).then(function () {
        App.toast("Password updated", "You can sign in now.", "ok");
        setTimeout(function () { location.href = "/login.html"; }, 900);
      }).catch(function (err) { showErr(err.detail || err.message); });
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    initLogin();
    initRegister();
    initForgot();
    initReset();
  });
})();
