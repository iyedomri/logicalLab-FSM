# CarteBarber — la carte de fidélité des barbiers 🇹🇳

> **« Scannez, c’est votre carte. »** — fidélité sans application, sans compte, sans mot de passe.
> Un salon scanne le QR du comptoir, crée sa carte en 30 secondes et collectionne ses tampons. **À la 10ᵉ visite, la coupe est offerte.** S’il ne repasse pas pendant 2 semaines, le salon lui envoie un petit mot : *« votre chevelure réclame le barbier »*.
>
> **CarteBarber est une plateforme multi-salons** : vous vendez l’abonnement à n’importe quel barbier — chaque salon a son nom, son adresse, ses couleurs, ses clients, ses réservations. **Jamais les données d’un salon à l’autre ne se croisent.** Hébergé sur Vercel (Postgres), abonnement mensuel par salon.

---

## En une minute

```bash
cd barber-loyalty
npm install
npm start     # → http://localhost:3000
```

| Écran | URL | Accès |
|---|---|---|
| **Landing CarteBarber** (le vendeur) | `http://localhost:3000/` | public |
| **La carte — Le Barbier de Carthage** | `http://localhost:3000/s/carthage/` | public (QR du comptoir) |
| **Espace barbier — Carthage** | `http://localhost:3000/s/carthage/admin` | PIN démo : **1234** |
| **Écran du comptoir — Carthage** | `http://localhost:3000/s/carthage/display` | libre |
| **Poster A4 — Carthage** | `http://localhost:3000/s/carthage/poster` | via l’espace admin |
| **Royal Barber & Grooming** (2ᵉ démo, essai) | `http://localhost:3000/s/royalbarber/` | PIN démo : **royal1234** |
| **Super-admin** (le vendeur : salons, abonnements, MRR) | `http://localhost:3000/super` | PIN super : **super1234** (env `SUPER_ADMIN_PIN`) |

`npm run reset` remet la base de démonstration à zéro. `npm run dev` lance avec rechargement auto. `PORT=8080 npm start` change le port.

**Deux salons de démonstration** :
- **Le Barbier de Carthage** (`carthage`) — abonné actif, 40 DT/mois, données de démo complètes (6 habitués, services, offres, réservations, relances).
- **Royal Barber & Grooming** (`royalbarber`) — essai 14 jours, accent bordeaux, pour vérifier que tout est bien isolé.

**Parcours de démo conseillé** (3 min) :
1. Ouvrez `/s/carthage/` sur votre téléphone → créez votre carte (nom + téléphone ; essayez votre anniversaire **aujourd’hui** !) → vous recevez code `MV6896`-style + QR personnel + code parrain.
2. `/s/carthage/admin` (PIN `1234`) → **Clients** → **Scanner la carte** : visez le QR — le tampon s’ajoute (ou cherchez le nom → **+1 tampon**). Renouvelez ×9.
3. Carte pleine → bouton **Valider la coupe offerte** dans le scanner → la carte repart pour un tour.
4. Côté client, touchez **« Je suis en route — garde la chaise »** → le barbier vous voit arriver.
5. Même scénario sur `/s/royalbarber/` — aucun client de Carthage n’y apparaît : **isolation totale**.
6. `/super` → le cockpit vendeur : MRR, salons actifs/essai/en pause, essai qui expire bientôt, **+30 j payé**, pause, supprimer, créer un salon (nom → slug auto, PIN choisi). Créez « Barbier du Lac » : 20 secondes, le salon est en ligne, à ses couleurs.
7. **Le tampon vient du barbier** — partout : le client ne peut plus jamais se tamponner seul.

---

## Le modèle : SaaS par abonnement mensuel (Vercel)

Vous êtes **l’éditeur** (CarteBarber). Chaque barbier est **un client de l’abonnement**. Le code est unique ; les données sont isolées par salon (`slug`), côté serveur, sur **chaque requête** (`AsyncLocalStorage`) — il n’existe aucune route qui mélange deux salons.

### Ce que chaque barbier change, uniquement pour lui
Nom du salon · accroche · adresse · téléphone · devise · horaires (ouverture/fermeture) · jours de travail · réservations on/off · capacité max/jour · délai minimum · **objectif de tampons** · **récompense** (« Coupe offerte », « Barbe + coupe offerte »…) · jours avant relance · **couleur d’accent** (Or laiton / Bordeaux / Cognac / Acier) · **monogramme** (2–3 lettres) · son **PIN admin**.

