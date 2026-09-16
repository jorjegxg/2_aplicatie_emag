/* Service worker — Web Push în bara de notificări (telefon / desktop). */
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  var data = {
    title: "Comandă eMAG",
    body: "Ai o comandă nouă",
    tag: "emag-order",
    url: "/vanzari.html",
  };
  try {
    if (event.data) {
      var parsed = event.data.json();
      if (parsed && typeof parsed === "object") {
        data.title = parsed.title || data.title;
        data.body = parsed.body || data.body;
        data.tag = parsed.tag || data.tag;
        data.url = parsed.url || data.url;
      }
    }
  } catch (_) {
    try {
      var text = event.data && event.data.text();
      if (text) data.body = text;
    } catch (_) {
      /* ignore */
    }
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag,
      renotify: true,
      data: { url: data.url },
      requireInteraction: false,
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  var target = (event.notification.data && event.notification.data.url) || "/vanzari.html";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if ("focus" in client) {
          if (client.url && client.url.indexOf(target) !== -1) {
            return client.focus();
          }
          return client.focus().then(function () {
            if ("navigate" in client) return client.navigate(target);
          });
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
