# Mise en production (P1) — checklist Le Barbier de Carthage

1. **Serveur** : n’importe quel VPS (1 vCPU / 1 Go suffit). `curl -fsSL https://deb.nodesource.com/setup_22.x | bash && apt install nodejs` ou équivalent.
2. **Code** : `git clone … && cd barber-loyalty && npm ci`
3. **Utilisateur dédié** : `useradd -r -s /usr/sbin/nologin barbier && chown -R barbier:barbier /opt/barber-loyalty`
4. **Démarrage** : `cp deploy/barbier.service /etc/systemd/system && systemctl enable --now barbier`
5. **HTTPS** : installer Caddy (`apt install caddy`), copier `deploy/Caddyfile`, remplacer le domaine, `systemctl reload caddy`. TLS Let’s Encrypt est automatique.
6. **Sauvegardes** : cron quotidien `deploy/backup.sh` (30 j d’historique). Tester une restauration : `cp` d’un backup → `data/db.json` → `systemctl restart barbier`.
7. **PIN admin** : changez le PIN démo `1234` dès la première connexion (Réglages). 12 h de session, rate-limit 10 essais/min/IP.
8. **QR comptoir rotatif** : l’écran du comptoir (`/display`) affiche un QR signé (bucket 45 s + HMAC). Un QR photographié expire — l’anti-triche console-friendly.
9. **Push** : les notifications Web Push fonctionnent telles quelles sur HTTPS (VAPID auto-généré, stocké dans `data/db.json` — gardez-le en sauvegarde).
10. **RGPD / loi 2004-63** : registre des traitements côté salon ; suppression d’une fiche = bouton « ✕ » dans Clients (ou email).
11. **Migration SQLite** (quand volume > ~5 000 clients) : `better-sqlite3`, schéma identique à `data/db.json`. Une journée de travail, zéro changement d’API.
