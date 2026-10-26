(function (window) {
  "use strict";

  var escapeHtml = (window.Pricing && window.Pricing.escapeHtml) || function (v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };

  var STATUSES = [
    { key: "pending", label: "În așteptare" },
    { key: "sent", label: "Trimis direct (vechi)" },
    { key: "done", label: "Trimis în Base" },
    { key: "skipped", label: "Deja la zi" },
    { key: "failed", label: "Eșuat" },
    { key: "cancelled", label: "Anulat" },
  ];
  var STATUS_LABEL = STATUSES.reduce(function (o, s) {
    o[s.key] = s.label;
    return o;
  }, {});
  var OPEN = { pending: true, sent: true };
  var FINISHED_OK = { done: true, skipped: true };

  var els = {};
  var items = [];
  var byIdMap = {};
  var statusFilter = "";
  var expanded = {};
  var autoTimer = null;

  function byId(id) {
    return document.getElementById(id);
  }

  function formatTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString("ro-RO", { hour12: false, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  function ago(iso) {
    if (!iso) return "niciodată";
    var min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (min < 1) return "acum";
    if (min < 60) return "acum " + min + " min";
    var h = Math.floor(min / 60);
    return "acum " + h + " h " + (min % 60) + " min";
  }

  function request(url, options) {
    return fetch(url, options).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body.error || "HTTP " + r.status);
        return body;
      });
    });
  }

  function postJson(url, data) {
    return request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data || {}),
    });
  }

  /** Ce trimite intrarea, pe scurt: poze / titlu / descriere / caracteristici. */
  function whatHtml(it) {
    var parts = [];
    if (it.send_images) parts.push("poze");
    if (it.name_from_app) parts.push("titlu (app)");
    else if (it.name) parts.push("titlu");
    if (it.description_from_app) parts.push("descriere (app)");
    else if (it.description) parts.push("descriere");
    if (it.characteristics && Object.keys(it.characteristics).length) {
      parts.push(Object.keys(it.characteristics).length + " caract.");
    }
    if (it.replace_pending) parts.push("înlocuiește blocat");
    return escapeHtml(parts.join(", ") || "—");
  }

  /** De ce nu a plecat încă o intrare pending (doar ce se vede din coadă; statusul 11 de pe eMAG îl știe doar serviciul). */
  function waitingHtml(it) {
    var bits = [];
    if (it.after_id) {
      var dep = byIdMap[it.after_id];
      var depStatus = dep ? dep.status : null;
      var cls = depStatus && FINISHED_OK[depStatus] ? "queue-dep queue-dep--ok" : "queue-dep";
      bits.push(
        '<a href="#q-' + it.after_id + '" class="' + cls + '" data-jump="' + it.after_id + '">după #' + it.after_id +
          (dep ? " " + (dep.platform || "").toUpperCase() + " · " + escapeHtml(STATUS_LABEL[depStatus] || depStatus) : "") +
          "</a>"
      );
    }
    if (it.status === "pending" && new Date(it.not_before).getTime() > Date.now()) {
      bits.push("de la " + escapeHtml(formatTime(it.not_before)));
    }
    if (it.status === "sent" && it.sent_at) bits.push("trimis " + escapeHtml(formatTime(it.sent_at)));
    return bits.join("<br>") || '<span class="queue-muted">—</span>';
  }

  function actionsHtml(it) {
    var html = "";
    if (OPEN[it.status]) {
      html += '<button type="button" class="btn btn-secondary btn-small" data-action="cancel" data-id="' + it.id + '">Anulează</button>';
    }
    if (it.status === "failed" || it.status === "cancelled") {
      html += '<button type="button" class="btn btn-secondary btn-small" data-action="retry" data-id="' + it.id + '">Repune</button>';
    }
    return html;
  }

  function detailHtml(it) {
    var rows = [];
    function add(label, value, pre) {
      if (value == null || value === "") return;
      rows.push(
        "<dt>" + label + "</dt><dd>" + (pre ? "<pre>" + escapeHtml(value) + "</pre>" : escapeHtml(value)) + "</dd>"
      );
    }
    add("Notă", it.note);
    add("Titlu", it.name_from_app ? "(din aplicație)" : it.name);
    add("Descriere", it.description_from_app ? "(din aplicație)" : it.description, true);
    if (it.characteristics) add("Caracteristici", JSON.stringify(it.characteristics, null, 2), true);
    add("Ultimul mesaj", it.last_message, true);
    add("Creat", formatTime(it.created_at));
    add("Nu mai devreme de", formatTime(it.not_before));
    add("Trimis", formatTime(it.sent_at));
    add("Ultima verificare", formatTime(it.last_check_at));
    add("Terminat", formatTime(it.done_at));
    return '<dl class="queue-detail">' + rows.join("") + "</dl>";
  }

  function matches(it) {
    if (statusFilter && it.status !== statusFilter) return false;
    if (els.platform.value && it.platform !== els.platform.value) return false;
    var q = els.q.value.trim().toLowerCase();
    if (!q) return true;
    if (q.charAt(0) === "#") return String(it.id) === q.slice(1);
    return [it.product_id, it.cod_produs, it.nume].join(" ").toLowerCase().indexOf(q) >= 0;
  }

  function renderCounts() {
    var counts = {};
    items.forEach(function (it) {
      counts[it.status] = (counts[it.status] || 0) + 1;
    });
    var html =
      '<button type="button" class="queue-count' + (statusFilter ? "" : " is-active") + '" data-status="">Toate <b>' +
      items.length + "</b></button>";
    STATUSES.forEach(function (s) {
      if (!counts[s.key] && statusFilter !== s.key) return;
      html +=
        '<button type="button" class="queue-count queue-count--' + s.key + (statusFilter === s.key ? " is-active" : "") +
        '" data-status="' + s.key + '">' + s.label + " <b>" + (counts[s.key] || 0) + "</b></button>";
    });
    els.counts.innerHTML = html;
  }

  function renderRows() {
    var rows = items.filter(matches);
    if (!rows.length) {
      els.body.innerHTML = '<tr><td colspan="10" class="log-time">Nicio intrare pentru filtrele curente.</td></tr>';
      return;
    }
    els.body.innerHTML = rows
      .map(function (it) {
        var msg = it.last_message || "";
        return (
          '<tr class="log-row queue-row" id="q-' + it.id + '" data-id="' + it.id + '">' +
          '<td class="log-num">' + it.id + "</td>" +
          '<td class="queue-product"><b>' + escapeHtml(it.product_id) + " · " + escapeHtml(it.cod_produs || "") + "</b>" +
          (it.nume ? '<span class="queue-muted">' + escapeHtml(it.nume) + "</span>" : "") + "</td>" +
          '<td><span class="queue-platform">' + escapeHtml(String(it.platform).toUpperCase()) + "</span></td>" +
          "<td>" + whatHtml(it) + "</td>" +
          '<td><span class="queue-status queue-status--' + escapeHtml(it.status) + '">' +
          escapeHtml(STATUS_LABEL[it.status] || it.status) + "</span></td>" +
          "<td>" + waitingHtml(it) + "</td>" +
          '<td class="log-num">' + it.attempts + "/" + it.max_attempts + "</td>" +
          '<td class="log-message" title="' + escapeHtml(msg) + '"><div class="queue-msg-text">' + escapeHtml(msg) + "</div></td>" +
          '<td class="log-time">' + escapeHtml(formatTime(it.updated_at)) + "</td>" +
          '<td class="queue-actions">' + actionsHtml(it) + "</td>" +
          "</tr>" +
          '<tr class="log-detail" data-detail="' + it.id + '"' + (expanded[it.id] ? "" : " hidden") + '><td colspan="10">' +
          detailHtml(it) + "</td></tr>"
        );
      })
      .join("");
  }

  function render() {
    renderCounts();
    renderRows();
  }

  function renderWorker(worker) {
    els.worker.className = "queue-worker" + (worker.send ? " is-live" : " is-dry");
    els.worker.innerHTML =
      "<b>" + (worker.send ? "Trimite în Base" : "Doar verifică (BASE_SEND=0) — nu trimite nimic") + "</b>" +
      " · verifică la " + Math.round(worker.interval_sec / 60) + " min" +
      " · ultima verificare " + escapeHtml(ago(worker.last_check_at)) +
      (worker.last_check_at ? " (" + escapeHtml(formatTime(worker.last_check_at)) + ")" : "");
  }

  function load() {
    return request("/api/queue" + (els.all.checked ? "?all=1" : ""))
      .then(function (data) {
        items = data.items || [];
        byIdMap = {};
        items.forEach(function (it) {
          byIdMap[it.id] = it;
        });
        renderWorker(data.worker || {});
        render();
      })
      .catch(function (err) {
        els.worker.className = "queue-worker is-error";
        els.worker.textContent = "Eroare la citirea cozii: " + err.message;
      });
  }

  function itemLabel(it) {
    return "#" + it.id + " (" + it.product_id + " " + (it.cod_produs || "") + " " + String(it.platform).toUpperCase() + ")";
  }

  function onAction(button) {
    var id = Number(button.dataset.id);
    var it = byIdMap[id];
    var action = button.dataset.action;
    if (action === "cancel") {
      var dependents = items.filter(function (x) {
        return x.after_id === id && OPEN[x.status];
      });
      var warn = dependents.length
        ? "\n\nAtenție: " + dependents.map(itemLabel).join(", ") + " depind de ea și vor eșua — refă lanțul cu intrări noi."
        : "";
      if (!window.confirm("Anulezi " + itemLabel(it) + "?" + warn)) return;
    }
    button.disabled = true;
    postJson("/api/queue/" + id + "/" + action)
      .then(load)
      .catch(function (err) {
        button.disabled = false;
        window.alert("Eroare: " + err.message);
      });
  }

  function updateRoOnly() {
    var isRo = els.form.elements.platform.value === "ro";
    Array.prototype.forEach.call(els.form.querySelectorAll(".ro-only"), function (label) {
      label.hidden = !isRo;
      if (!isRo) label.querySelector("input").checked = false;
    });
  }

  function onSubmit(event) {
    event.preventDefault();
    var f = els.form.elements;
    var notBefore = f.not_before.value ? new Date(f.not_before.value) : null;
    var data = {
      product: f.product.value.trim(),
      platform: f.platform.value,
      after_id: f.after_id.value ? Number(f.after_id.value) : null,
      not_before: notBefore && !isNaN(notBefore.getTime()) ? notBefore.toISOString() : null,
      send_images: f.send_images.checked,
      name_from_app: f.name_from_app.checked,
      description_from_app: f.description_from_app.checked,
      replace_pending: f.replace_pending.checked,
      name: f.name.value.trim() || null,
      description: f.description.value.trim() || null,
      characteristics: f.characteristics.value.trim() || null,
      note: f.note.value.trim() || null,
    };
    if (data.characteristics) {
      try {
        JSON.parse(data.characteristics);
      } catch (e) {
        els.formStatus.className = "status is-error";
        els.formStatus.textContent = "Caracteristicile nu sunt JSON valid: " + e.message;
        return;
      }
    }
    els.formStatus.className = "status is-loading";
    els.formStatus.textContent = "Se adaugă…";
    postJson("/api/queue", data)
      .then(function (res) {
        els.formStatus.className = "status";
        els.formStatus.textContent = "Adăugat #" + res.item.id + ".";
        els.form.reset();
        updateRoOnly();
        return load();
      })
      .catch(function (err) {
        els.formStatus.className = "status is-error";
        els.formStatus.textContent = err.message;
      });
  }

  function init() {
    els.worker = byId("queue-worker");
    els.counts = byId("queue-counts");
    els.q = byId("queue-q");
    els.platform = byId("queue-platform");
    els.all = byId("queue-all");
    els.auto = byId("queue-auto");
    els.body = byId("queue-body");
    els.form = byId("queue-form");
    els.formStatus = byId("queue-form-status");

    var params = new URLSearchParams(window.location.search);
    if (params.get("q")) els.q.value = params.get("q");
    if (params.get("status")) statusFilter = params.get("status");

    els.counts.addEventListener("click", function (event) {
      var btn = event.target.closest(".queue-count");
      if (!btn) return;
      statusFilter = btn.dataset.status;
      render();
    });
    els.q.addEventListener("input", renderRows);
    els.platform.addEventListener("change", renderRows);
    els.all.addEventListener("change", load);
    byId("queue-refresh").addEventListener("click", load);

    function setAuto() {
      clearInterval(autoTimer);
      autoTimer = els.auto.checked ? setInterval(load, 30000) : null;
    }
    els.auto.addEventListener("change", setAuto);
    setAuto();

    byId("queue-add-toggle").addEventListener("click", function () {
      els.form.hidden = !els.form.hidden;
      if (!els.form.hidden) els.form.elements.product.focus();
    });
    byId("queue-form-cancel").addEventListener("click", function () {
      els.form.hidden = true;
    });
    els.form.elements.platform.addEventListener("change", updateRoOnly);
    els.form.addEventListener("submit", onSubmit);
    updateRoOnly();

    els.body.addEventListener("click", function (event) {
      var button = event.target.closest("button[data-action]");
      if (button) return onAction(button);
      var jump = event.target.closest("[data-jump]");
      if (jump) {
        event.preventDefault();
        var target = byId("q-" + jump.dataset.jump);
        if (target) {
          target.scrollIntoView({ block: "center", behavior: "smooth" });
          target.classList.add("is-flash");
          setTimeout(function () {
            target.classList.remove("is-flash");
          }, 1500);
        }
        return;
      }
      var row = event.target.closest(".queue-row");
      if (!row) return;
      var id = row.dataset.id;
      expanded[id] = !expanded[id];
      var detail = els.body.querySelector('[data-detail="' + id + '"]');
      if (detail) detail.hidden = !expanded[id];
    });

    load();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})(window);
