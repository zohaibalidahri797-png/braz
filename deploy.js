/* ============================================================
   BotDock Cloud — deploy.js
   "New bot" page: three sources — Template, ZIP/TAR.GZ archive,
   GitHub repository. Every path calls the real backend; without
   a backend the page stays in clearly-labeled demo mode.
   ============================================================ */
(function () {
  "use strict";
  var App = window.BotDockApp, API = window.BotDockAPI, Demo = window.BotDockDemo;

  var state = { tab: "template", templates: [], runtime: "PYTHON", selectedTemplate: "", selectedFile: null, repo: "", branch: "", repos: [] };

  function showErr(m) { var el = App.$("#deployError"); if (el) el.textContent = m || ""; }

  function renderTemplates() {
    var sel = App.$("#templateSel");
    if (!sel) return;
    var list = state.templates.filter(function (t) { return t.runtime === state.runtime; });
    sel.innerHTML = list.length
      ? list.map(function (t) { return '<option value="' + App.escapeHtml(t.id) + '">' + App.escapeHtml(t.name) + "</option>"; }).join("")
      : '<option value="">No template for this runtime</option>';
    if (list.length) state.selectedTemplate = list[0].id;
    var info = App.$("#templateInfo");
    if (info) {
      var t = list.find(function (x) { return x.id === state.selectedTemplate; });
      info.textContent = t ? t.description : "";
    }
  }

  function pickFile(file) {
    state.selectedFile = file;
    var el = App.$("#fileLabel");
    if (el) el.textContent = file ? file.name + " · " + App.fmtBytes(file.size) : "";
    var okType = /\.(zip|tar|tgz|tar\.gz|jar)$/i.test(file ? file.name : "");
    var btn = App.$("#uploadBtn");
    if (btn) btn.disabled = !(file && okType);
    showErr(file && !okType ? "Unsupported file type — use .zip, .tar.gz, .tgz or .tar (max 20 MB)." : "");
  }

  function loadRepos() {
    var wrap = App.$("#repoList");
    if (!wrap) return;
    wrap.innerHTML = '<div class="row"><span class="spinner sm"></span> Loading repositories…</div>';
    API.github.repos().then(function (r) {
      state.repos = r.repos || [];
      if (!state.repos.length) { wrap.innerHTML = '<p class="faint">No repositories found for this token.</p>'; return; }
      wrap.innerHTML = state.repos.map(function (repo) {
        return '<div class="file-row"><span class="name">' + App.escapeHtml(repo.fullName || repo.name) + "</span><span class=\"spacer\"></span>" +
          '<button class="btn btn-sm" data-repo="' + App.escapeHtml(repo.fullName || repo.name) + '">Select</button></div>';
      }).join("");
      App.$$("#repoList [data-repo]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          state.repo = btn.dataset.repo;
          App.$("#repoInput").value = state.repo;
          loadBranches();
        });
      });
    }).catch(function (err) {
      if (err.code === "no_github_token") {
        wrap.innerHTML = '<div class="note info"><span class="n-icon">ⓘ</span><div>' +
          "A GitHub token is required for repository import. Add one in <a href=\"/settings.html\">Settings → GitHub</a> " +
          "with the <strong>repo</strong> scope (fine-grained tokens need <strong>Contents: read</strong>). The token is stored encrypted on the server and never shown again.</div></div>";
      } else {
        App.errorBox(wrap, "Could not list repositories", err.detail || err.message);
      }
    });
  }

  function loadBranches() {
    var sel = App.$("#branchSel");
    if (!sel || !state.repo) return;
    sel.innerHTML = '<option value="">Loading…</option>';
    API.github.branches(state.repo).then(function (r) {
      var branches = r.branches || ["main"];
      sel.innerHTML = branches.map(function (b) { return '<option value="' + App.escapeHtml(b) + '">' + App.escapeHtml(b) + "</option>"; }).join("");
      state.branch = sel.value;
    }).catch(function () {
      sel.innerHTML = '<option value="main">main</option>';
      state.branch = "main";
    });
  }

  function createFromTemplate() {
    var name = App.$("#botName").value.trim();
    if (!name) { showErr("Give your bot a name."); return; }
    var body = {
      name: name,
      runtime: state.runtime,
      sourceType: "TEMPLATE",
      templateId: state.selectedTemplate,
      description: (App.$("#botDesc").value || "").trim(),
      startCommand: (App.$("#startCmd").value || "").trim(),
    };
    return API.bots.createFromTemplate(body).then(function (res) {
      return res.bot.id;
    });
  }

  function createFromUpload() {
    if (!state.selectedFile) { showErr("Choose a .zip or .tar.gz archive first."); return Promise.reject(new Error("no file")); }
    var name = App.$("#uploadName").value.trim();
    var fd = new FormData();
    fd.append("file", state.selectedFile);
    fd.append("name", name || state.selectedFile.name.replace(/\.(zip|tar|tgz|tar\.gz)$/i, ""));
    fd.append("runtime", App.$("#uploadRuntime").value);
    var desc = (App.$("#uploadDesc").value || "").trim();
    if (desc) fd.append("description", desc);
    var cmd = (App.$("#uploadStart").value || "").trim();
    if (cmd) fd.append("startCommand", cmd);
    var prog = App.$("#uploadProgress"), bar = prog ? prog.querySelector("div") : null;
    if (prog) prog.parentElement.hidden = false;
    return API.bots.uploadProject(fd, function (pct) {
      if (bar) bar.style.width = pct + "%";
      var lbl = App.$("#uploadPct"); if (lbl) lbl.textContent = pct + "%";
    }).then(function (res) {
      return res.bot.id;
    });
  }

  function createFromGithub() {
    var name = App.$("#ghName").value.trim();
    var repo = (App.$("#repoInput").value || "").trim();
    if (!name) { showErr("Give your bot a name."); return Promise.reject(new Error("no name")); }
    if (!repo) { showErr("Select or enter owner/repository."); return Promise.reject(new Error("no repo")); }
    var body = {
      name: name,
      repo: repo,
      branch: state.branch || "main",
      runtime: App.$("#ghRuntime").value,
      description: (App.$("#ghDesc").value || "").trim(),
    };
    return API.github.import(body).then(function (res) { return res.bot.id; });
  }

  function goDeploy(botId) {
    var btn = App.$(state.tab === "template" ? "#templateBtn" : state.tab === "upload" ? "#uploadBtn" : "#ghBtn");
    App.busy(btn, true, "Deploying…");
    return API.bots.deploy(botId).then(function (r) {
      if (r && r.ok === false) {
        App.toast("Deploy failed", r.detail || r.error || "The runtime reported an error.", "err");
        location.href = "/bot-details.html?id=" + encodeURIComponent(botId);
        return;
      }
      App.toast("Deploy started", "Building your bot — this can take a minute.", "ok");
      location.href = "/bot-details.html?id=" + encodeURIComponent(botId);
    }).catch(function (err) {
      App.busy(btn, false);
      showErr(err.detail || err.message);
    });
  }

  function createAndDeploy() {
    showErr("");
    if (App.demo) { App.demoToast(); return; }
    var p;
    try {
      if (state.tab === "template") p = createFromTemplate();
      else if (state.tab === "upload") p = createFromUpload();
      else p = createFromGithub();
    } catch (e) { return; }
    if (!p) return;
    p.then(function (botId) {
      App.toast("Bot created", "Starting deployment…", "ok");
      return goDeploy(botId);
    }).catch(function (err) {
      showErr(err.detail || err.message || "Creation failed.");
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    App.boot({ mode: "app", page: "deploy.html" }).then(function () {
      // tabs
      App.$$(".tab[data-tab]").forEach(function (t) {
        t.addEventListener("click", function () {
          state.tab = this.dataset.tab;
          App.$$(".tab[data-tab]").forEach(function (x) { x.setAttribute("aria-selected", String(x === t)); });
          App.$$(".tabpane").forEach(function (p) { p.hidden = p.dataset.pane !== state.tab; });
          showErr("");
        });
      });
      // runtime selects
      ["#runtimeSel", "#uploadRuntime", "#ghRuntime"].forEach(function (sel) {
        var el = App.$(sel);
        if (el) el.addEventListener("change", function () {
          if (sel === "#runtimeSel") { state.runtime = this.value; renderTemplates(); }
        });
      });
      // dropzone
      var dz = App.$("#dropzone"), fileInput = App.$("#fileInput");
      if (dz && fileInput) {
        dz.addEventListener("click", function () { fileInput.click(); });
        dz.addEventListener("dragover", function (e) { e.preventDefault(); dz.classList.add("drag"); });
        dz.addEventListener("dragleave", function () { dz.classList.remove("drag"); });
        dz.addEventListener("drop", function (e) {
          e.preventDefault(); dz.classList.remove("drag");
          if (e.dataTransfer.files && e.dataTransfer.files[0]) pickFile(e.dataTransfer.files[0]);
        });
        fileInput.addEventListener("change", function () { pickFile(this.files[0]); });
      }
      // submit buttons
      ["#templateBtn", "#uploadBtn", "#ghBtn"].forEach(function (id) {
        var b = App.$(id);
        if (b) b.addEventListener("click", createAndDeploy);
      });
      // load templates
      var tp = App.demo ? Promise.resolve({ templates: Demo.templates }) : API.platform.templates();
      tp.then(function (r) {
        state.templates = r.templates || [];
        renderTemplates();
      }).catch(function () { /* template list optional */ });

      // GitHub tab lazy-load
      var ghTab = App.$('[data-tab="github"]');
      if (ghTab) ghTab.addEventListener("click", function () { if (!App.demo) loadRepos(); else App.$("#repoList").innerHTML = '<div class="note info"><span class="n-icon">ⓘ</span><div>Demo mode — repository import needs a real backend and a GitHub token.</div></div>'; });

      // preselect template from ?template=
      var pre = new URLSearchParams(location.search).get("template");
      if (pre) {
        var found = state.templates.find(function (t) { return t.id === pre; });
        if (found) { state.runtime = found.runtime; var rs = App.$("#runtimeSel"); if (rs) rs.value = found.runtime; renderTemplates(); }
      }
    });
  });
})();
