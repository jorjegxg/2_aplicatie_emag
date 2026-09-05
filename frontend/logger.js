(function (window) {
  "use strict";

  var ENDPOINT = "/api/logs/client";
  var FLUSH_MS = 2000;
  var MAX_BUFFER = 20;

  var buffer = [];
  var timer = null;
  // fetch-ul original, ca flush-ul sa nu se auto-logheze
  var rawFetch = window.fetch ? window.fetch.bind(window) : null;

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!buffer.length || !rawFetch) return;
    var entries = buffer.splice(0, 50);
    rawFetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: entries }),
      keepalive: true,
    }).catch(function () {
      /* logging-ul nu trebuie sa strice pagina */
    });
  }

  function log(entry) {
    if (!entry || !entry.message) return;
    buffer.push({
      ts: new Date().toISOString(),
      level: entry.level || "info",
      category: entry.category || "ui",
      message: String(entry.message),
      durationMs: entry.durationMs,
      status: entry.status,
      detail: Object.assign({ page: window.location.pathname }, entry.detail || {}),
    });
    if (buffer.length >= MAX_BUFFER) return flush();
    if (!timer) timer = setTimeout(flush, FLUSH_MS);
  }

  window.addEventListener("error", function (event) {
    log({
      level: "error",
      category: "uncaught",
      message: event.message || "Eroare JS",
      detail: {
        source: event.filename,
        line: event.lineno,
        column: event.colno,
        stack: event.error && event.error.stack,
      },
    });
    flush();
  });

  window.addEventListener("unhandledrejection", function (event) {
    var reason = event.reason;
    log({
      level: "error",
      category: "uncaught",
      message: "unhandledRejection: " + ((reason && reason.message) || reason),
      detail: { stack: reason && reason.stack },
    });
    flush();
  });

  // Trimite ce a ramas in buffer cand utilizatorul pleaca de pe pagina.
  window.addEventListener("pagehide", flush);

  // Wrapper peste fetch: logheaza raspunsurile non-2xx si erorile de retea de pe /api/*.
  if (rawFetch) {
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var isApi = url.indexOf("/api/") === 0 || url.indexOf("/api/") > 0;
      var isLogRoute = url.indexOf("/api/logs") >= 0;
      if (!isApi || isLogRoute) return rawFetch(input, init);

      var startedAt = Date.now();
      var method = (init && init.method) || "GET";
      return rawFetch(input, init).then(
        function (response) {
          if (!response.ok) {
            log({
              level: response.status >= 500 ? "error" : "warn",
              category: "fetch",
              message: method + " " + url + " → " + response.status,
              status: response.status,
              durationMs: Date.now() - startedAt,
            });
          }
          return response;
        },
        function (err) {
          log({
            level: "error",
            category: "fetch",
            message: method + " " + url + " — eroare retea: " + (err && err.message),
            durationMs: Date.now() - startedAt,
            detail: { stack: err && err.stack },
          });
          throw err;
        }
      );
    };
  }

  window.AppLogger = { log: log, flush: flush };
})(window);
