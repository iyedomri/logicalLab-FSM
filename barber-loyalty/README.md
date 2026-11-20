# Le Barbier de Carthage — Carte de Fidélité

> **« Scannez, c’est votre carte. »** — fidélité sans application, sans compte, sans mot de passe.
> Un client scanne le QR code affiché au comptoir, crée sa carte en 30 secondes et collectionne ses tampons. **À la 10ᵉ visite, la coupe est offerte.** S’il ne repasse pas pendant 2 semaines, le salon lui envoie un petit mot : *« votre chevelure réclame le barbier »*.

Démo locale complète (client + administrateur + poster QR à imprimer) dans ce dossier.

---

## En une minute

```bash
cd barber-loyalty
npm install   # une seule dépendance : qrcode (génération de QR en SVG)
npm start     # → http://localhost:3000
```

| Écran | URL | Accès |
|---|---|---|
| **La carte (client)** | `http://localhost:3000/` | libre — c’est le QR du comptoir |
| **Espace barbier (admin)** | `http://localhost:3000/admin` | PIN démo : **1234** |
| **Poster QR à imprimer** | `http://localhost:3000/poster` | via l’espace admin |
| Poster QR dans `?scan=1` | `http://localhost:3000/?scan=1` | ce que le QR du comptoir ouvre |

`npm run reset` remet la base de démonstration à zéro. `npm run dev` lance avec rechargement automatique (`node --watch`). `PORT=8080 npm start` change le port.

**Parcours de démo conseillé** (2 min) :
1. Ouvrez `/` sur votre téléphone (ou dans un onglet mobile), saisissez nom + téléphone → **vous recevez votre carte** (code type `MV6896`, QR personnel).
2. Touchez **« Je suis au salon — tamponner »** (simule le scan du QR comptoir) → 1 tampon. Un second scan immédiat est refusé (anti-spam, 8 h).
3. Ouvrez `/admin` (PIN `1234`) → **Clients** : cherchez votre nom, ajoutez 9 tampons via **+1 tampon**, votre carte passe « coupe offerte » → cliquez **Offrir** à la caisse.
4. **Vue d’ensemble** → *Relancer les inactifs* : 2 clients de démo sont inactifs depuis 17 et 21 jours → envoyez la relance, leurs cartes recevront la notification.
5. `/poster` → imprimez l’affiche QR pour le comptoir.

---

## Le plan produit

### 1. Le problème
Les cartes papier se perdent, les apps de fidélité s’installent… jamais. Un barber shop vit de la récurrence : un client coupe tous les ~3 semaines. Il faut un objet **zéro friction** entre la chaise et le téléphone, et un outil de **relance** quand l’habitué disparaît.

### 2. La promesse (et ce qu’on ne fait PAS)
- **Pas d’application** à installer (validation marché : 99 % des clients refusent d’installer une app de fidélité inconnue).
- **Pas de compte** : le téléphone *est* l’identifiant, le numéro de téléphone retrouve la carte, un token secret garde la clé sur l’appareil.
- **Pas de mot de passe**, pas d’email, pas de formulaire interminable.
- Une seule chose à faire au comptoir : **scanner le QR**.

### 3. Les acteurs et leurs parcours

**Client** (`/`)
1. Scanne le QR du comptoir → `/?scan=1`.
2. Première visite : nom + téléphone (+ anniversaire facultatif) → carte créée, stockée sur l’appareil, code court `ABC123` + QR personnel.
3. À chaque coupe : un tampon. Le **10ᵉ cercle est un cadeau** ; la carte complète affiche « Votre coupe est offerte ».
4. À la caisse : il présente son écran, le barbier valide (ou le client scanne le QR comptoir, 1 tampon / 8 h dans la démo).
5. S’il est absent 14 j : notification douce (« Votre chevelure s’impatiente… »). Une seule relance tous les 10 jours, jamais de spam.
6. Voit les **services & tarifs** et les **offres du moment** (Happy Hour, duo père-fils, parrainage…).

