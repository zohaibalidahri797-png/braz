/* Public marketing/content pages (home, docs, 404) boot the shared shell in
 * PUBLIC mode: no session requirement, no redirect when logged out. The active
 * nav item (when one exists) comes from <body data-page="...">.
 * App pages (dashboard/bots/...) keep their own app-mode boots. */
(function () {
  "use strict";
  var App = window.BotDockApp || window.App; // app.js exposes BotDockApp
  if (!App || typeof App.boot !== "function") return;
  App.boot({
    mode: "public",
    page: document.body.getAttribute("data-page") || "",
  });
})();
