/* Notificările de comenzi au fost scoase (le dă Base / aplicația eMAG): service worker-ul vechi se dezinstalează singur. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    self.registration.unregister().then(() => self.clients.matchAll()).then((clients) => {
      for (const client of clients) client.navigate(client.url);
    })
  );
});
