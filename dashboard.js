/* ============================================================
   BotDock Cloud — dashboard.js
   Overview (stats, recent activity) + My bots (cards, search,
   filter, pagination). Polls every 15 s while visible.
   ============================================================ */
(function () {
  "use strict";
  var App = window.BotDockApp, API = window.BotDockAPI, Demo = window.BotDockDemo;

  var state = { bots: [], plan: null, usage: null, query: "", filter: "ALL", page: 1, perPage: 9 };

  function botCard(b) {
    var href = "/bot-details.html?id=" + encodeURIComponent(b.id);
    var meta = [];
    meta.push(App.runtimeLabel(b.runtime));
    if (b.memoryMb != null && !isNaN(b.memoryMb)) meta.push("mem " + Number(b.memoryMb).toFixed(0) + " MB");
    if (b.uptimeSec != null) meta.push("up " + App.fmtUptime(b.uptimeSec));
    var status = b.runtimeStatus === "RUNTIME_OFFLINE" ? "RUNTIME_OFFLINE" : b.status;
    return '<a class="bot-card" href="' + href + '">' +
      '<div class="top"><span class="name">' + App.escapeHtml(b.name) + "</span>" + App.statusBadge(status) + "</div>" +
      (b.description ? '<p class="desc">' + App.escapeHtml(b.description) + "</p>" : "") +
      '<div class="meta"><span>' + meta.join("</span><span>") + "</span></div>" +
      '<div class="meta"><span>created ' + App.relTime(b.createdAt) + "</span>" +
      (b.sourceType ? "<span>via " + App.escapeHtml(String(b.sourceType).toLowerCase()) + "</span>" : "") + "</div></a>";
  }

  function renderBots() {
    var wrap = App.$("#botsWrap");
    if (!wrap) return;
    var q = state.query.toLowerCase();
    var list = state.bots.filter(function (b) {
      if (state.filter !== "ALL" && b.status !== state.filter) return false;
      if (q && (b.name + " " + (b.description || "")).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    var pages = Math.max(1, Math.ceil(list.length / state.perPage));
    if (state.page > pages) state.page = pages;
    var slice = list.slice((state.page - 1) * state.perPage, state.page * state.perPage);

    if (!state.bots.length) {
      App.emptyBox(wrap, "🤖", "No bots yet", "Create your first bot from a template, a ZIP archive, or a GitHub repository.",
        '<a class="btn btn-primary" href="/deploy.html">Create a bot</a>');
      return;
    }
    if (!slice.length) {
      wrap.innerHTML = '<div class="empty"><div class="big">🔍</div><h3 class="mt-0">No matches</h3><p>Adjust the search or filter.</p></div>';
      return;
    }
    wrap.innerHTML = '<div class="bot-grid">' + slice.map(botCard).join("") + "</div>";
    var pg = App.$("#botsPag");
    pg.innerHTML = pages > 1
      ? '<button class="btn btn-sm" id="pgPrev" ' + (state.page <= 1 ? "disabled" : "") + ">‹</button>" +
        "<span>Page " + state.page + " / " + pages + " · " + list.length + " bots</span>" +
        '<button class="btn btn-sm" id="pgNext" ' + (state.page >= pages ? "disabled" : "") + ">›</button>"
      : "<span>" + list.length + (list.length === 1 ? " bot" : " bots") + "</span>";
    if (App.$("#pgPrev")) App.$("#pgPrev").addEventListener("click", function () { state.page--; renderBots(); });
    if (App.$("#pgNext")) App.$("#pgNext").addEventListener("click", function () { state.page++; renderBots(); });
  }

  function renderStats(u) {
    var set = function (id, v, sub) {
      var el = App.$(id);
      if (!el) return;
      el.innerHTML = v;
      if (sub && App.$(id + "Sub")) App.$(id + "Sub").textContent = sub;
    };
    set("#stBots", u.botsTotal);
    set("#stRunning", u.botsRunning);
    set("#stStopped", u.botsStopped);
    set("#stFailed", u.botsFailed);
    set("#stDeploys", u.deploymentsToday);
    set("#stStorage", App.fmtBytes(u.storageBytes));
  }

  function renderActivity(u) {
    var el = App.$("#activityList");
    if (!el) return;
    var rows = (u.recentDeployments || []).slice(0, 6);
    if (!rows.length) { el.innerHTML = '<p class="faint">No recent activity.</p>'; return; }
    el.innerHTML = rows.map(function (d) {
      var bot = (u.bots || []).find(function (b) { return b.id === d.botId; });
      return '<div class="env-row"><span class="badge ' + (d.status === "RUNNING" ? "badge-RUNNING" : d.status === "FAILED" ? "badge-FAILED" : "") + '">' +
        App.escapeHtml(d.status) + "</span><span>" + App.escapeHtml(bot ? bot.name : d.botId) +
        ' <span class="faint">#' + d.number + "</span></span><span class=\"spacer\"></span><span class=\"faint\">" + App.relTime(d.createdAt) + "</span></div>";
    }).join("");
  }

  function renderPlanBar() {
    var el = App.$("#planBar");
    if (!el || !state.plan) return;
    var limits = state.plan.limits || {};
    el.textContent = "Plan: " + (state.plan.name || "Free") +
      (limits.maxBots != null ? " · bots " + state.bots.length + "/" + limits.maxBots : "");
  }

  function load(silent) {
    var p = App.demo ? Demo.usage() : API.platform.usage();
    return p.then(function (u) {
      state.usage = u;
      if (u.plan) state.plan = u.plan;
      state.bots = u.bots || (state.bots);
      if (!u.bots && !App.demo) {
        // usage endpoint returns only summaries; fetch full bot list for cards
        return API.bots.list().then(function (r) {
          state.bots = r.bots || [];
          if (r.plan) state.plan = r.plan;
          renderStats(u); renderActivity(u); renderBots(); renderPlanBar();
          return r;
        });
      }
      renderStats(u); renderActivity(u); renderBots(); renderPlanBar();
      return u;
    }).catch(function (err) {
      if (!silent) App.errorBox("#botsWrap", "Could not load your bots", err.detail || err.message);
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    var isBotsPage = !!App.$("#botsWrap") && document.body.dataset.page === "bots";
    App.boot({ mode: "app", page: isBotsPage ? "bots.html" : "dashboard.html" }).then(function () {
      // toolbar
      var search = App.$("#botSearch"), filter = App.$("#botFilter");
      if (search) search.addEventListener("input", function () { state.query = this.value; state.page = 1; renderBots(); });
      if (filter) filter.addEventListener("change", function () { state.filter = this.value; state.page = 1; renderBots(); });

      if (App.demo) {
        Demo.usage().then(function (u) { renderStats(u); renderActivity(u); });
        Demo.listBots().then(function (r) { state.bots = r.bots; state.plan = r.plan; renderBots(); renderPlanBar(); });
      } else {
        App.$("#botsWrap").innerHTML = '<div class="skeleton-card"></div><div class="skeleton-card"></div>';
        load(false);
        App.poller(function () { return load(true); }, 15000);
      }
    });
  });
})();