Rien d’autre : pas d’image uploadée, pas de CSS custom — la marque reste « gentlemen’s barber », chaque salon dans ses couleurs.

### Cycle d’abonnement
```
essai 14 jours  ──(paie)──▶  actif 30 j  ──(+30 j)──▶  actif …
        │                        │
        └─ fin d’essai sans paiement ─▶  PAUSE  ◀── impayé 30 j ──┘
                                   │
                     salon verrouillé : page « abonnement en pause »
                     (paiement D17 affiché), API en 402
```
- **Vous** (super-admin, `/super`) encaissez et cliquez **+30 j payé** (ou *Rouvrir* si en pause). Contact support/commercial : **iyedomri922@gmail.com**.
- **Encaissement : D17** (mobile money, Tunisie) — le barbier envoie 40 DT/mois sur votre numéro D17 avec son nom de salon en référence ; vous cliquez *+30 j payé* à réception. **L’automatisation D17 (rapprochement des virements → +30 j auto) viendra plus tard** — D17 n’expose pas d’API publique aujourd’hui ; en attendant, l’encaissement est manuel : zéro frais, zéro dépendance, ~10 secondes par salon par mois.
- **Page de pause** : dès que `D17_NUMBER` est défini (variable d’environnement), elle affiche votre numéro D17 avec la consigne (« Envoyez 40 DT, nom du salon en référence »). Sans `D17_NUMBER`, elle n’affiche que l’email de contact. Un salon qui préfère la carte peut régler via un **lien Stripe Payment Link** (par salon dans `/super`, ou `PAYMENT_LINK` global) affiché en bouton « Régler par carte ».
- **Les relances d’échéance** et la page super listent les essais/périodes qui expirent sous 7 jours.
- **Stripe Billing + webhook** (`invoice.paid` → `POST /super/api/tenants/:id/pay`) : possible dès que vous avez un compte Stripe — il manque seulement la vérification de signature (30 min). **D17 automatisé** : à l’étude, sans date — voir *Roadmap P1*.

### Déploiement Vercel (cible officielle)
1. **Importez le repo** dans Vercel → *Root Directory* = `barber-loyalty`. Framework preset : **Other**. Aucune commande de build.
2. **Vercel → Storage → Postgres** (ou Neon) → *Connect* : la variable **`POSTGRES_URL`** est injectée automatiquement.
3. Variables d’environnement :
   - `SUPER_ADMIN_PIN` — le PIN du cockpit vendeur (défaut démo `super1234`, **changez-le**).
   - `SEED_DEMO=false` — optionnel : démarre sans les 2 salons de démo (production vierge).
   - `D17_NUMBER` — **votre numéro D17** (mobile money), affiché sur la page de pause avec la consigne de paiement. Sans lui, la pause n’affiche que l’email de contact.
   - `PAYMENT_LINK` — optionnel : lien Stripe Payment Link affiché en bouton « Régler par carte » sur la page de pause (défaut global ; chaque salon peut avoir le sien dans `/super`).
4. **Deploy**. C’est tout : `vercel.json` redirige tout vers la fonction `api/index.js` ; les pages, assets et API tournent sous `/s/<slug>/…`. `POSTGRES_URL` absent → 500 explicite sur les routes dynamiques (le statique, dont la landing, reste servi).

Une **ligne Postgres** (`barbier_kv.platform`, jsonb) tient toute la plateforme (≈ quelques centaines de Ko pour des dizaines de salons). Chaque requête dynamique recharge la ligne, chaque écriture la sauve (read-modify-write ; parfait à l’échelle d’un réseau de salons — pas de verrous distribués, dernier écrivain gagne).

**Auto-hébergement** (VPS, `npm start`) : sans `POSTGRES_URL`, tout tourne en fichier `data/db.json` comme avant — zéro régression.

---

## Sécurité & isolation — ce qui est garanti
- ✅ **Isolation stricte** : chaque requête salon transporte son `AsyncLocalStorage` ; le store (clients/services/…) est résolu par `slug` → **un PIN du salon A ne vaut rien au salon B**, les tokens de carte aussi (vérifié par tests curl).
- ✅ **PIN admin hashés** (scrypt + sel) depuis la v5 — `db.json` ne contient plus aucun PIN.
- ✅ Tampon **exclusivement barber-side** ; QR client = identité, jamais un droit de se tamponner.
- ✅ Rate-limit mémoire (`/api/join` 20/min, `/api/admin/login` 10/min) · sessions admin 12 h **liées au salon** · token carte 192 bits · `noindex` admin · `/super` cachée des moteurs.
- ✅ Page de pause : tout le salon (clients **et** barbier) est verrouillé quand l’abonnement n’est pas à jour — c’est ce qui fait tourner le modèle.
- ❌ Pas de chiffrement au repos, pas d’OTP SMS, pas de D17/Stripe automatisé (voir *Roadmap P1*) — gardez `POSTGRES_URL` secret, tournez le `SUPER_ADMIN_PIN`, sauvegardez la base.

