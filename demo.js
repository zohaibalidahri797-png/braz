/* ============================================================
   BotDock Cloud — demo.js
   Clearly-labeled DEMO data used ONLY when no backend answers.
   Nothing here represents a real deployment; every mutating
   action shows a "Demo mode" notice instead of pretending.
   Demo state lives in memory only and resets on reload.
   ============================================================ */
(function () {
  "use strict";

  var now = Date.now();
  function ago(min) { return new Date(now - min * 60000).toISOString(); }

  var bots = [
    {
      id: "demo-1", name: "reminder-bot", description: "Sends daily Telegram reminders to a small group chat.",
      runtime: "PYTHON", status: "RUNNING", runtimeStatus: "RUNNING", runtimeReachable: true,
      memoryMb: 16.4, uptimeSec: 3 * 3600 + 812, sourceType: "TEMPLATE", sourceRef: "python-keepalive",
      createdAt: ago(2 * 24 * 60), lastDeployedAt: ago(186),
      demoDetection: "requirements.txt · main.py", demoRegion: "demo (no region)",
    },
    {
      id: "demo-2", name: "price-watcher", description: "Watches product pages and posts price drops to a channel.",
      runtime: "NODE", status: "RUNNING", runtimeStatus: "RUNNING", runtimeReachable: true,
      memoryMb: 28.1, uptimeSec: 44 * 60 + 7, sourceType: "GITHUB", sourceRef: "acme/price-watcher",
      createdAt: ago(5 * 24 * 60), lastDeployedAt: ago(45),
      demoDetection: "package.json · index.js", demoRegion: "demo (no region)",
    },
    {
      id: "demo-3", name: "quiz-bot", description: "Interactive quiz bot with leaderboards (work in progress).",
      runtime: "PYTHON", status: "FAILED", runtimeStatus: null, runtimeReachable: false,
      memoryMb: null, uptimeSec: null, sourceType: "UPLOAD", sourceRef: "quiz-bot.zip",
      createdAt: ago(26 * 60), lastDeployedAt: ago(12),
      demoDetection: "requirements.txt · bot.py", demoRegion: "demo (no region)",
    },
    {
      id: "demo-4", name: "echo-test", description: "Minimal echo bot used for quick runtime checks.",
      runtime: "BUN", status: "STOPPED", runtimeStatus: "STOPPED", runtimeReachable: true,
      memoryMb: null, uptimeSec: null, sourceType: "TEMPLATE", sourceRef: "bun-echo",
      createdAt: ago(9 * 24 * 60), lastDeployedAt: ago(3 * 24 * 60),
      demoDetection: "package.json · bot.js", demoRegion: "demo (no region)",
    },
  ];

  var deployments = [
    { id: "d-1", botId: "demo-2", number: 12, status: "RUNNING", sourceType: "GITHUB", sourceRef: "acme/price-watcher", commitSha: "f3c9a12", commitMessage: "Fix selector for new layout", createdAt: ago(45), startedAt: ago(45), finishedAt: ago(44) },
    { id: "d-2", botId: "demo-3", number: 4, status: "FAILED", sourceType: "UPLOAD", sourceRef: "quiz-bot.zip", error: "requirements.txt references an unreachable index", createdAt: ago(12), startedAt: ago(12), finishedAt: ago(11) },
    { id: "d-3", botId: "demo-1", number: 7, status: "RUNNING", sourceType: "TEMPLATE", sourceRef: "python-keepalive", createdAt: ago(186), startedAt: ago(186), finishedAt: ago(184) },
  ];

  var DEMO = (window.BotDockDemo = {
    enabled: true,
    plans: [
      { id: "free", name: "Free", description: "Everything you need to run your first bots.", priceMonthly: 0, priceYearly: 0, isActive: true, paymentProvider: "none", freeOnly: true,
        limits: { maxBots: 3, storageMbPerBot: 50, deploysPerDay: 20, logTailLines: 200, runtimes: ["PYTHON", "NODE", "BUN"] },
        features: ["3 bots", "50 MB storage per bot", "20 deployments / day", "Community support"] },
      { id: "starter", name: "Starter", description: "For growing bot collections.", priceMonthly: 5, priceYearly: 50, isActive: true,
        limits: { maxBots: 10, storageMbPerBot: 250, deploysPerDay: 60, logTailLines: 500, runtimes: ["PYTHON", "NODE", "BUN"] },
        features: ["10 bots", "250 MB storage per bot", "60 deployments / day", "Longer log retention"] },
      { id: "pro", name: "Pro", description: "For serious operators.", priceMonthly: 15, priceYearly: 150, isActive: true,
        limits: { maxBots: 40, storageMbPerBot: 1024, deploysPerDay: 240, logTailLines: 1000, runtimes: ["PYTHON", "NODE", "BUN"] },
        features: ["40 bots", "1 GB storage per bot", "240 deployments / day", "Priority log retention"] },
      { id: "custom", name: "Custom", description: "Tailored limits for fleets.", priceMonthly: null, priceYearly: null, isActive: true,
        limits: { maxBots: "custom", storageMbPerBot: "custom", deploysPerDay: "custom", logTailLines: "custom", runtimes: ["PYTHON", "NODE", "BUN"] },
        features: ["Custom bot count & storage", "Dedicated runtime options", "Talk to us"] },
    ],

    templates: [
      { id: "python-keepalive", name: "Python keep-alive bot (stdlib)", runtime: "PYTHON", description: "Long-polling echo bot using only the Python standard library — perfect first deploy." },
      { id: "node-echo", name: "Node.js echo bot", runtime: "NODE", description: "Minimal Telegraf-style echo bot scaffold." },
      { id: "bun-echo", name: "Bun echo bot", runtime: "BUN", description: "Ultra-light Bun bot scaffold." },
    ],

    listBots: function () {
      return Promise.resolve({
        demo: true,
        bots: bots.map(function (b) { return Object.assign({}, b); }),
        plan: { id: "free", name: "Free (demo)", limits: { maxBots: 3 } },
        usage: { botsUsed: bots.length },
        runtimeReachable: true,
        runtimeNote: null,
      });
    },

    usage: function () {
      var counts = {};
      bots.forEach(function (b) { counts[b.status] = (counts[b.status] || 0) + 1; });
      return Promise.resolve({
        demo: true,
        botsTotal: bots.length,
        botsRunning: counts.RUNNING || 0,
        botsStopped: (counts.STOPPED || 0) + (counts.CREATED || 0),
        botsFailed: counts.FAILED || 0,
        statusCounts: counts,
        plan: { id: "free", name: "Free (demo)" },
        deploymentsToday: 2,
        storageBytes: 41 * 1024 * 1024,
        resourcePolicy: { memoryMbPerBot: 256, cpuPercent: 30, diskMbPerBot: 50 },
        capacityNote: "Demo data — connect a backend to see real usage.",
        bots: bots.map(function (b) { return { id: b.id, name: b.name, status: b.status, runtime: b.runtime }; }),
        recentDeployments: deployments.map(function (d) { return Object.assign({}, d); }),
      });
    },

    bot: function (id) {
      var b = bots.find(function (x) { return x.id === id; });
      if (!b) return Promise.reject(new Error("bot_not_found"));
      return Promise.resolve({
        demo: true,
        bot: Object.assign({}, b),
        runtime: b.runtimeStatus ? { state: b.runtimeStatus, memoryMb: b.memoryMb, uptimeSec: b.uptimeSec, cpuPercent: 0.4 } : null,
        runtimeError: b.runtimeReachable ? null : "runtime_unavailable",
        deployments: deployments.filter(function (d) { return d.botId === id; }),
        demo: true,
      });
    },

    deploymentsFor: function (id) {
      return Promise.resolve({ demo: true, deployments: deployments.filter(function (d) { return d.botId === id; }) });
    },

    allDeployments: function () {
      return Promise.resolve({ demo: true, deployments: deployments.map(function (d) { return Object.assign({}, d); }) });
    },

    logs: function (id) {
      var b = bots.find(function (x) { return x.id === id; });
      var lines = [];
      if (b && b.status === "RUNNING") {
        lines = [
          { ts: now - 40000, stream: "sys", text: "[demo] sample runtime log — connect a backend for real logs" },
          { ts: now - 30000, stream: "out", text: "bot started · long polling enabled" },
          { ts: now - 20000, stream: "out", text: "update received from chat 123456" },
          { ts: now - 10000, stream: "out", text: "reply sent (42 ms)" },
          { ts: now - 2000, stream: "out", text: "heartbeat ok · uptime " + Math.floor(b.uptimeSec / 60) + "m" },
        ];
      } else if (b && b.status === "FAILED") {
        lines = [
          { ts: now - 700000, stream: "sys", text: "[demo] sample build log — deployment FAILED" },
          { ts: now - 690000, stream: "err", text: "pip install failed: index unreachable (demo)" },
        ];
      }
      return Promise.resolve({ demo: true, lines: lines, truncated: false, kind: "runtime" });
    },

    env: function () {
      return Promise.resolve({
        demo: true,
        vars: [
          { key: "TELEGRAM_BOT_TOKEN", isSecret: true, preview: "••••••••", updatedAt: ago(120) },
          { key: "LOG_LEVEL", isSecret: false, preview: "LOG_LEVEL is stored (value hidden; edit to replace)", updatedAt: ago(300) },
        ],
        note: "Demo data — real secrets are encrypted at rest and can never be viewed after saving.",
      });
    },

    files: function () {
      return Promise.resolve({
        demo: true,
        entries: [
          { name: "main.py", type: "file", size: 1337 },
          { name: "requirements.txt", type: "file", size: 89 },
          { name: "README.md", type: "file", size: 421 },
        ],
        path: "",
      });
    },

    user: { id: "demo", email: "demo@botdock.local", name: "Demo Operator", role: "ADMIN", emailVerified: true },

    adminStats: function () {
      return Promise.resolve({
        demo: true,
        users: { total: 128, verified: 97, suspendedOrBanned: 2 },
        bots: { RUNNING: 61, STOPPED: 34, FAILED: 9, CREATED: 7 },
        deployments: { last24h: 143, failedLast24h: 6 },
        emails: { SENT: 210, FAILED: 3, SKIPPED: 55 },
        auditLogEntries: 1841,
        runtime: { ok: true, version: "1.0.0", uptimeSec: 86400 * 2, activeBots: 61 },
        runtimeError: null,
      });
    },

    adminUsers: function () {
      var rows = [
        { id: "u1", email: "demo@botdock.local", name: "Demo Operator", role: "ADMIN", status: "ACTIVE", emailVerified: true, createdAt: ago(40 * 24 * 60), botCount: 4 },
        { id: "u2", email: "ada@example.com", name: "Ada L.", role: "USER", status: "ACTIVE", emailVerified: true, createdAt: ago(12 * 24 * 60), botCount: 7 },
        { id: "u3", email: "grace@example.com", name: "Grace H.", role: "USER", status: "SUSPENDED", emailVerified: true, createdAt: ago(30 * 24 * 60), botCount: 2 },
        { id: "u4", email: "linus@example.com", name: "Linus T.", role: "USER", status: "ACTIVE", emailVerified: false, createdAt: ago(60), botCount: 0 },
      ];
      return Promise.resolve({ demo: true, users: rows, total: rows.length, page: 1, pageSize: 20, pages: 1 });
    },

    audit: function () {
      return Promise.resolve({
        demo: true,
        logs: [
          { id: "a1", action: "BOT_DEPLOY", actorEmail: "demo@botdock.local", targetType: "bot", targetId: "demo-2", createdAt: ago(45) },
          { id: "a2", action: "USER_REGISTER", actorEmail: "linus@example.com", createdAt: ago(60) },
          { id: "a3", action: "BOT_CREATE_UPLOAD", actorEmail: "demo@botdock.local", targetType: "bot", targetId: "demo-3", createdAt: ago(26 * 60) },
        ],
        total: 3, page: 1, pageSize: 20, pages: 1,
      });
    },
  });
})();