**Barbier** (`/admin`)
- **Vue d’ensemble** : clients inscrits, actifs 30 j, inactifs 14 j+, visites du jour, tampons distribués, coupes offertes, relances envoyées + relance en 1 clic avec message personnalisable.
- **Clients** : recherche (nom / tel / code), +1 tampon, validation d’une coupe offerte, suppression RGPD d’une fiche.
- **Services & tarifs** : CRUD complet, visibilité on/off — la carte client suit en direct.
- **Offres** : CRUD complet idem.
- **Réglages** : nom du salon, adresse, horaires (ouvert/fermé calculé en direct), objectif de tampons, récompense, délai anti-spam, seuil de relance, **PIN admin**.
- **Poster QR** : affiche A4 prête à imprimer (légal, sobre, aux couleurs du salon).

### 4. Anti-triche — le point sensible, traité sérieusement
| Risque | Parade démo | Parade production |
|---|---|---|
| Le client se tamponne seul depuis chez lui | 1 tampon via QR comptoir / 8 h par client ; récompense validée par le barbier | **QR comptoir rotatif** (affiché sur un écran, token valable 45 s) ou validation barbier obligatoire (scan du QR personnel client) |
| Double compte même téléphone | Téléphone = identifiant unique | + OTP SMS/WhatsApp au premier scan |
| Relance spam | 1 relance / 10 j / client, stop si lu ou revenu | Web Push + désinscription en 1 tap |
| Vol de fiche client | Token 192 bits par carte, PIN admin, rate-limit | + HTTPS obligatoire, rotation PIN, 2FA |

### 5. Données (modèle JSON, persistance fichier atomique)
`data/db.json` (écrit via fichier temporaire + `rename`, crash-safe) :

```
shop          { nom, adresse, horaires, stampGoal, rewardLabel, scanCooldownHours, reminderDays, adminPin }
clients[]     { id, name, phone (unique), code public, token secret, stamps, totalVisits,
                rewardsRedeemed, createdAt, lastVisitAt, lastReminderAt, birthday? }
visits[]      { clientId, at, via: counter|admin }            (journal, 500 derniers)
services[]    { name, desc, price, minutes, active }
offers[]      { title, desc, badge, active }
notifications[]{ clientId, title, body, kind, createdAt, readAt }
```

Aucune donnée superflue : pas d’email, pas d’adresse, pas de photo. Effacement sur demande à la caisse (bouton RGPD dans l’admin) ou par email.

### 6. API REST (JSON)

**Public** — `POST /api/join` · `GET /api/card?token=` · `POST /api/stamp` (cooldown) · `POST /api/redeem` · `GET /api/notifications?token=` · `POST /api/notifications/read` · `GET /api/shop` (carte publique : salon + services + offres) · `GET /api/client-qr?token=` (SVG)

**Admin** (header `x-admin-session`) — `POST /api/admin/login` · `GET /api/admin/overview` · `GET /api/admin/clients?q=` · `POST /api/admin/stamp|redeem` · `DELETE /api/admin/clients/:id` · CRUD `/api/admin/services[/:id]` · CRUD `/api/admin/offers[/:id]` · `POST /api/admin/remind-lapsed` · `GET|PUT /api/admin/settings` · `GET /api/counter-qr` (SVG)

Rate-limiting mémoire sur `/api/join` (20/min/IP) et `/api/admin/login` (10/min/IP). Sessions admin 12 h en mémoire.

### 7. Choix techniques — et pourquoi
- **Node.js zéro dépendance** (hormis `qrcode`) : le démo démarre partout, rien à compiler, rien qui casse. Express/SQLite sont dans la roadmap si le volume l’exige.
- **Pages statiques + JS vanilla** : la carte doit charger instantanément en 3G devant la caisse. ~0 framework, tout est inspectable.
- **PWA légère** (`manifest` + service worker) : « Ajouter à l’écran d’accueil » donne une icône d’app, sans passer par un store. Offline : la carte reste consultable, les API partent au réseau.
- **Persistance JSON** : largement suffisant pour un salon (≈ milliers de clients) ; migration SQLite en one-liner quand besoin.

### 8. Design — « gentlemen’s barber », pas SaaS
Palette sur-mesure, aucune couleur « IA » :
- **Vert wagon** `#16301F` (fond), **crème papier** `#F6F1E7` (carte), **laiton** `#C2A04E` (accents, sceaux), **oxblood** `#7E3A2F` (le 10ᵉ cercle cadeau, le filet espiral du pole), **encre** `#26201A`.
- **Fraunces** (serif éditorial, esprit affiche d’enseigne) + **Karla** (sans chaleureux).
- Carte à **double filet laiton**, rosette guillochée en filigrane, divider **pole-spiral** oxblood/crème/vert, tampons effet cachet oblique, menu tarifaire en pointillés façon carte de salon des années 60.
- L’illustration de l’en-tête (fauteuil cuir, laiton, miroir ancien) est générée sur mesure — aucun stock photo.

