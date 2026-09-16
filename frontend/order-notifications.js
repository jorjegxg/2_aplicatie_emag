/**
 * Notificări pentru comenzi eMAG noi:
 * - Web Push → bara de notificări pe telefon (și cu app închisă)
 */
(function () {
  "use strict";

  var PREF_KEY = "emag-order-browser-notif";
  var SW_PATH = "/sw.js";
  var pushSubscribed = false;

  function isEnabled() {
    return localStorage.getItem(PREF_KEY) === "1";
  }

  function setEnabled(on) {
    localStorage.setItem(PREF_KEY, on ? "1" : "0");
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
            " Activează notificările pe telefon pentru a primi alerte.",
        };
      });
    });
  }

  function disable() {
    setEnabled(false);
    return unsubscribePush();
  }

  /** Notificare de test livrată exclusiv prin Web Push către telefon. */
  function sendTestNotification() {
    if (!window.isSecureContext) {
      return Promise.resolve({ ok: false, message: "Context nesigur — folosește HTTPS." });
    }
    if (!pushSubscribed) {
      return Promise.resolve({
        ok: false,
        message: "Telefonul nu este abonat la Web Push. Activează notificările mai întâi.",
      });
    }

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
        return {
          ok: false,
          message: result.data.error || "Push-ul nu a fost livrat telefonului.",
        };
      })
      .catch(function (err) {
        return {
          ok: false,
          message:
            "Serverul de push nu poate fi contactat (" +
            (err.message || "eroare de rețea") +
            ").",
        };
      });
  }

  window.OrderNotifications = {
    PREF_KEY: PREF_KEY,
    isEnabled: isEnabled,
    enable: enable,
    disable: disable,
    permissionLabel: permissionLabel,
    sendTestNotification: sendTestNotification,
    pushSupported: pushSupported,
    isPushSubscribed: function () {
      return pushSubscribed;
    },
    refreshPushState: refreshPushState,
  };

  function boot() {
    refreshPushState();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
