// Tiny service worker: lets notifications work on phones and focuses the app when tapped.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const channel = e.notification.data && e.notification.data.channel;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) {
          c.postMessage({ type: "open-chat", channel });
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow("./#chat");
    })
  );
});