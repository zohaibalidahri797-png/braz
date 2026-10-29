/* ============================================================
   BotDock Cloud — api.js
   API client for the static frontend.

   · Base URL is configurable (Settings → Backend connection, or
     localStorage key "botdock_api_base"). Default is "" which
     means SAME-ORIGIN — the recommended setup (Cloudflare Pages
     _redirects proxy, or the backend Worker also serving these
     static files). Same-origin keeps session cookies working
     without any CORS changes.
   · Session auth uses the backend's httpOnly cookie — no tokens
     are ever stored in JavaScript or localStorage.
   · If the backend is unreachable, callers fall back to clearly
     labeled DEMO mode (see demo.js). Demo mode NEVER presents
     simulated deployments as real ones.
   ============================================================ */
(function () {
  "use strict";

  var LS_KEY = "botdock_api_base";

  function apiBase() {
    try {
      var v = window.BOTDOCK_API_BASE || localStorage.getItem(LS_KEY) || "";
      return String(v).replace(/\/+$/, "");
    } catch (e) {
      return "";
    }
  }

  function setApiBase(url) {
    try {
      if (url && url.trim()) localStorage.setItem(LS_KEY, url.trim().replace(/\/+$/, ""));
      else localStorage.removeItem(LS_KEY);
    } catch (e) { /* storage unavailable */ }
  }

  /** Thrown for every non-2xx (and network) failure. */
  function ApiError(status, code, detail, extra) {
    var err = new Error(detail || code || ("HTTP " + status));
    err.name = "ApiError";
    err.status = status;
    err.code = code || "";
    err.detail = detail || "";
    if (extra) Object.assign(err, extra);
    return err;
  }

  /**
   * request(method, path, body?, opts?)
   *  - JSON by default; pass opts.formData for multipart uploads.
   *  - opts.raw → resolve with the raw Response.
   *  - 401 handling is left to callers (app.js guards pages).
   */
  function request(method, path, body, opts) {
    opts = opts || {};
    var headers = {};
    var payload;
    if (opts.formData) {
      payload = opts.formData; // browser sets multipart boundary
    } else if (body !== undefined && body !== null) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    return fetch(apiBase() + path, {
      method: method,
      headers: headers,
      credentials: "include",
      body: payload,
    }).then(function (res) {
      if (opts.raw) return res;
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!res.ok) {
          throw ApiError(
            res.status,
            data && data.error,
            data && (data.detail || data.error),
            data || {}
          );
        }
        return data;
      });
    }, function (networkErr) {
      throw ApiError(0, "network_error", "Could not reach the backend" + (apiBase() ? " (" + apiBase() + ")" : "") + ". " + networkErr.message);
    });
  }

  var API = {
    apiBase: apiBase,
    setApiBase: setApiBase,
    ApiError: ApiError,
    get: function (p, opts) { return request("GET", p, null, opts); },
    post: function (p, body, opts) { return request("POST", p, body === undefined ? {} : body, opts); },
    put: function (p, body, opts) { return request("PUT", p, body, opts); },
    patch: function (p, body, opts) { return request("PATCH", p, body, opts); },
    del: function (p, opts) { return request("DELETE", p, null, opts); },
    uploadForm: function (p, formData) { return request("POST", p, null, { formData: formData }); },

    /** True when the backend answers /api/health. Cached per page load. */
    _backendPromise: null,
    backendAvailable: function () {
      if (!API._backendPromise) {
        API._backendPromise = new Promise(function (resolve) {
          var done = false;
          var finish = function (ok) { if (!done) { done = true; resolve(ok); } };
          var timer = setTimeout(function () { finish(false); }, 3500);
          try {
            fetch(apiBase() + "/api/health", { credentials: "include" })
              .then(function (r) { clearTimeout(timer); finish(r.ok); })
              .catch(function () { clearTimeout(timer); finish(false); });
          } catch (e) { clearTimeout(timer); finish(false); }
        });
      }
      return API._backendPromise;
    },

    /* ── Documented API surface (see docs/API-SPEC.md) ── */
    auth: {
      register: function (b) { return API.post("/api/auth/register", b); },
      login: function (b) { return API.post("/api/auth/login", b); },
      logout: function () { return API.post("/api/auth/logout"); },
      me: function () { return API.get("/api/auth/me"); },
      config: function () { return API.get("/api/auth/config"); },
      sessions: function () { return API.get("/api/auth/sessions"); },
      revokeSession: function (id) { return API.del("/api/auth/sessions?id=" + encodeURIComponent(id)); },
      revokeAllSessions: function () { return API.post("/api/auth/sessions", { all: true }); },
      forgotPassword: function (b) { return API.post("/api/auth/forgot-password", b); },
      resetPassword: function (b) { return API.post("/api/auth/reset-password", b); },
      resendVerification: function () { return API.post("/api/auth/resend-verification"); },
      changePassword: function (b) { return API.post("/api/settings/password", b); },
      updateProfile: function (b) { return API.patch("/api/settings/profile", b); },
    },
    bots: {
      list: function () { return API.get("/api/bots"); },
      createFromTemplate: function (b) { return API.post("/api/bots", b); },
      get: function (id) { return API.get("/api/bots/" + encodeURIComponent(id)); },
      update: function (id, b) { return API.patch("/api/bots/" + encodeURIComponent(id), b); },
      remove: function (id) { return API.del("/api/bots/" + encodeURIComponent(id)); },
      // Documented contract routes (thin aliases over the action endpoint):
      deploy: function (id) { return API.post("/api/bots/" + encodeURIComponent(id) + "/deploy"); },
      start: function (id) { return API.post("/api/bots/" + encodeURIComponent(id) + "/start"); },
      stop: function (id) { return API.post("/api/bots/" + encodeURIComponent(id) + "/stop"); },
      restart: function (id) { return API.post("/api/bots/" + encodeURIComponent(id) + "/restart"); },
      // Generic action endpoint (also documented):
      action: function (id, action) { return API.post("/api/bots/" + encodeURIComponent(id) + "/action", { action: action }); },
      logs: function (id, opts) {
        opts = opts || {};
        var q = "?tail=" + (opts.tail || 200);
        if (opts.buildId) q += "&build=" + encodeURIComponent(opts.buildId);
        return API.get("/api/bots/" + encodeURIComponent(id) + "/logs" + q);
      },
      deployments: function (id) { return API.get("/api/bots/" + encodeURIComponent(id) + "/deployments"); },
      buildLog: function (id, depId) { return API.logs(id, { buildId: depId, tail: 400 }); },
      envList: function (id) { return API.get("/api/bots/" + encodeURIComponent(id) + "/env"); },
      envSet: function (id, b) { return API.put("/api/bots/" + encodeURIComponent(id) + "/env", b); },
      envDelete: function (id, key) { return API.del("/api/bots/" + encodeURIComponent(id) + "/env?key=" + encodeURIComponent(key)); },
      files: function (id, path, read) {
        var q = path ? "?path=" + encodeURIComponent(path) : "";
        if (read) q += (q ? "&" : "?") + "read=1";
        return API.get("/api/bots/" + encodeURIComponent(id) + "/files" + q);
      },
      fileSave: function (id, b) { return API.put("/api/bots/" + encodeURIComponent(id) + "/files", b); },
      fileDelete: function (id, path) { return API.del("/api/bots/" + encodeURIComponent(id) + "/files?path=" + encodeURIComponent(path)); },
      fileUpload: function (id, formData) { return API.uploadForm("/api/bots/" + encodeURIComponent(id) + "/files/upload", formData); },
      uploadProject: function (formData, onProgress) {
        // XHR for upload progress events (fetch cannot report upload %).
        return new Promise(function (resolve, reject) {
          var xhr = new XMLHttpRequest();
          xhr.open("POST", apiBase() + "/api/bots/upload");
          xhr.withCredentials = true;
          xhr.onload = function () {
            var data = null;
            try { data = JSON.parse(xhr.responseText); } catch (e) { /* ignore */ }
            if (xhr.status >= 200 && xhr.status < 300) resolve(data);
            else reject(ApiError(xhr.status, data && data.error, data && (data.detail || data.error), data || {}));
          };
          xhr.onerror = function () { reject(ApiError(0, "network_error", "Upload failed — could not reach the backend.")); };
          if (onProgress && xhr.upload) {
            xhr.upload.onprogress = function (ev) {
              if (ev.lengthComputable) onProgress(Math.round((ev.loaded / ev.total) * 100));
            };
          }
          xhr.send(formData);
        });
      },
    },
    github: {
      status: function () { return API.get("/api/github/token"); },
      saveToken: function (b) { return API.put("/api/github/token", b); },
      removeToken: function () { return API.del("/api/github/token"); },
      repos: function () { return API.get("/api/github/repos"); },
      branches: function (repo) { return API.get("/api/github/branches?repo=" + encodeURIComponent(repo)); },
      import: function (b) { return API.post("/api/github/import", b); },
    },
    platform: {
      health: function () { return API.get("/api/health"); },
      plans: function () { return API.get("/api/plans"); },
      usage: function () { return API.get("/api/usage"); },
      templates: function () { return API.get("/api/templates"); },
      deployments: function () { return API.get("/api/deployments"); },
      subscription: function () { return API.get("/api/subscription"); },
      upgrade: function (b) { return API.post("/api/subscription", b); },
      notifications: function () { return API.get("/api/notifications"); },
      markNotifications: function (b) { return API.post("/api/notifications", b); },
    },
    admin: {
      stats: function () { return API.get("/api/admin/stats"); },
      users: function (q, page) { return API.get("/api/admin/users?q=" + encodeURIComponent(q || "") + "&page=" + (page || 1)); },
      updateUser: function (id, b) { return API.patch("/api/admin/users/" + encodeURIComponent(id), b); },
      audit: function (page) { return API.get("/api/admin/audit?page=" + (page || 1)); },
      plans: function () { return API.get("/api/admin/plans"); },
      settings: function () { return API.get("/api/admin/settings"); },
      deployments: function () { return API.get("/api/admin/deployments"); },
    },
  };

  window.BotDockAPI = API;
})();