### 9. Roadmap
| Phase | Contenu | Critère de sortie |
|---|---|---|
| **P0 — démo** (ici) | QR comptoir, carte, tampons, coupe offerte, CRUD services/offres, relance +14 j, poster | Un barbier dit « je veux ça dans ma boutique » |
| **P1 — production** | SQLite/Postgres, HTTPS (Caddy), QR rotatif 45 s, domaine (`carte.barbier.tn`), sauvegardes, logs | Déployé chez le premier pilote |
| **P2 — le vrai plus** | Web Push (VAPID) + SMS de secours (Twilio), OTP anti-triche, **anniversaire automatique** (jour J : coupe –50 % via lien unique), **parrainage** (+1 tampon par filleul), stats mensuelles (taux de retour, rédemptions, clients perdus) | 30 % des inactifs relancés reviennent |
| **P3 — multi-salons** | Multi-boutiques, rôles (patron/barber), commissions par fauteuil, white-label (logo + couleurs par salon) | 3 salons abonnés |

**Idées « waouh » assumées pour la suite** : carte de vœux manuscrite générée en image pour les anniversaires ; « le mur des habitués » (polaroids optionnels, consentement explicite) ; bouton « Je suis en route, garde-moi la chaise » (ping au barbier) ; rapport mensuel PDF automatique (« Ce mois-ci : 34 coupes offertes, 89 % de vos habitués sont revenus »).

### 10. Modèle économique (pistes)
- Abonnement salon : ~40–60 TND/mois (moins que le coût d’un shampoing professionnel par semaine) ; alternative : **15 TND/mois + 1 TND par coupe offerte validée**.
- Le poster QR + le kit de lancement (flyers, QR sticker caisse) facturés en option.
- Revenus annexes : notification sponsorisée (produit coiffant du fournisseur, max 1/mois, clairement identifiée).

### 11. Risques & parades
- **Adoption caissier** → la validation reste 1 tap ; onboardé le patron, pas l’équipe entière.
- **QR affiché = copiable** → rotation (production), et la récompense n’est jamais validable sans le barbier.
- **RGPD/loi 2004-63** → données minimales, export + suppression sur demande, registre des traitements tenu par le salon (responsable) / l’éditeur (sous-traitant).
- **Téléphone perdu** → la carte se restaure par numéro (simple renvoi du lien), le nouveau téléphone écrase le token.

### 12. KPIs de pilote
% de clients qui scannent (objectif ≥ 40 %) · tampons moyens/client/mois · taux de rédemption des coupes offertes · **% d’inactifs relancés revenant dans les 7 j** (north star) · visites supplémentaires / client et par an.

---

## Organisation du dépôt

```
barber-loyalty/
├─ server.js                 # API + static + QR (Node, zéro dépendance hors qrcode)
├─ package.json
├─ data/                     # db.json (créé au 1er lancement — git-ignoré)
├─ public/
│  ├─ index.html             # carte client (rejoindre → carte → QR perso)
│  ├─ admin.html             # espace barbier (login PIN → 5 modules)
│  ├─ poster.html            # affiche QR A4 à imprimer
│  ├─ manifest.webmanifest · sw.js · icon.svg
│  ├─ css/style.css          # design system « green/cream/brass »
│  ├─ js/card.js · js/admin.js
│  └─ img/barbershop.jpg     # illustration d’en-tête sur mesure
└─ README.md                 # ce fichier (le plan)
```

## Sécurité — ce que la démo montre et ce qu’elle ne prétend pas faire
✅ Rate-limit login/join · sessions admin éphémères · tokens cartes 192 bits · aucun secret côté client · PIN modifiable · purge RGPD · `noindex` admin · HTTPS laissé au reverse-proxy en production.
❌ Pas de TLS intégré, pas de chiffrement au repos, PIN en clair dans `db.json` → **démo locale uniquement** ; voir P1 pour la mise en production (Caddy/Let’s Encrypt, hash PIN bcrypt, SQLite chiffré ou Postgres, sauvegardes chiffrées).

---

*Conçu pour Le Barbier de Carthage, Avenue Habib Bourguiba, Tunis. Plan & code : 2026.*
