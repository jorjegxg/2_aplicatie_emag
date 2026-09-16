/**
 * Notificări pentru comenzi eMAG noi:
 * - toast în pagină (polling, cât timp e tab-ul deschis)
 * - Web Push → bara de notificări pe telefon / desktop (și cu app închisă)
 */
(function () {
  "use strict";

  var PREF_KEY = "emag-order-browser-notif";
  var WATERMARK_KEY = "emag-order-notif-watermark";
  var POLL_MS = 10000;
  var SW_PATH = "/sw.js";
  var pollTimer = null;
  var toastEl = null;
  var pushSubscribed = false;

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
    if (Notification.permission === "granted") {
      return pushSubscribed ? "Push activ" : "Activ";
    }
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
      '<button type="button" class="order-notif-close" aria-label="Închide notificarea" title="Închide">Închide</button>' +
      '<strong>Comandă nouă #' +
      String(id) +
      "</strong>" +
      "<span>" +
      name +
      " · " +
      formatTotal(order) +
      '</span><a href="/vanzari.html">Deschide Comenzi</a>';
    el.querySelector(".order-notif-close").addEventListener("click", function () {
      clearTimeout(showInPageToast._t);
      el.classList.remove("is-visible");
      el.hidden = true;
    });
    el.hidden = false;
    el.classList.add("is-visible");
    clearTimeout(showInPageToast._t);
    showInPageToast._t = setTimeout(function () {
      el.classList.remove("is-visible");
      el.hidden = true;
    }, 12000);
  }

  function showBrowserNotification(order, forceLocal) {
    // Dacă avem Web Push, OS-ul primește alerta din service worker — evităm dublura.
    showBrowserNotification.lastError = "";
    if (pushSubscribed && !forceLocal) return true;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") {
      showBrowserNotification.lastError =
        typeof Notification === "undefined"
          ? "Browserul nu suportă Notification API."
          : "Permisiunea pentru notificări nu este acordată (" +
            Notification.permission +
            ").";
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
    } catch (err) {
      showBrowserNotification.lastError =
        err && err.message
          ? "Browserul a refuzat notificarea: " + err.message
          : "Browserul a refuzat notificarea. Verifică permisiunea site-ului și setările Nu deranja.";
      return false;
    }
  }

  function notifyOrder(order) {
    showInPageToast(order);
    showBrowserNotification(order);
  }

  function bumpWatermark(orders) {
    var max = getWatermark();
    for (var i = 0; i < orders.length; i++) {
      var iso = toIso(orders[i].created_at);
      if (!iso) continue;
      if (!max || iso > max) max = iso;
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
    var req = after
      ? fetchNewOrders(after)
      : syncWatermarkFromServer().then(function () {
          return { ok: true, data: { orders: [], server_time: getWatermark() } };
        });

    req
      .then(function (result) {
        if (!result.ok) return;
        var orders = Array.isArray(result.data.orders) ? result.data.orders : [];
        if (orders.length === 0) {
          if (!getWatermark() && result.data.server_time) {
            setWatermark(result.data.server_time);
          }
          return;
        }
        for (var i = 0; i < orders.length; i++) {
          notifyOrder(orders[i]);
        }
        bumpWatermark(orders);
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

  function urlBase64ToUint8Array(base64String) {
    var padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    var raw = atob(base64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function pushSupported() {
    return (
      window.isSecureContext &&
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window
    );
  }

  function registerServiceWorker() {
    return navigator.serviceWorker.register(SW_PATH, { scope: "/" });
  }

  function getExistingSubscription() {
    return navigator.serviceWorker.ready.then(function (reg) {
      return reg.pushManager.getSubscription();
    });
  }

  function fetchVapidPublicKey() {
    return fetch("/api/push/vapid-public-key", {
      credentials: "same-origin",
      cache: "no-store",
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok || !data.publicKey) {
          throw new Error(data.error || "Nu pot citi cheia VAPID");
        }
        return data.publicKey;
      });
    });
  }

  function postJson(url, body) {
    return fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    }).then(function (res) {
      return res.json().then(function (data) {
        return { ok: res.ok, data: data || {} };
      });
    });
  }

  function subscribePush() {
    if (!pushSupported()) {
      return Promise.resolve({
        ok: false,
        message:
          "Acest browser nu suportă Web Push. Pe iPhone: iOS 16.4+ și „Adaugă pe ecranul principal”.",
      });
    }
    return registerServiceWorker()
      .then(function () {
        return Promise.all([navigator.serviceWorker.ready, fetchVapidPublicKey()]);
      })
      .then(function (pair) {
        var reg = pair[0];
        var key = pair[1];
        return reg.pushManager.getSubscription().then(function (existing) {
          if (existing) return existing;
          return reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(key),
          });
        });
      })
      .then(function (sub) {
        return postJson("/api/push/subscribe", sub.toJSON()).then(function (result) {
          if (!result.ok) {
            throw new Error(result.data.error || "Salvare subscription eșuată");
          }
          pushSubscribed = true;
          return { ok: true };
        });
      })
      .catch(function (err) {
        pushSubscribed = false;
        return {
          ok: false,
          message: err.message || "Nu s-a putut activa push pe dispozitiv.",
        };
      });
  }

  function unsubscribePush() {
    if (!pushSupported()) {
      pushSubscribed = false;
      return Promise.resolve();
    }
    return getExistingSubscription()
      .then(function (sub) {
        if (!sub) return;
        var endpoint = sub.endpoint;
        return sub.unsubscribe().then(function () {
          return postJson("/api/push/unsubscribe", { endpoint: endpoint });
        });
      })
      .catch(function () {
        /* ignore */
      })
      .then(function () {
        pushSubscribed = false;
      });
  }

  function refreshPushState() {
    if (!isEnabled() || !pushSupported() || Notification.permission !== "granted") {
      pushSubscribed = false;
      return Promise.resolve(false);
    }
    return registerServiceWorker()
      .then(function () {
        return getExistingSubscription();
      })
      .then(function (sub) {
        if (!sub) {
          pushSubscribed = false;
          return false;
        }
        return postJson("/api/push/subscribe", sub.toJSON()).then(function (result) {
          pushSubscribed = Boolean(result.ok);
          return pushSubscribed;
        });
      })
      .catch(function () {
        pushSubscribed = false;
        return false;
      });
  }

  function enable() {
    if (typeof Notification === "undefined" || !window.isSecureContext) {
      setEnabled(false);
      return Promise.resolve({
        ok: false,
        permission: "unavailable",
        message: !window.isSecureContext
          ? "Notificările necesită HTTPS (sau localhost)."
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
              ? "Permisiunea a fost blocată. Deblochează din setările site-ului (lacătul de lângă URL)."
              : "Permisiunea nu a fost acordată.",
        };
      }
      setEnabled(true);
      return subscribePush().then(function (pushResult) {
        return syncWatermarkFromServer()
          .then(function () {
            startPolling();
            if (pushResult.ok) {
              return {
                ok: true,
                permission: perm,
                push: true,
                message: "Push activ — alertele apar în bara de notificări pe telefon.",
              };
            }
            return {
              ok: true,
              permission: perm,
              push: false,
              message:
                (pushResult.message || "Push indisponibil.") +
                " Rămân alertele din tab cât timp aplicația e deschisă.",
            };
          })
          .catch(function (err) {
            setWatermark(new Date().toISOString());
            startPolling();
            return {
              ok: true,
              permission: perm,
              push: Boolean(pushResult && pushResult.ok),
              message: err.message || "Activ, dar sincronizarea timpului a eșuat.",
            };
          });
      });
    });
  }

  function disable() {
    setEnabled(false);
    stopPolling();
    return unsubscribePush();
  }

  /** Notificare de test: preferă push server → telefon; fallback Notification API. */
  function sendTestNotification() {
    var sample = {
      order_id: "TEST",
      customer_name: "Test Notificare",
      products_total: 1.0,
      currency: "RON",
    };
    showInPageToast(sample);

    if (typeof Notification === "undefined") {
      return Promise.resolve({ ok: false, message: "Browserul nu suportă Notification API." });
    }
    if (!window.isSecureContext) {
      return Promise.resolve({ ok: false, message: "Context nesigur — folosește HTTPS." });
    }
    if (Notification.permission !== "granted") {
      return Promise.resolve({
        ok: false,
        message: "Permisiunea nu e acordată. Activează toggle-ul mai întâi.",
      });
    }

    if (pushSubscribed) {
      return postJson("/api/push/test", {})
        .then(function (result) {
          if (result.ok && Number(result.data.sent || 0) > 0) {
            return {
              ok: true,
              message:
                "Push de test trimis pe " +
                (result.data.sent || 0) +
                " dispozitiv(e). Verifică bara de notificări.",
            };
          }
          var fallbackOk = showBrowserNotification(sample, true);
          return {
            ok: false,
            message:
              (result.data.error || "Push eșuat.") +
              (fallbackOk
                ? " Notificarea locală a fost trimisă."
                : " " +
                  (showBrowserNotification.lastError ||
                    "Notificarea locală a eșuat.")),
          };
        })
        .catch(function (err) {
          var fallbackOk = showBrowserNotification(sample, true);
          return {
            ok: false,
            message:
              "Serverul de push nu poate fi contactat (" +
              (err.message || "eroare de rețea") +
              ")." +
              (fallbackOk
                ? " Notificarea locală a fost trimisă."
                : " " + (showBrowserNotification.lastError || "Notificarea locală a eșuat.")),
          };
        });
    }

    var browserOk = showBrowserNotification(sample);
    if (!browserOk) {
      return Promise.resolve({
        ok: false,
        message:
          "Toast în pagină afișat; notificarea OS a eșuat. " +
          (showBrowserNotification.lastError ||
            "Verifică permisiunea site-ului și setările Nu deranja."),
      });
    }
    return Promise.resolve({
      ok: true,
      message: "Notificare locală trimisă. Pentru telefon cu app închisă, reactivează toggle-ul (Web Push).",
    });
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
    pushSupported: pushSupported,
    isPushSubscribed: function () {
      return pushSubscribed;
    },
    refreshPushState: refreshPushState,
  };

  function boot() {
    refreshPushState().finally(function () {
      startPolling();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