---

## Le plan produit (inchangé, plateforme en plus)

### 1. Le problème
Les cartes papier se perdent, les apps de fidélité s’installent… jamais. Un barber shop vit de la récurrence : un client coupe tous les ~3 semaines. Il faut un objet **zéro friction** entre la chaise et le téléphone, et un outil de **relance** quand l’habitué disparaît — vendu à **chaque** barbier, à l’échelle du pays.

### 2. La promesse (et ce qu’on ne fait PAS)
- **Pas d’application** à installer. **Pas de compte** : le téléphone *est* l’identifiant. **Pas de mot de passe**.
- Une seule chose à faire au comptoir : **scanner le QR**.

### 3. Les acteurs et leurs parcours

**Client** (`/s/<slug>/`)
1. Scanne le QR du comptoir → crée sa carte en 30 s (téléphone = identifiant, token secret sur l’appareil).
2. **Le tampon est donné par le barbier, jamais par le client.** À chaque coupe, le barbier scanne le QR (admin → **Scanner la carte**) — caméra `jsQR`, ou +1, ou code manuel 6 caractères.
3. Carte pleine → « Votre coupe est offerte » — le barbier valide depuis le scanner ou les Clients (**Offrir**).
4. 14 j sans visite → notification douce (« Votre chevelure s’impatiente… »). 1 relance / 10 j max, jamais de spam.
5. Voir les **services & tarifs**, les **offres du moment**, réserver le fauteuil (créneaux anonymes occupés), **« Je suis en route — garde la chaise »**, gérer ses notifications push.

**Barbier** (`/s/<slug>/admin`) — Vue d’ensemble (stats, north-star relances, anniversaires, pings, en route, journal) · Clients (recherche, +1, offrir, purge RGPD) · Réservations (aujourd’hui / à venir / à confirmer / historique, réservation téléphone) · Services & tarifs · Offres · **Rapport mensuel imprimable** · **Réglages** (identité complète, couleurs, monogramme, PIN, réservations, horaires, relance).

**Vendeur** (`/super`) — créer/pauser/rouvrir/supprimer un salon, MRR, compteurs, essais qui expirent.

### 3bis. Livré — et maintenant multi-salons
- **Le tampon vient du barbier** (v4) — client read-only, validation de la coupe par le barbier. ✅
- **Plateforme multi-salons** (v5) — isolation par tenant, `/s/<slug>/`, super-admin, MRR, essai → actif → pause, Vercel/Postgres. ✅
- Anniversaire automatique · parrainage (+1 tampon) · Web Push VAPID · « Je suis en route » · rapport mensuel imprimable · north-star relances mesuré · réservations en ligne avec confirmation événements (mariages) · écran comptoir + poster A4 · couleurs par salon. ✅

### 3ter. Réservations — le fauteuil se réserve comme une table
- **Client** : fauteuil en direct (créneaux occupés **anonymisés**), créneaux libres uniquement, événement = *En attente* jusqu’à validation barbier, `RSV-XXXX` + ICS (rappel 30 min), annulation 1 tap.
- **Barbier** : Aujourd’hui / À venir / À confirmer (badge) / Historique. Réservation téléphone en 20 s (mêmes règles de conflit).
- **Réglages → Réservations** : walk-in uniquement, max/jour, délai minimum, jours de travail, horaires.
- **Démo** : Mehdi (auj. 11h00), Forfait mariage (auj. 15h30), Rami (prochain jour travaillé 10h30).

### 4. Anti-triche
| Risque | Parade |
|---|---|
| Le client se tamponne seul | **Impossible** : aucun endpoint de tampon côté client — son QR ne fait qu’identifier, seul le barbier tamponne (scan ou +1) |
| Double compte même téléphone | Téléphone = identifiant unique par salon |
| Relance spam | 1 relance / 10 j / client, stop si lu ou revenu |
| Vol de fiche client | Token 192 bits + session admin liée au salon + PIN hashé scrypt + rate-limit |
| Fausse réservation | Max 4 réservations à venir / téléphone, rate-limit, annulation 1 tap, suppression admin |
| Un salon voit les données d’un autre | **Architecture tenant** (`AsyncLocalStorage` + slug), tests d’isolation curl dans la CI de démo |

