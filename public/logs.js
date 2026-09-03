(function (window) {
  "use strict";

  var escapeHtml = (window.Pricing && window.Pricing.escapeHtml) || function (v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };

  var LIMIT = 200;
  var els = {};
  var offset = 0;
  var total = 0;
  var autoTimer = null;
  var searchTimer = null;
  var pendingSource = "";
  var pendingCategory = "";

  function byId(id) {
    return document.getElementById(id);
  }

  /** Valoarea unui input datetime-local convertita in ISO (UTC), pentru comparatia din SQL. */
  function localToIso(value) {
    if (!value) return "";
    var d = new Date(value);
    return isNaN(d.getTime()) ? "" : d.toISOString();
  }

  function isoToLocalInput(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var pad = function (n) {
      return String(n).padStart(2, "0");
    };
    return (
      d.getFullYear() +
      "-" + pad(d.getMonth() + 1) +
      "-" + pad(d.getDate()) +
      "T" + pad(d.getHours()) +
      ":" + pad(d.getMinutes())
    );
  }

  function currentFilters() {
    return {
      level: els.level.value,
      source: els.source.value || pendingSource,
      category: els.category.value || pendingCategory,
      q: els.q.value.trim(),
      from: localToIso(els.from.value),
      to: localToIso(els.to.value),
    };
  }

  /** Scrie filtrele in query string, ca pagina sa fie linkabila si sa supravietuiasca reload-ului. */
  function syncUrl(filters) {
    var params = new URLSearchParams();
    Object.keys(filters).forEach(function (key) {
      if (filters[key]) params.set(key, filters[key]);
    });
    if (offset) params.set("offset", String(offset));
    var qs = params.toString();
    window.history.replaceState(null, "", qs ? "?" + qs : window.location.pathname);
  }

  function restoreFromUrl() {
    var params = new URLSearchParams(window.location.search);
    if (params.get("level")) els.level.value = params.get("level");
    // Optiunile pentru sursa/categorie vin abia din /api/logs/facets - retinem valoarea
    // dorita si o aplicam dupa ce se populeaza select-urile.
    pendingSource = params.get("source") || "";
    pendingCategory = params.get("category") || "";
    if (pendingSource) els.source.value = pendingSource;
    if (pendingCategory) els.category.value = pendingCategory;
    if (params.get("q")) els.q.value = params.get("q");
    if (params.get("from")) els.from.value = isoToLocalInput(params.get("from"));
    if (params.get("to")) els.to.value = isoToLocalInput(params.get("to"));
    offset = Number(params.get("offset")) || 0;
  }

  function formatTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString("ro-RO", { hour12: false });
  }

  function renderRows(rows) {
    if (!rows.length) {
      els.body.innerHTML =
        '<tr><td colspan="7" class="log-time">Nicio intrare pentru filtrele curente.</td></tr>';
      return;
    }
    els.body.innerHTML = rows
      .map(function (row) {
        var detailRow = row.detail
          ? '<tr class="log-detail" id="detail-' + row.id + '" hidden>' +
            '<td colspan="7"><pre>' + escapeHtml(row.detail) + "</pre></td></tr>"
          : "";
        return (
          '<tr class="log-row" data-id="' + row.id + '">' +
          '<td class="log-time">' + escapeHtml(formatTime(row.ts)) + "</td>" +
          '<td><span class="log-level-badge log-level-badge--' + escapeHtml(row.level) + '">' +
          escapeHtml(row.level) + "</span></td>" +
          "<td>" + escapeHtml(row.source) + "</td>" +
          "<td>" + escapeHtml(row.category) + "</td>" +
          '<td class="log-message">' + escapeHtml(row.message) + "</td>" +
          '<td class="log-num">' + (row.duration_ms == null ? "" : row.duration_ms + " ms") + "</td>" +
          '<td class="log-num">' + (row.status == null ? "" : escapeHtml(row.status)) + "</td>" +
          "</tr>" +
          detailRow
        );
      })
      .join("");
  }

  function updatePager() {
    var shown = Math.min(offset + LIMIT, total);
    els.pagerInfo.textContent = total
      ? (offset + 1) + "–" + shown + " din " + total
      : "0 rezultate";
    els.prev.disabled = offset <= 0;
    els.next.disabled = offset + LIMIT >= total;
  }

  function load() {
    var filters = currentFilters();
    syncUrl(filters);
    var params = new URLSearchParams();
    Object.keys(filters).forEach(function (key) {
      if (filters[key]) params.set(key, filters[key]);
    });
    params.set("limit", String(LIMIT));
    params.set("offset", String(offset));

    els.meta.textContent = "Se încarcă…";
    // fetch direct - AppLogger nu e incarcat aici, ca sa nu se auto-logheze pagina de loguri
    fetch("/api/logs?" + params.toString())
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        if (data.error) throw new Error(data.error);
        total = data.total || 0;
        renderRows(data.rows || []);
        updatePager();
        els.meta.textContent =
          total + " intrări potrivite • actualizat " + new Date().toLocaleTimeString("ro-RO", { hour12: false });
      })
      .catch(function (err) {
        els.meta.textContent = "Eroare la citirea logurilor: " + err.message;
      });
  }

  function loadFacets() {
    fetch("/api/logs/facets")
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        var fill = function (select, values, wanted) {
          var current = wanted || select.value;
          select.innerHTML =
            '<option value="">Toate</option>' +
            (values || [])
              .map(function (v) {
                return '<option value="' + escapeHtml(v) + '">' + escapeHtml(v) + "</option>";
              })
              .join("");
          select.value = current;
        };
        fill(els.source, data.sources, pendingSource);
        fill(els.category, data.categories, pendingCategory);
        pendingSource = "";
        pendingCategory = "";
      })
      .catch(function () {
        /* filtrele raman "Toate" */
      });
  }

  function reset() {
    offset = 0;
    load();
  }

  function init() {
    els = {
      level: byId("filter-level"),
      source: byId("filter-source"),
      category: byId("filter-category"),
      q: byId("filter-q"),
      from: byId("filter-from"),
      to: byId("filter-to"),
      body: byId("logs-body"),
      meta: byId("logs-meta"),
      pagerInfo: byId("pager-info"),
      prev: byId("btn-prev"),
      next: byId("btn-next"),
      refresh: byId("btn-refresh"),
      clear: byId("btn-clear"),
      auto: byId("chk-auto"),
    };

    restoreFromUrl();
    loadFacets();

    [els.level, els.source, els.category, els.from, els.to].forEach(function (el) {
      el.addEventListener("change", reset);
    });

    els.q.addEventListener("input", function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(reset, 300);
    });

    els.refresh.addEventListener("click", load);

    els.prev.addEventListener("click", function () {
      offset = Math.max(0, offset - LIMIT);
      load();
    });

    els.next.addEventListener("click", function () {
      offset = offset + LIMIT;
      load();
    });

    els.auto.addEventListener("change", function () {
      clearInterval(autoTimer);
      autoTimer = els.auto.checked ? setInterval(load, 5000) : null;
    });

    els.clear.addEventListener("click", function () {
      if (!window.confirm("Ștergi toate logurile? Acțiunea nu poate fi anulată.")) return;
      fetch("/api/logs", { method: "DELETE" })
        .then(function (r) {
          return r.json();
        })
        .then(function () {
          reset();
          loadFacets();
        })
        .catch(function (err) {
          els.meta.textContent = "Eroare la ștergere: " + err.message;
        });
    });

    // Click pe rand: arata/ascunde detaliile (JSON: stack, payload, counts).
    els.body.addEventListener("click", function (event) {
      var row = event.target.closest(".log-row");
      if (!row) return;
      var detail = byId("detail-" + row.dataset.id);
      if (detail) detail.hidden = !detail.hidden;
    });

    load();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})(window);
