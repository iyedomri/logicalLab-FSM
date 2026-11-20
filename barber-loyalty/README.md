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
| **Écran du comptoir (tablette)** | `http://localhost:3000/display` | libre — écran d’adhésion |
| **Poster QR à imprimer** | `http://localhost:3000/poster` | via l’espace admin |
| Rapport mensuel | admin → *Rapport mensuel* | imprimable en PDF |

`npm run reset` remet la base de démonstration à zéro. `npm run dev` lance avec rechargement automatique (`node --watch`). `PORT=8080 npm start` change le port.

**Parcours de démo conseillé** (3 min) :
1. Ouvrez `/` sur votre téléphone (ou dans un onglet mobile), saisissez nom + téléphone + votre anniversaire (essayez **aujourd’hui** !) → **vous recevez votre carte** (code type `MV6896`, QR personnel) avec votre code de parrainage.
2. **Le barbier** : ouvrez `/admin` (PIN `1234`) → **Clients** → **Scanner la carte** : visez le QR de la carte client — le tampon s’ajoute (ou cherchez le nom et touchez **+1 tampon**). Renouvelez ×9.
3. Carte complète → le bouton **Valider la coupe offerte** apparaît dans le scanner : le barbier valide, la carte est remise à zéro.
4. Touchez **« Je suis en route — garde la chaise »** (côté client) → votre barbier vous voit arriver côté admin.
5. Le fauteuil : voyez les créneaux **Occupé 11h00–11h45 · 15h30–17h30** (anonymes) sur la carte et l’écran de connexion. Touchez **Réserver** → prestation, jour, créneau libre (les créneaux pris sont grisés), notez « Forfait mariage… », cochez **Événement spécial** → la demande part **en attente**.
6. Ouvrez `/admin` → onglet **Réservations** → **À confirmer** : confirmez l’événement → le client est notifié + push. Testez la réservation manquée, l’annulation client, puis Réglages → changez les **jours de travail** et les **horaires** : tout le monde le voit instantanément.
7. **Vue d’ensemble** → *Relancer les inactifs* (2 clients de démo, 17 et 21 j) ; le **Journal des relances** suit qui est revenu — c’est le north-star. **Rapport mensuel** → imprimez-le (Imprimer → Enregistrer en PDF).
8. `/display` → l’écran du comptoir (tablette du salon) : QR d’adhésion + horloge. `/poster` → l’affiche A4 à imprimer.

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
1. Scanne le QR du comptoir (affiche/écran) → ouvre/rejoint sa carte.
2. Première visite : nom + téléphone (+ anniversaire facultatif) → carte créée, stockée sur l’appareil, code court `ABC123` + QR personnel.
3. **Le tampon est donné par le barbier, jamais par le client.** À chaque coupe, le barbier scanne le QR de la carte (admin → Clients → **Scanner la carte**) — ou touche +1.
4. À la caisse : la carte complète affiche « Votre coupe est offerte » ; le barbier valide depuis le scanner ou l’onglet Clients (**Offrir**) — la carte repart pour un tour.
5. S’il est absent 14 j : notification douce (« Votre chevelure s’impatiente… »). Une seule relance tous les 10 jours, jamais de spam.
6. Voit les **services & tarifs** et les **offres du moment** (Happy Hour, duo père-fils, parrainage…).

**Barbier** (`/admin`)
- **Vue d’ensemble** : clients inscrits, actifs 30 j, inactifs 14 j+, visites du jour, tampons distribués, coupes offertes, relances envoyées + relance en 1 clic avec message personnalisable.
- **Clients** : recherche (nom / tel / code), +1 tampon, validation d’une coupe offerte, suppression RGPD d’une fiche.
- **Services & tarifs** : CRUD complet, visibilité on/off — la carte client suit en direct.
- **Offres** : CRUD complet idem.
- **Réglages** : nom du salon, adresse, horaires (ouvert/fermé calculé en direct), objectif de tampons, récompense, délai anti-spam, seuil de relance, **PIN admin**.
- **Poster QR** : affiche A4 prête à imprimer (légal, sobre, aux couleurs du salon).

