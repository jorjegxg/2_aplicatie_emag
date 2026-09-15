/**
 * Notificări browser pentru comenzi eMAG noi.
 * Preferință în localStorage; polling pe paginile autentificate.
 * Watermark-ul folosește timpul serverului (evită ceasul browserului).
 */
(function () {
  "use strict";

  var PREF_KEY = "emag-order-browser-notif";
  var WATERMARK_KEY = "emag-order-notif-watermark";
  var POLL_MS = 10000;
  var pollTimer = null;
  var toastEl = null;

  function isEnabled() {
    return localStorage.getItem(PREF_KEY) === "1";
  }

  function setEnabled(on) {
    localStorage.setItem(PREF_KEY, on ? "1" : "0");
  }

  function getWatermark() {
    return localStorage.getItem(WATERMARK_KEY) || "";
  }

  function setWatermark(iso) {
    if (!iso) return;
    var d = new Date(iso);
    if (Number.isNaN(d.getTime())) return;
    localStorage.setItem(WATERMARK_KEY, d.toISOString());
  }

  function toIso(value) {
    if (!value) return "";
    if (typeof value === "string") {
      var d = new Date(value);
      return Number.isNaN(d.getTime()) ? value : d.toISOString();
    }
    if (value instanceof Date) return value.toISOString();
    var parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
  }

  function permissionLabel() {
    if (typeof Notification === "undefined") return "indisponibil";
    if (!window.isSecureContext) return "necesită HTTPS";
    if (Notification.permission === "granted") return "Activ";
    if (Notification.permission === "denied") return "Blocat";
    return "Nepermis";
  }

  function formatTotal(order) {
    var total = order.products_total;
    var currency = order.currency || "RON";
    if (total == null || total === "") return currency;
    var n = Number(total);
    if (!Number.isFinite(n)) return String(total) + " " + currency;
    return n.toFixed(2) + " " + currency;
  }

  function ensureToastEl() {
    if (toastEl && document.body.contains(toastEl)) return toastEl;
    toastEl = document.createElement("div");
    toastEl.id = "order-notif-toast";
    toastEl.className = "order-notif-toast";
    toastEl.setAttribute("role", "status");
    toastEl.hidden = true;
    document.body.appendChild(toastEl);
    return toastEl;
  }

  function showInPageToast(order) {
    var el = ensureToastEl();
    var id = order.order_id;
    var name = (order.customer_name || "").trim() || "Client";
    el.innerHTML =
      '<strong>Comandă nouă #' +
      String(id) +
      "</strong>" +
      "<span>" +
      name +
      " · " +
      formatTotal(order) +
      '</span><a href="/vanzari.html">Deschide Comenzi</a>';
    el.hidden = false;
    el.classList.add("is-visible");
    clearTimeout(showInPageToast._t);
    showInPageToast._t = setTimeout(function () {
      el.classList.remove("is-visible");
      el.hidden = true;
    }, 12000);
  }

  function showBrowserNotification(order) {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") {
      return false;
    }
    var id = order.order_id;
    var name = (order.customer_name || "").trim() || "Client";
    var body = name + " · " + formatTotal(order);
    try {
      var n = new Notification("Comandă eMAG #" + id, {
        body: body,
        tag: "emag-order-" + id,
      });
      n.onclick = function () {
        window.focus();
        if (!/\/vanzari\.html$/i.test(window.location.pathname)) {
          window.location.href = "/vanzari.html";
        }
        n.close();
      };
      return true;
    } catch (_) {
      return false;
    }
  }

  function notifyOrder(order) {
    showInPageToast(order);
    showBrowserNotification(order);
  }

  function bumpWatermark(orders, serverTime) {
    var max = getWatermark();
    for (var i = 0; i < orders.length; i++) {
      var iso = toIso(orders[i].created_at);
      if (!iso) continue;
      if (!max || iso > max) max = iso;
    }
    var serverIso = toIso(serverTime);
    if (serverIso && (!max || serverIso > max)) {
      // Nu urca watermark-ul peste comenzile vazute; doar pastreaza max din comenzi.
    }
    if (max) setWatermark(max);
  }

  function fetchNewOrders(after) {
    var url = "/api/orders/local/new";
    if (after) {
      url += "?after_created_at=" + encodeURIComponent(after);
    }
    return fetch(url, { credentials: "same-origin", cache: "no-store" }).then(
      function (res) {
        return res.json().then(function (data) {
          return { ok: res.ok, data: data || {} };
        });
      }
    );
  }

  function syncWatermarkFromServer() {
    return fetchNewOrders(null).then(function (result) {
      if (!result.ok || !result.data.server_time) {
        throw new Error(result.data.error || "Nu pot citi timpul serverului");
      }
      setWatermark(result.data.server_time);
      return result.data.server_time;
    });
  }

  function poll() {
    if (!isEnabled()) return;
    var after = getWatermark();
    var req = after ? fetchNewOrders(after) : syncWatermarkFromServer().then(function () {
      return { ok: true, data: { orders: [], server_time: getWatermark() } };
    });

    req
      .then(function (result) {
        if (!result.ok) return;
        var orders = Array.isArray(result.data.orders) ? result.data.orders : [];
        if (orders.length === 0) {
          // Pastreaza watermark-ul; optional aliniaza daca lipsea.
          if (!getWatermark() && result.data.server_time) {
            setWatermark(result.data.server_time);
          }
          return;
        }
        for (var i = 0; i < orders.length; i++) {
          notifyOrder(orders[i]);
        }
        bumpWatermark(orders, result.data.server_time);
      })
      .catch(function () {
        /* ignore transient errors */
      });
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function startPolling() {
    stopPolling();
    if (!isEnabled()) return;
    if (!getWatermark()) {
      syncWatermarkFromServer()
        .then(function () {
          poll();
          pollTimer = setInterval(poll, POLL_MS);
        })
        .catch(function () {
          pollTimer = setInterval(poll, POLL_MS);
        });
      return;
    }
    poll();
    pollTimer = setInterval(poll, POLL_MS);
  }

  function enable() {
    if (typeof Notification === "undefined" || !window.isSecureContext) {
      setEnabled(false);
      return Promise.resolve({
        ok: false,
        permission: "unavailable",
        message: !window.isSecureContext
          ? "Notificările browser necesită HTTPS."
          : "Browserul nu suportă notificări.",
      });
    }
    return Notification.requestPermission().then(function (perm) {
      if (perm !== "granted") {
        setEnabled(false);
        return {
          ok: false,
          permission: perm,
          message:
            perm === "denied"
              ? "Permisiunea a fost blocată în browser. Deblochează din setările site-ului (lacătul de lângă URL)."
              : "Permisiunea nu a fost acordată.",
        };
      }
      setEnabled(true);
      return syncWatermarkFromServer()
        .then(function () {
          startPolling();
          return { ok: true, permission: perm };
        })
        .catch(function (err) {
          // Totusi activeaza; watermark la urmatorul poll.
          setWatermark(new Date().toISOString());
          startPolling();
          return {
            ok: true,
            permission: perm,
            message: err.message || "Activ, dar sincronizarea timpului a eșuat.",
          };
        });
    });
  }

  function disable() {
    setEnabled(false);
    stopPolling();
  }

  /** Notificare imediata de test (fara comanda in DB). */
  function sendTestNotification() {
    var sample = {
      order_id: "TEST",
      customer_name: "Test Notificare",
      products_total: 1.0,
      currency: "RON",
    };
    showInPageToast(sample);
    var browserOk = showBrowserNotification(sample);
    if (typeof Notification === "undefined") {
      return { ok: false, message: "Browserul nu suportă Notification API." };
    }
    if (!window.isSecureContext) {
      return { ok: false, message: "Context nesigur — folosește HTTPS." };
    }
    if (Notification.permission !== "granted") {
      return {
        ok: false,
        message: "Permisiunea nu e acordată (" + Notification.permission + "). Activează toggle-ul mai întâi.",
      };
    }
    if (!browserOk) {
      return {
        ok: false,
        message: "Toast în pagină afișat; notificarea OS a eșuat (verifică Focus Assist / Nu deranja).",
      };
    }
    return { ok: true, message: "Notificare de test trimisă (pagină + browser)." };
  }

  window.OrderNotifications = {
    PREF_KEY: PREF_KEY,
    isEnabled: isEnabled,
    enable: enable,
    disable: disable,
    permissionLabel: permissionLabel,
    startPolling: startPolling,
    stopPolling: stopPolling,
    sendTestNotification: sendTestNotification,
    syncWatermarkFromServer: syncWatermarkFromServer,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startPolling);
  } else {
    startPolling();
  }
})();