### 5. Données (v5, modèle plateforme)
```
platform      { version:5, tenants[], stores{}, vapid }
tenants[]     { id, slug, name, tagline, address, phone, currency,
                openTime, closeTime, workingDays[], acceptReservations, maxPerDay,
                minNoticeMinutes, stampGoal, rewardLabel, reminderDays,
                adminPinHash (scrypt), accent, monogram,
                status: trial|active|paused, trialEndsAt, currentPeriodEnd,
                monthlyPrice, paymentLink, createdAt, notes }
stores{tenantId} = {
  shop (→ tenant)     # réglages + marque vivent dans le tenant
  clients[] · visits[] · services[] · offers[] · notifications[] · reservations[] · pings[]
  counters { stampsIssued, rewardsRedeemed, remindersSent } }
```
Persistance : `data/db.json` (atomique tmp+rename) **ou** Postgres single-row `barbier_kv` (dès que `POSTGRES_URL` est défini). Migration automatique v1 → v5 au premier démarrage (le shop historique devient le salon `carthage`, actif).

### 6. API REST (toutes sous `/s/<slug>/`)

**Public** — `POST /api/join` · `GET /api/card?token=` (anniversaire jour J inclus) · `POST /api/onmyway` · `GET /api/notifications?token=` · `POST /api/notifications/read` · `GET /api/shop` (marque incluse) · `GET /api/client-qr?token=` · `GET /api/push/key` · `POST /api/push/subscribe` · `GET /api/availability?date=` · `GET /api/slots?date=&duration=` · `POST /api/reserve` · `GET /api/my-reservations?token=` · `POST /api/reservations/cancel` · `GET /api/counter-qr` (SVG QR d’adhésion)

**Admin** (header `x-admin-session`, session liée au salon) — `POST /api/admin/login` · `GET /api/admin/overview` · `GET /api/admin/report` · `GET /api/admin/clients?q=` · `POST /api/admin/stamp|redeem|stamp-by-code|redeem-by-code` · `DELETE /api/admin/clients/:id` · CRUD `/api/admin/services[/:id]` · CRUD `/api/admin/offers[/:id]` · CRUD `/api/admin/reservations[/:id]` · `POST /api/admin/remind-lapsed` · `GET|PUT /api/admin/settings` (identité, accent, monogramme, devise, PIN) · `GET /api/admin/settings` renvoie aussi `accents` disponibles

**Super-admin** (header `x-super-session`, `/super` uniquement) — `POST /super/api/login` · `GET /super/api/overview` (MRR, compteurs, essais < 7 j) · `POST /super/api/tenants` (créer salon) · `GET|POST /super/api/tenants/:id[/pay|pause|resume|delete]`

### 7. Choix techniques — et pourquoi
- **Node quasi zéro dépendance** (`qrcode`, `web-push`, `pg` optionnel) : démarre partout, rien à compiler.
- **Statique + JS vanilla** : la carte charge instantanément en 3G devant la caisse. Toutes les pages injectent la marque par tenant côté serveur (`{{PLACEHOLDERS}}`) — aucun recalcul client, aucun flash de marque étrangère.
- **AsyncLocalStorage** pour transporter le tenant : zéro prop-drilling, zéro fuite possible entre salons (échec bruyant hors contexte).
- **PWA** (manifest par tenant + sw) : « Ajouter à l’écran d’accueil », icône d’app sans store.
- **Un seul process, un seul fichier de données** en mode fichier ; **une ligne Postgres** en mode Vercel. La simplicité est le produit.

### 8. Design — « gentlemen’s barber », pas SaaS
Palette sur-mesure, aucune couleur « IA » : vert wagon `#16301F`, crème `#F6F1E7`, laiton `#C2A04E` (ou **Bordeaux/Cognac/Acier** au choix du salon), oxblood `#7E3A2F`, encre `#26201A`. **Fraunces** (serif enseigne) + **Karla**. Double filet laiton, rosette guillochée, pole-spiral, tampons cachet oblique. Illustration d’en-tête générée sur mesure. Les 4 accents sont des teintes laiton-famille — jamais de violet/bleu générique.