### 3bis. Nouveautés v2 (tout ce qui était « idées », maintenant livré)
- **Le tampon vient du barbier** : plus aucun tampon en libre-service — le QR du client ne sert qu’à l’identifier quand le barbier le scanne dans l’admin (caméra `jsQR` vendue localement, repli manuel par code à 6 caractères). Le bouton client « tamponner » et l’auto-validation ont disparu ; même la coupe offerte se valide côté barbier.
- **Anniversaire automatique** : la carte le détecte le jour J → notification + ruban « coupe à –50 % » sur la carte + (optionnel) web push. Une seule fois par an par client.
- **Parrainage** : chaque carte porte un code de parrainage ; nouveau client avec `?ref=CODE` ou via le formulaire → **+1 tampon pour lui, +1 pour le parrain**, notification de remerciement côté parrain. Partage natif via le presse-papier.
- **« Je suis en route »** : un tap sur la carte → le client apparaît côté admin (« En route vers le salon ») avec l’heure — le barbier prépare le fauteuil.
- **Web Push (VAPID)** : le client active les alertes depuis sa carte → relances & anniversaires arrivent même l’app fermée (HTTPS requis ; en local, `localhost` est un contexte sûr). Clés auto-générées, stockées dans `data/db.json`.
- **North-star mesuré** : *taux de retour des relancés* — qui a reçu « votre chevelure s’impatiente » puis est revenu. Visible dans Vue d’ensemble, le Rapport mensuel et le Journal des relances (avec Lue/Revenu).
- **Rapport mensuel imprimable** : visites du mois, nouveaux clients, récompenses, relances → retours, top habitués — Imprimer → Enregistrer en PDF.
- **Journal des relances** : les 10 dernières relances avec statut Lue / Revenu. Fini les relances à l’aveugle.
- **Artéfacts P1** : `deploy/Caddyfile` (HTTPS auto), `deploy/barbier.service` (systemd), `deploy/backup.sh` (cron quotidien, 30 j), `deploy/PRODUCTION.md` (checklist complète).

### 3ter. Réservations — le fauteuil se réserve comme une table
- **Côté client** : tout le monde voit le fauteuil en direct (créneaux occupés **anonymisés** — jamais de noms en public). Réservation par prestation (durée déduite des tarifs) ou « autre demande / événement », jour au choix (**aujourd’hui → +60 j**), **créneaux libres uniquement** (les pris sont grisés, délais minimum respectés, dimanche fermé si configuré). Confirmation immédiate pour une réservation normale ; **les événements (mariages…) restent « en attente » jusqu’à validation du barbier** — il rappelle pour caler les détails, puis le client est notifié + push. Code `RSV-XXXX`, bouton **« Ajouter au calendrier » (ICS avec rappel 30 min)**, liste **Mes réservations** avec annulation en 1 tap. Lié à la carte si elle existe, sinon nom + téléphone.
- **Côté admin** : onglet **Réservations** — Aujourd’hui / À venir / **À confirmer** (badge compteur dans la sidebar + Vue d’ensemble) / Historique. Actions : Confirmer (notifie le client), Terminer, Absent, Annuler, Supprimer. **Réservation téléphonique** en 20 secondes. La réservation manuelle est soumise aux mêmes règles de conflit.
- **Réglages → Réservations** : activer/couper la réservation en ligne (mode walk-in), capacité max/jour (0 = illimité), délai minimum avant réservation. **Réglages → jours de travail** (Dim…Sam) et **horaires d’ouverture/fermeture** (vraies heures) : le badge Ouvert/Fermé, le libellé d’horaires, les disponibilités et la réservation s’alignent instantanément. Horaires calculés depuis les jours (`Lun – Sam · 9h à 20h`).
- **Calendrier de démo** : Mehdi (Coupe+barbe, aujourd’hui 11h00), Forfait mariage (aujourd’hui 15h30, 2 h), Rami (prochain jour travaillé 10h30).

### 4. Anti-triche — le point sensible, traité sérieusement
| Risque | Parade démo | Parade production |
|---|---|---|
| Le client se tamponne seul depuis chez lui | **Impossible** — le client n’a aucun endpoint de tampon ; son QR ne fait qu’identifier, seul le barbier tamponne (scan caméra ou +1) | + validation de la coupe offerte côté caisse uniquement |
| Double compte même téléphone | Téléphone = identifiant unique | + OTP SMS/WhatsApp au premier scan |
| Relance spam | 1 relance / 10 j / client, stop si lu ou revenu | Web Push + désinscription en 1 tap |
| Vol de fiche client | Token 192 bits par carte, PIN admin, rate-limit | + HTTPS obligatoire, rotation PIN, 2FA |
| Fausse réservation / blocage de chaise | Max 4 réservations à venir par téléphone, rate-limit à la création, annulation 1 tap côté client, l’admin supprime | + OTP SMS à la création, rappel automatique J-1 (no-show −50%) |

### 5. Données (modèle JSON, persistance fichier atomique)
`data/db.json` (écrit via fichier temporaire + `rename`, crash-safe) :

```
shop          { nom, adresse, horaires, workingDays, openTime, closeTime, acceptReservations, maxPerDay, minNoticeMinutes, stampGoal, rewardLabel, reminderDays, adminPin }
clients[]     { id, name, phone (unique), code public, token secret, stamps, totalVisits,
                rewardsRedeemed, createdAt, lastVisitAt, lastReminderAt, birthday? }
visits[]      { clientId, at, via: counter|admin }            (journal, 500 derniers)
services[]    { name, desc, price, minutes, active }
offers[]      { title, desc, badge, active }
notifications[]{ clientId, title, body, kind, createdAt, readAt }
```

