// Minimal service worker so the page can be installed as an app.
// It caches nothing: every request goes to the network, so you always get the latest version.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
