# Mise en production — CarteBarber (SaaS multi-salons)

Deux cibles officielles : **Vercel** (recommandée, avec Postgres) ou **VPS** (auto-hébergé, fichier `data/db.json`).

---

## A. Vercel (cible officielle)

1. **Repo → Vercel** → Import du dépôt → **Root Directory : `barber-loyalty`** → Framework Preset : **Other** → Build command : *(vide)* → Output : *(par défaut)*.
2. **Postgres** : Vercel → Storage → Create Database → Postgres (ou Neon) → connecté au projet → **`POSTGRES_URL`** injectée automatiquement (sinon : Settings → Environment Variables).
3. Variables d’environnement (Production) :
   - `SUPER_ADMIN_PIN` — **obligatoire, changez-le** (défaut démo : `super1234`).
   - `SEED_DEMO=false` — démarre sur une plateforme vierge (aucun salon) ; sinon les 2 salons de démo (`carthage` actif, `royalbarber` essai) sont créés au premier accès.
   - `PAYMENT_LINK` — lien Stripe Payment Link affiché sur la page de pause par défaut (chaque salon peut avoir le sien dans `/super`).
4. **Deploy**. Done. Les URLs : `/s/<slug>/` par salon, `/super` pour le vendeur, `/` la landing.
5. **Domaine** : Vercel → Domains → `cartebarber.tn` (ou autre) → DNS chez votre registrar. Pas besoin de wildcard (le routage est par chemin `/s/<slug>`, pas par sous-domaine).
6. **Stripe (encaissement mensuel, manuel)** :
   1. Stripe Dashboard → Payment Links → créez un lien « 40 DT/mois — CarteBarber » (récurrent si vous avez les prix Stripe Billing ; sinon paiement unique + vous cliquez *+30 j* chaque mois).
   2. Dans `/super`, collez ce lien dans **Lien de paiement** du salon (ou `PAYMENT_LINK` global).
   3. À réception du paiement, ouvrez `/super` → **+30 j payé**. Le salon repart pour 30 jours.
7. **Stripe (automatique, plus tard)** : Stripe Billing (abonnement réel) → webhook `invoice.paid` → votre endpoint `POST /super/api/tenants/:id/pay` protégé par un secret partagé. Non livré : nécessite vos clés Stripe — l’endpoint existe déjà, il manque seulement la vérification de signature webhook (30 min le jour où vous créez l’endpoint Stripe).
8. **Coût** : Vercel Hobby/Pro + Postgres gratuit (Neon/Vercel Postgres free tier) — un ou deux salons suffisent pour amortir.
9. **Sauvegardes** : Vercel Postgres → onglet *Backups* (snapshots quotidiens selon plan) ou cron `pg_dump "$POSTGRES_URL" > backup.sql`. Toute la plateforme tient dans une ligne jsonb — l’export est trivial : `SELECT value FROM barbier_kv WHERE key='platform'`.
10. **Réinitialiser la démo** : Vercel → Storage → Postgres → *Data* → supprimer la ligne `barbier_kv` → redeploy/requests suivantes re-seedent (si `SEED_DEMO` ≠ false).

## B. VPS (auto-hébergé)

1. **Serveur** : n’importe quel VPS (1 vCPU / 1 Go suffit pour des dizaines de salons). `apt install nodejs` (22+).
2. `git clone … && cd barber-loyalty && npm ci`
3. **Utilisateur dédié** : `useradd -r barbier && chown -R barbier:barbier .`
4. `cp deploy/barbier.service /etc/systemd/system && systemctl enable --now barbier`
5. **HTTPS** : Caddy (`deploy/Caddyfile`, domaine à remplacer) ou Nginx — TLS Let’s Encrypt auto.
6. **`SUPER_ADMIN_PIN`** dans `Environment=` du service ou un EnvironmentFile — sinon la démo `super1234` reste valide.
7. **Sauvegardes** : cron quotidien `deploy/backup.sh` (30 j). Restauration : copier le backup → `data/db.json` → `systemctl restart barbier`.
8. **Migration v1 → v5 automatique** au premier démarrage : le salon historique devient `carthage` (statut actif, PIN conservé en hash scrypt). Gardez une copie de `db.json` avant migration.
9. `npm run reset` : efface `data/db.json` → la démo (2 salons) se recrée au prochain démarrage.
10. **Régénérer les VAPID** : supprimer la clé `vapid` de la base → le serveur en génère de nouvelles au démarrage (les anciennes souscriptions push deviennent invalides).

## C. Après l’ouverture du premier salon

1. `/super` → **Ouvrir un nouveau salon** : nom → slug auto → PIN (ou auto 6 chiffres) → prix/mois → créer. **< 30 secondes.**
2. Donnez au barbier : `https://<domaine>/s/<slug>/admin` + son PIN. Il change son PIN, son adresse, ses couleurs, ses services.
3. Il imprime son poster (`/s/<slug>/poster`), affiche `/s/<slug>/display` sur la tablette du comptoir.
4. Fin d’essai sans paiement → `/super` → **Pause** (ou attente de la fin de période, le salon se verrouille avec la page de paiement).
5. Paiement → **+30 j payé**.
6. **Supprimer** = suppression définitive du salon et de toutes ses données (demandes RGPD incl.).

## D. Exploitation — les points de vigilance

- **Sessions** admin 12 h, liées au salon ; super-admin séparé. 12 h puis re-PIN.
- **Le tampon vient du barbier** : aucune API client ne peut tamponner — permanence architecturale v4→v5.
- **PIN** : hash scrypt+sel — le `db.json`/la base Postgres ne contient plus de PIN. Tournez `SUPER_ADMIN_PIN` si compromis.
- **Rate-limit** mémoire : 10 login/min/IP. Sur Vercel, chaque lambda a son compteur — compléter par Vercel WAF si abus constaté.
- **RGPD / loi 2004-63** : la fiche client se supprime en 1 tap côté admin ; registre des traitements côté salon ; CarteBarber = sous-traitant.
- **Fuseau horaire** : `TZ=Africa/Tunis` dans `npm start` ; les créneaux/jours logiques collent au pays. Sous Vercel, le fuseau est UTC — passez `TZ=Africa/Tunis` en variable d’environnement Vercel (les fonctions la respectent).
- **Coût marginal par salon ≈ 0** : une ligne jsonb, quelques Ko. La marge est le réseau.