### 9. Roadmap
| Phase | Contenu | Statut |
|---|---|---|
| **P0 — démo** | QR comptoir, carte, tampons barber-side, coupe offerte, CRUD, relance, réservations en ligne | ✅ livré |
| **P1 — production** | ✅ Caddyfile/systemd/backups/checklist · ✅ D17 documenté (`D17_NUMBER`, encaissement manuel) · ⏳ **Automatisation D17** (rapprochement → +30 j auto) · ⏳ Stripe webhook → +30 j automatique · ⏳ domaine, logs structurés | en cours |
| **P2** | ✅ Web Push + anniversaire + parrainage + rapport + north-star | livré |
| **P3 — multi-salons** | ✅ **SaaS multi-tenant, abonnement mensuel, essai → actif → pause, super-admin vendeur, Vercel + Postgres** | **livré (v5)** |
| **P4 — croissance** | ⏳ Rôles (patron/barbier) par salon, stats cohortes multi-salons, SMS Twilio, white-label total (logo upload), domaine custom par salon | — |

### 10. Modèle économique
- **Abonnement salon : 40 DT/mois** (configurable par salon dans `/super`), essai 14 jours sans carte.
  « Moins qu’un shampoing pro par semaine » — le barbier l’amortit avec une coupe offerte tous les 10 passages.
- **Encaissement : D17** (mobile money, virements vers votre numéro D17) — le barbier règle chaque mois depuis son téléphone, comme un virement entre particuliers ; vous validez dans `/super`. Support/commercial : **iyedomri922@gmail.com**.
- Les relances d’impayés et la création de salon se font par email/WhatsApp — au volume actuel, c’est plus rapide et plus efficace qu’un robot. Salons qui préfèrent la carte : lien Stripe Payment Link (bouton sur la page de pause).
- **À terme** : automatisation D17 (détection des virements → +30 j automatique) et/ou Stripe Billing — la page de pause affiche les deux canaux dès que `D17_NUMBER` / `PAYMENT_LINK` sont définis.
- Options : poster + kit de lancement (sticker QR caisse) facturés à l’installation · éventuellement 1 DT/coupe offerte validée.
- Le coût marginal par salon ≈ 0 (une ligne de base de données) → la marge est la valeur du réseau.

### 11. Risques & parades
- **Adoption caissier** → la validation reste 1 tap ; onboarder le patron d’abord.
- **Salon qui ne paie plus** → la pause est automatique en fin de période ; la page de pause affiche le lien de paiement ; relance par vous.
- **Données perdues** → sauvegarde cron (`data/db.json`) ou `pg_dump` ; une ligne = tout l’état, export trivial.
- **Téléphone perdu** → la carte se restaure par numéro ; nouveau téléphone écrase le token.
- **RGPD / loi 2004-63** → données minimales ; purge bouton admin ; registre des traitements côté salon.

### 12. KPIs de pilote
% de clients du salon qui scannent (≥ 40 %) · tampons moyens/client/mois · taux de rédemption · **% d’inactifs relancés revenant sous 7 j** (north star) · **MRR & churn mensuel des salons** (côté vendeur, `/super`).

---

## Organisation du dépôt

```
barber-loyalty/
├─ server.js                 # Plateforme : API tenant + super-admin + static + pages injectées
├─ vercel.json               # Tout → /api/index (Vercel), Postgres via POSTGRES_URL
├─ api/index.js              # Entry serverless : recharge la plateforme depuis Postgres par requête
├─ package.json              # pg inclus (optionnel en local, requis sur Vercel)
├─ data/db.json              # v5 : la plateforme entière (créé au 1er lancement — git-ignoré)
├─ public/
│  ├─ landing.html           # Page vendeur CarteBarber (pitch, prix, salons équipés)
│  ├─ paywall.html           # Page « abonnement en pause » ({{D17_BLOCK}} · {{STRIPE_BUTTON}})
│  ├─ super.html             # Cockpit vendeur : salons, MRR, essai/pause/+30 j
│  ├─ index.html             # La carte (liens `{{API_BASE}}`, marque `{{SHOP_NAME}}…`)
│  ├─ admin.html             # Espace barbier (réglages identité : accent, monogramme, devise…)
│  ├─ display.html · poster.html
│  ├─ css/style.css          # Design system « green/cream/brass » + accents par salon
│  └─ js/card.js · js/admin.js   # fetch préfixé par window.__API_BASE__
├─ deploy/                   # Caddyfile HTTPS, barbier.service, backup.sh, PRODUCTION.md
└─ README.md                 # ce fichier
```

*Conçu par CarteBarber · Tunis — 2026. Le Barbier de Carthage est le salon pilote.*