Aucune donnée superflue : pas d’email, pas d’adresse, pas de photo. Effacement sur demande à la caisse (bouton RGPD dans l’admin) ou par email.

### 6. API REST (JSON)

**Public** — `POST /api/join` (nom/tél/anniversaire/parrain) · `GET /api/card?token=` (déclenche aussi l’anniversaire du jour J) · `POST /api/onmyway` · `GET /api/notifications?token=` · `POST /api/notifications/read` · `GET /api/shop` · `GET /api/client-qr?token=` · `GET /api/push/key` · `POST /api/push/subscribe` · `GET /api/availability?date=` (créneaux occupés anonymes) · `GET /api/slots?date=&duration=` (créneaux libres) · `POST /api/reserve` (instantané si libre, pending si événement) · `GET /api/my-reservations?token=` · `POST /api/reservations/cancel`

**Admin** (header `x-admin-session`) — `POST /api/admin/login` · `GET /api/admin/overview` (stats + north-star relances + anniversaires + pings + journal + réservations du jour) · `GET /api/admin/report` · `GET /api/admin/clients?q=` · `POST /api/admin/stamp|redeem|stamp-by-code|redeem-by-code` (scan caméra) · `DELETE /api/admin/clients/:id` · CRUD `/api/admin/services[/:id]` · CRUD `/api/admin/offers[/:id]` · CRUD-ish `GET|POST|PUT|DELETE /api/admin/reservations` (filtres today/upcoming/pending/history ; confirmation → notification + push) · `POST /api/admin/remind-lapsed` (relance + **web push**) · `GET|PUT /api/admin/settings` (jours de travail, horaires, capacité réservations, walk-in) · `GET /api/counter-qr` (SVG, QR d’adhésion publique)

Rate-limiting mémoire sur `/api/join` (20/min/IP) et `/api/admin/login` (10/min/IP). Sessions admin 12 h en mémoire.

### 7. Choix techniques — et pourquoi
- **Node.js quasi zéro dépendance** (`qrcode` pour les QR, `web-push` pour VAPID) : le démo démarre partout, rien à compiler. Express/SQLite sont dans la roadmap si le volume l’exige.
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
| **P0 — démo** (ici) | QR comptoir, carte, tampons, coupe offerte, CRUD services/offres, relance +14 j, poster, **réservations en ligne + jours/horaires configurables** | Un barbier dit « je veux ça dans ma boutique » |
| **P1 — production** | ✅ HTTPS/systemd/backups/checklist (`deploy/`) · ⏳ SQLite/Postgres, domaine, logs structurés | Déployé chez le premier pilote |
| **P2 — le vrai plus** | ✅ Web Push (VAPID) + anniversaire auto + parrainage (+1 tampon) + rapport mensuel + north-star mesuré · ⏳ SMS de secours (Twilio), stats avancées (cohortes) | 30 % des inactifs relancés reviennent |
| **P3 — multi-salons** | Multi-boutiques, rôles (patron/barber), commissions par fauteuil, white-label (logo + couleurs par salon) | 3 salons abonnés |

**Idées « waouh » — statut** : ✅ bouton « Je suis en route, garde la chaise » (ping au barbier, visible en direct côté admin) · ✅ rapport mensuel imprimable · ⏳ carte de vœux manuscrite générée en image pour les anniversaires ; « le mur des habitués » (polaroids optionnels, consentement explicite).

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
│  ├─ admin.html             # espace barbier (Vue d’ensemble · Clients · Services · Offres · Rapport · Réglages)
│  ├─ display.html           # écran du comptoir (tablette) : adhésion + horloge
│  ├─ poster.html            # affiche QR A4 à imprimer
│  ├─ manifest.webmanifest · sw.js · icon.svg
│  ├─ css/style.css          # design system « green/cream/brass »
│  ├─ js/card.js · js/admin.js
│  └─ img/barbershop.jpg     # illustration d’en-tête sur mesure
├─ deploy/                   # P1 : Caddyfile HTTPS, barbier.service (systemd), backup.sh (cron), PRODUCTION.md
└─ README.md                 # ce fichier (le plan)
```

## Sécurité — ce que la démo montre et ce qu’elle ne prétend pas faire
✅ Rate-limit login/join · sessions admin éphémères · tokens cartes 192 bits · **tampon exclusivement barber-side** (le client ne détient aucun droit de tampon ; le QR carte n’expose que le code public) · VAPID pour le push · PIN modifiable · purge RGPD · `noindex` admin · HTTPS en production via Caddy (`deploy/`).
❌ Pas de TLS intégré, pas de chiffrement au repos, PIN en clair dans `db.json` → **démo locale uniquement** ; voir P1 pour la mise en production (Caddy/Let’s Encrypt, hash PIN bcrypt, SQLite chiffré ou Postgres, sauvegardes chiffrées).

---

*Conçu pour Le Barbier de Carthage, Avenue Habib Bourguiba, Tunis. Plan & code : 2026.*
