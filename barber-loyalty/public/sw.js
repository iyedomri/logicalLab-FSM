/* Service worker — Web Push (relances & anniversaire).
   IMPORTANT : réseau uniquement. Aucune mise en cache : les pages/API sont no-store,
   l’ancien SW (v2/v3) servait des réponses périmées (dont « Introuvable ») aux navigateurs
   marqués « installés ». La v4 supprime TOUT cache puis ne met plus jamais rien en cache. */
const CACHE = 'barbier-v4'; // conservé uniquement pour purger les anciens
self.addEventListener('install', (e) => { e.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))   // purge brutale de tout ancien cache
      .then(() => self.clients.claim())
  );
});
// Aucune interception réseau : 100% network — impossible de servir une réponse périmée.
/* Web Push : relance « votre chevelure s'impatiente », anniversaire… */
self.addEventListener('push', (e) => {
  let data = { title: 'CarteBarber', body: 'Votre chevelure réclame le barbier.' };
  try { if (e.data) data = Object.assign(data, e.data.json()); } catch { try { data.body = e.data.text(); } catch {} }
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: 'barbier-notif',
    renotify: true,
    data: { url: (data && data.url) || '/' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const client of list) { if ('focus' in client) { client.navigate(target); return client.focus(); } }
    return clients.openWindow(target);
  }));
});
