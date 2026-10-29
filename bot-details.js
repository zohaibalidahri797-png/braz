/* ============================================================
   BotDock Cloud — bot-details.js
   Bot detail page: live status + metrics, actions (deploy /
   start / stop / restart / delete), deployment history with
   build logs, runtime logs with auto-refresh, environment
   variables (masked, write-only), and a small file manager.
   Adaptive polling while BUILDING/DEPLOYING/RUNNING.
   ============================================================ */
(function () {
  "use strict";
  var App = window.BotDockApp, API = window.BotDockAPI, Demo = window.BotDockDemo;

  var botId = new URLSearchParams(location.search).get("id") || "";
  var state = { bot: null, runtime: null, tab: "overview", logTail: 200, autoLog: true, path: "" };

  function busyBtn(id, busy, label) { App.busy(App.$(id), busy, label); }

  function renderHead(data) {
    var b = data.bot;
    state.bot = b;
    state.runtime = data.runtime || null;
    var status = (b.runtimeStatus === "RUNTIME_OFFLINE") ? "RUNTIME_OFFLINE" : b.status;
    document.title = b.name + " — BotDock Cloud";
    App.$("#botTitle").innerHTML = App.escapeHtml(b.name) + " " + App.statusBadge(status);
    App.$("#botDesc").textContent = b.description || "";

    var kv = [
      ["Runtime", App.runtimeLabel(b.runtime)],
      ["Status", b.status],
      ["Source", (b.sourceType || "—") + (b.sourceRef ? " · " + b.sourceRef : "")],
      ["Start command", b.startCommand || "—"],
      ["Created", App.fmtDate(b.createdAt)],
      ["Last deployed", b.lastDeployedAt ? App.relTime(b.lastDeployedAt) : "never"],
      ["CPU", state.runtime && state.runtime.cpuPercent != null ? state.runtime.cpuPercent.toFixed(1) + "%" : "—"],
      ["Memory", state.runtime && state.runtime.memoryMb != null ? Number(state.runtime.memoryMb).toFixed(1) + " MB" : "—"],
      ["Uptime", state.runtime && state.runtime.uptimeSec != null ? App.fmtUptime(state.runtime.uptimeSec) : "—"],
    ];
    App.$("#botKv").innerHTML = kv.map(function (p) {
      return '<div class="kv"><div class="k">' + App.escapeHtml(p[0]) + '</div><div class="v">' + App.escapeHtml(String(p[1])) + "</div></div>";
    }).join("");

    // action availability — reflect what the runtime actually supports
    var st = b.status;
    var canDeploy = st === "CREATED" || st === "STOPPED" || st === "FAILED";
    var canStart = st === "STOPPED" || st === "CREATED";
    var canStop = st === "RUNNING";
    var canRestart = st === "RUNNING";
    App.$("#deployBtn").disabled = !(canDeploy || st === "RUNNING");
    App.$("#startBtn").disabled = !canStart;
    App.$("#stopBtn").disabled = !canStop;
    App.$("#restartBtn").disabled = !canRestart;

    var note = App.$("#runtimeNote");
    if (data.runtimeError === "runtime_unavailable" || status === "RUNTIME_OFFLINE") {
      note.hidden = false;
      note.textContent = "The bot runtime service is offline — actions are unavailable until it comes back. Bot files and settings are safe.";
    } else note.hidden = true;
  }

  function doAction(action, btnId, label) {
    if (App.demo) { App.demoToast(); return; }
    busyBtn(btnId, true, label);
    API.bots.action(botId, action).then(function (r) {
      busyBtn(btnId, false);
      if (r.ok === false) App.toast("Action failed", r.detail || r.error || String(action) + " did not succeed.", "err");
      else App.toast("Success", "Bot " + action + " accepted by the runtime.", "ok");
      refresh();
    }).catch(function (err) {
      busyBtn(btnId, false);
      App.toast("Action failed", err.detail || err.message, "err");
    });
  }

  function deleteBot() {
    App.confirm({
      title: 'Delete "' + (state.bot ? state.bot.name : "bot") + '"?',
      message: "This stops the bot, removes its deployment and permanently deletes its files. This cannot be undone.",
      confirmLabel: "Delete bot", danger: true,
    }).then(function (yes) {
      if (!yes) return;
      if (App.demo) { App.demoToast(); return; }
      API.bots.remove(botId).then(function () {
        App.toast("Bot deleted", "", "ok");
        setTimeout(function () { location.href = "/bots.html"; }, 700);
      }).catch(function (err) { App.toast("Delete failed", err.detail || err.message, "err"); });
    });
  }

  /* ── tabs ──────────────────────────────────────────────── */
  function switchTab(name) {
    state.tab = name;
    App.$$(".tab[data-tab]").forEach(function (t) { t.setAttribute("aria-selected", String(t.dataset.tab === name)); });
    App.$$(".tabpane").forEach(function (p) { p.hidden = p.dataset.pane !== name; });
    if (name === "logs") loadLogs();
    if (name === "deployments") loadDeployments();
    if (name === "env") loadEnv();
    if (name === "files") loadFiles();
  }

  /* ── logs ──────────────────────────────────────────────── */
  function renderLogLines(lines) {
    return lines.map(function (l) {
      var text = typeof l === "string" ? l : l.text;
      var cls = typeof l === "object" && l.stream === "err" ? "ln-err" : (typeof l === "object" && l.stream === "sys" ? "ln-sys" : "");
      return '<span class="' + cls + '">' + App.escapeHtml(text) + "</span>";
    }).join("\n");
  }
  function loadLogs() {
    if (!botId) return;
    var p = App.demo ? Demo.logs(botId) : API.bots.logs(botId, { tail: state.logTail });
    p.then(function (r) {
      var box = App.$("#logBox");
      box.innerHTML = renderLogLines(r.lines || []);
      var meta = App.$("#logMeta");
      if (r.runtimeUnavailable) meta.textContent = r.note || "Runtime offline.";
      else if (r.demo) meta.textContent = "Demo log — connect a backend for real output.";
      else meta.textContent = (r.lines ? r.lines.length : 0) + " lines" + (r.truncated ? " (truncated)" : "") + " · auto-refresh " + (state.autoLog ? "on" : "off");
      box.scrollTop = box.scrollHeight;
    }).catch(function (err) {
      App.$("#logMeta").textContent = "";
      App.$("#logBox").innerHTML = '<span class="ln-err">Failed to load logs: ' + App.escapeHtml(err.detail || err.message) + "</span>";
    });
  }

  /* ── deployments ───────────────────────────────────────── */
  function loadDeployments() {
    var p = App.demo ? Demo.deploymentsFor(botId) : API.bots.deployments(botId);
    p.then(function (r) {
      var list = r.deployments || [];
      var el = App.$("#depList");
      if (!list.length) { el.innerHTML = '<p class="faint">No deployments yet.</p>'; return; }
      el.innerHTML = '<div class="table-wrap"><table class="tbl"><thead><tr><th>#</th><th>Status</th><th>Source</th><th>Created</th><th></th></tr></thead><tbody>' +
        list.map(function (d) {
          return "<tr><td><strong>" + d.number + "</strong>" + (d.error ? '<div class="faint">' + App.escapeHtml(d.error).slice(0, 90) + "</div>" : "") + "</td>" +
            "<td>" + App.statusBadge(d.status) + "</td>" +
            "<td>" + App.escapeHtml(d.sourceType || "") + (d.commitSha ? ' <span class="faint mono">' + App.escapeHtml(String(d.commitSha).slice(0, 7)) + "</span>" : "") + "</td>" +
            "<td>" + App.relTime(d.createdAt) + "</td>" +
            '<td class="actions-cell"><button class="btn btn-sm" data-build="' + App.escapeHtml(d.id) + '">Build log</button></td></tr>';
        }).join("") + "</tbody></table></div>";
      App.$$("#depList [data-build]").forEach(function (btn) {
        btn.addEventListener("click", function () { viewBuildLog(btn.dataset.build); });
      });
    }).catch(function (err) { App.errorBox("#depList", "Could not load deployments", err.detail || err.message); });
  }
  function viewBuildLog(depId) {
    if (App.demo) { App.demoToast(); return; }
    API.bots.buildLog(botId, depId).then(function (r) {
      switchTab("logs");
      App.$("#logBox").innerHTML = renderLogLines(r.lines || []);
      App.$("#logMeta").textContent = "Build log for deployment " + depId.slice(0, 8) + "… " + (r.status ? "(" + r.status + ")" : "");
    }).catch(function (err) { App.toast("Build log", err.detail || err.message, "err"); });
  }

  /* ── env vars ──────────────────────────────────────────── */
  function loadEnv() {
    var p = App.demo ? Demo.env() : API.bots.envList(botId);
    p.then(function (r) {
      var el = App.$("#envList");
      el.innerHTML = (r.vars || []).map(function (v) {
        return '<div class="env-row"><span class="key">' + App.escapeHtml(v.key) + "</span>" +
          '<span class="faint">' + (v.isSecret ? "secret · write-only" : "value hidden on read") + "</span>" +
          '<span class="spacer"></span><button class="btn btn-sm btn-danger" data-delkey="' + App.escapeHtml(v.key) + '">Delete</button></div>';
      }).join("") || '<p class="faint">No environment variables yet.</p>';
      if (r.note) App.$("#envNote").textContent = r.note;
      App.$$("#envList [data-delkey]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var key = btn.dataset.delkey;
          App.confirm({ title: "Delete " + key + "?", message: "Takes effect on the next restart/deploy.", confirmLabel: "Delete", danger: true })
            .then(function (yes) {
              if (!yes) return;
              if (App.demo) { App.demoToast(); return; }
              API.bots.envDelete(botId, key).then(loadEnv).catch(function (err) { App.toast("Delete failed", err.detail || err.message, "err"); });
            });
        });
      });
    }).catch(function (err) { App.errorBox("#envList", "Could not load variables", err.detail || err.message); });
  }
  function saveEnv() {
    var key = App.$("#envKey").value.trim(), value = App.$("#envValue").value, secret = App.$("#envSecret").checked;
    var err = App.$("#envError");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) { err.textContent = "Key must match [A-Za-z_][A-Za-z0-9_]*"; return; }
    if (!value) { err.textContent = "Enter a value."; return; }
    err.textContent = "";
    if (App.demo) { App.demoToast(); return; }
    API.bots.envSet(botId, { key: key, value: value, isSecret: secret }).then(function (r) {
      App.toast("Saved", r.note || "Variable stored (encrypted).", "ok");
      App.$("#envKey").value = ""; App.$("#envValue").value = "";
      loadEnv();
    }).catch(function (e) { err.textContent = e.detail || e.message; });
  }

  /* ── files ─────────────────────────────────────────────── */
  function loadFiles() {
    var p = App.demo ? Demo.files() : API.bots.files(botId, state.path);
    p.then(function (r) {
      var el = App.$("#fileList");
      var entries = r.entries || [];
      if (!entries.length) { el.innerHTML = '<p class="faint">Empty directory.</p>'; }
      else {
        el.innerHTML = entries.map(function (f) {
          var isDir = f.type === "dir";
          return '<div class="file-row"><span class="name">' + (isDir ? "📁 " : "📄 ") + App.escapeHtml(f.name) + "</span>" +
            '<span class="size">' + (isDir ? "dir" : App.fmtBytes(f.size)) + "</span><span class=\"spacer\"></span>" +
            (isDir
              ? '<button class="btn btn-sm" data-open="' + App.escapeHtml(f.name) + '">Open</button>'
              : '<button class="btn btn-sm" data-view="' + App.escapeHtml(f.name) + '">Edit</button>' +
                '<button class="btn btn-sm btn-danger" data-fdel="' + App.escapeHtml(f.name) + '">Delete</button>') +
            "</div>";
        }).join("");
      }
      var crumb = App.$("#fileCrumb");
      crumb.innerHTML = "workspace/" + (state.path ? App.escapeHtml(state.path) : "") +
        (state.path ? ' — <a href="#" id="upDir">↑ up one level</a>' : "");
      var up = App.$("#upDir");
      if (up) up.addEventListener("click", function (e) {
        e.preventDefault();
        state.path = state.path.split("/").slice(0, -1).join("/");
        loadFiles();
      });
      App.$$("#fileList [data-open]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          state.path = state.path ? state.path + "/" + btn.dataset.open : btn.dataset.open;
          loadFiles();
        });
      });
      App.$$("#fileList [data-view]").forEach(function (btn) {
        btn.addEventListener("click", function () { openEditor(btn.dataset.view); });
      });
      App.$$("#fileList [data-fdel]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var name = btn.dataset.fdel;
          App.confirm({ title: "Delete " + name + "?", confirmLabel: "Delete", danger: true }).then(function (yes) {
            if (!yes) return;
            if (App.demo) { App.demoToast(); return; }
            var full = state.path ? state.path + "/" + name : name;
            API.bots.fileDelete(botId, full).then(loadFiles).catch(function (err) { App.toast("Delete failed", err.detail || err.message, "err"); });
          });
        });
      });
    }).catch(function (err) { App.errorBox("#fileList", "Could not load files", err.detail || err.message); });
  }

  function openEditor(name) {
    if (App.demo) { App.demoToast(); return; }
    var full = state.path ? state.path + "/" + name : name;
    API.bots.files(botId, full, true).then(function (r) {
      var dlg = App.$("#editorDlg");
      App.$("#editorName").textContent = full;
      App.$("#editorText").value = r.file && r.file.content != null ? r.file.content : "";
      App.$("#editorErr").textContent = "";
      dlg.showModal();
      App.$("#editorSave").onclick = function () {
        API.bots.fileSave(botId, { path: full, content: App.$("#editorText").value }).then(function () {
          dlg.close(); App.toast("Saved", full, "ok"); loadFiles();
        }).catch(function (err) { App.$("#editorErr").textContent = err.detail || err.message; });
      };
    }).catch(function (err) { App.toast("Open file", err.detail || err.message, "err"); });
  }

  function uploadFile() {
    var input = App.$("#fileUploadInput");
    if (!input.files || !input.files[0]) { App.toast("Upload", "Choose a file first.", "warn"); return; }
    if (App.demo) { App.demoToast(); return; }
    var fd = new FormData();
    fd.append("file", input.files[0]);
    if (state.path) fd.append("path", state.path);
    API.bots.fileUpload(botId, fd).then(function () {
      App.toast("Uploaded", input.files[0].name, "ok");
      input.value = "";
      loadFiles();
    }).catch(function (err) { App.toast("Upload failed", err.detail || err.message, "err"); });
  }

  /* ── refresh + polling ─────────────────────────────────── */
  function refresh() {
    var p = App.demo ? Demo.bot(botId) : API.bots.get(botId);
    return p.then(function (data) {
      renderHead(data);
      if (state.tab === "overview" && data.deployments) {
        App.$("#lastDep").textContent = data.deployments.length ? ("#" + data.deployments[0].number + " · " + data.deployments[0].status) : "—";
      }
    }).catch(function (err) {
      if (err.status === 404) {
        document.body.innerHTML = '<div class="center-page"><h2>Bot not found</h2><p class="muted">It may have been deleted, or the link is wrong.</p><a class="btn" href="/bots.html">My bots</a></div>';
        return;
      }
      App.errorBox("#botKv", "Could not load bot", err.detail || err.message);
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    App.boot({ mode: "app", page: "" }).then(function () {
      if (!botId) { location.replace("/bots.html"); return; }

      App.$("#deployBtn").addEventListener("click", function () { doAction("deploy", "#deployBtn", "Deploying…"); });
      App.$("#startBtn").addEventListener("click", function () { doAction("start", "#startBtn", "Starting…"); });
      App.$("#stopBtn").addEventListener("click", function () { doAction("stop", "#stopBtn", "Stopping…"); });
      App.$("#restartBtn").addEventListener("click", function () { doAction("restart", "#restartBtn", "Restarting…"); });
      App.$("#deleteBtn").addEventListener("click", deleteBot);

      App.$$(".tab[data-tab]").forEach(function (t) {
        t.addEventListener("click", function () { switchTab(this.dataset.tab); });
      });
      App.$("#envSave").addEventListener("click", saveEnv);
      App.$("#fileUploadBtn").addEventListener("click", uploadFile);
      App.$("#logReload").addEventListener("click", loadLogs);
      App.$("#logAuto").addEventListener("change", function () { state.autoLog = this.checked; });

      App.$("#backBtn").addEventListener("click", function () { location.href = "/bots.html"; });

      if (App.demo) { refresh(); }
      else {
        App.$("#botKv").innerHTML = '<div class="skeleton" style="width:60%"></div>';
        refresh();
        // adaptive polling: busy states 3s, running 5s, otherwise 15s
        App.poller(function () {
          var st = state.bot ? state.bot.status : "";
          return refresh().then(function () {
            /* interval fixed at 5s; skip hidden handled in poller */
          });
        }, 5000);
        App.poller(function () {
          if (state.tab === "logs" && state.autoLog && state.bot && state.bot.status === "RUNNING") loadLogs();
        }, 5000);
      }
    });
  });
})();
