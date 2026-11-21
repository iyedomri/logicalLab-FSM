/**
 * CarteBarber — plateforme multi-salons de carte de fidélité
 * Serveur Node.js zéro-dépendance (sauf `qrcode`), persistance fichier JSON atomique.
 * Lancer :  npm install && npm start   →   http://localhost:3000
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const webpush = require('web-push');
const { AsyncLocalStorage } = require('async_hooks');

const PORT = process.env.PORT || 3000;
const SUPER_ADMIN_PIN = process.env.SUPER_ADMIN_PIN || 'super1234'; // à CHANGER en production
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

/* ---------------------------------------------------------------- utils */
const now = () => Date.now();
const isoIn = (days) => new Date(Date.now() - days * 864e5).toISOString();
const uid = (p = 'id') => `${p}_${crypto.randomBytes(9).toString('hex')}`;
const publicCode = () => {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sans I, L, O, 0, 1
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[crypto.randomInt(alphabet.length)];
  return s;
};
const normPhone = (p) => String(p || '').replace(/[^\d+]/g, '');
const validPhone = (p) => /^\+?\d{6,15}$/.test(p);
const esc = (s) => String(s ?? '');
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));


/* ---------- réservations : temps & conflits ---------- */
const timeToMin = (t) => { const [h, m] = String(t).split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const minToTime = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
const localDateStr = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const DAY_NAMES_FR = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
const workingDays = () => (Array.isArray(db.shop.workingDays) && db.shop.workingDays.length ? db.shop.workingDays : [1, 2, 3, 4, 5, 6]);
const isWorkingDay = (dateStr) => workingDays().includes(new Date(dateStr + 'T12:00:00').getDay());
const reservationsOn = (dateStr) => db.reservations.filter(r => r.date === dateStr && r.status !== 'cancelled');
const intervalsOverlap = (aS, aE, bS, bE) => aS < bE && bS < aE;
function busyIntervals(dateStr) {
  return reservationsOn(dateStr)
    .map(r => ({ from: timeToMin(r.time), to: timeToMin(r.endTime), type: r.type }))
    .sort((a, b) => a.from - b.from);
}
function mergedBusy(dateStr) {
  const ints = busyIntervals(dateStr);
  const merged = [];
  for (const iv of ints) {
    const last = merged[merged.length - 1];
    if (last && iv.from <= last.to) last.to = Math.max(last.to, iv.to);
    else merged.push({ from: iv.from, to: iv.to });
  }
  return merged.map(m => ({ from: minToTime(m.from), to: minToTime(m.to) }));
}
function slotList(dateStr, durationMin, nowOffsetMin = 0) {
  if (!isWorkingDay(dateStr)) return [];
  const open = timeToMin(db.shop.openTime || '09:00');
  const close = timeToMin(db.shop.closeTime || '20:00');
  const busy = busyIntervals(dateStr);
  const isToday = dateStr === localDateStr();
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes() + (db.shop.minNoticeMinutes || 0) + nowOffsetMin;
  const slots = [];
  for (let t = open; t + durationMin <= close; t += 30) {
    if (isToday && t < nowMin) continue; // trop tard / délai minimum
    const clash = busy.some(iv => intervalsOverlap(t, t + durationMin, iv.from, iv.to));
    slots.push({ time: minToTime(t), available: !clash });
  }
  return slots;
}
function canFit(dateStr, timeStr, durationMin) {
  if (!isWorkingDay(dateStr)) return { ok: false, reason: 'Le salon est fermé ce jour-là.' };
  const open = timeToMin(db.shop.openTime || '09:00');
  const close = timeToMin(db.shop.closeTime || '20:00');
  const start = timeToMin(timeStr);
  if (start < open || start + durationMin > close) return { ok: false, reason: 'Hors horaires d’ouverture.' };
  const maxPerDay = Number(db.shop.maxPerDay) || 0;
  if (maxPerDay > 0 && reservationsOn(dateStr).length >= maxPerDay) return { ok: false, reason: 'Complet ce jour-là — le fauteuil ne fait que se prélasser.' };
  const clash = busyIntervals(dateStr).some(iv => intervalsOverlap(start, start + durationMin, iv.from, iv.to));
  if (clash) return { ok: false, reason: 'Ce créneau est déjà pris.' };
  if (dateStr === localDateStr()) {
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes() + (db.shop.minNoticeMinutes || 0);
    if (start < nowMin) return { ok: false, reason: 'Ce créneau est passé ou trop proche (délai minimum requis).' };
  }
  return { ok: true };
}
const rsvCode = () => 'RSV-' + publicCode();

function seedReservations(dbx) {
  const wd = (dbx.shop && Array.isArray(dbx.shop.workingDays) && dbx.shop.workingDays.length ? dbx.shop.workingDays : [1, 2, 3, 4, 5, 6]);
  const today = localDateStr();
  const d2 = new Date(Date.now() + 864e5);
  while (!wd.includes(d2.getDay())) d2.setDate(d2.getDate() + 1); // prochain jour travaillé
  const tomorrow = localDateStr(d2);
  const at = (date, time) => ({ date, time });
  const mkR = (name, phone, serviceName, date, time, durationMin, type, notes, status, clientLinked) => ({
    id: uid('rsv'), code: rsvCode(), clientId: clientLinked || null,
    name, phone, serviceId: null, serviceName,
    ...at(date, time),
    durationMin, endTime: minToTime(timeToMin(time) + durationMin),
    type, notes, status, createdAt: new Date().toISOString(),
  });
  dbx.reservations = [
    mkR('Mehdi Ben Salah', '+21655667788', 'Coupe + barbe', today, '11:00', 45, 'normal', '', 'confirmed', null),
    mkR('Karim Ben Ammar', '+21699887766', 'Forfait mariage', today, '15:30', 120, 'event', 'Mariage samedi — essai barbe + coupe pour le jour J, puis 2 témoins le matin.', 'confirmed', null),
    mkR('Rami Gharbi', '+21650998877', 'Taille de barbe', tomorrow, '10:30', 20, 'normal', '', 'confirmed', null),
  ];
  delete dbx.___seedReservations;
}

/* ============================================ PLATEFORME MULTI-TENANT
   Une install · N salons · données isolées par AsyncLocalStorage.
   Persistance : fichier JSON (défaut) OU Postgres single-row (dès que
   POSTGRES_URL est défini — cible Vercel, persistance en fin de requête). */
const IS_PG = !!process.env.POSTGRES_URL;
const SEED_DEMO = process.env.SEED_DEMO !== 'false';
const PLATFORM_VERSION = 5;
const als = new AsyncLocalStorage();
const DB = () => als.getStore();
const db = new Proxy({}, {
  get: (_, prop) => {
    const store = DB();
    if (!store) throw new Error('Accès hors contexte salon (' + String(prop) + ')');
    return store[prop];
  },
  set: (_, prop, value) => { DB()[prop] = value; return true; },
});

/* ---------- hash de PIN (scrypt, zéro dépendance) ---------- */
const scryptHash = (pin) => {
  const salt = crypto.randomBytes(16).toString('hex');
  return 'scrypt:' + salt + ':' + crypto.scryptSync(String(pin), salt, 64).toString('hex');
};
const scryptCheck = (pin, stored) => {
  const parts = String(stored || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const h = crypto.scryptSync(String(pin), parts[1], 64).toString('hex');
  return parts[2].length === h.length && crypto.timingSafeEqual(Buffer.from(parts[2]), Buffer.from(h));
};

/* ---------- accents de marque curatés (aucun violet « IA ») ---------- */
const ACCENTS = {
  brass:    { base: '#C2A04E', dark: '#A8843A', light: '#E3C878', label: 'Or laiton' },
  bordeaux: { base: '#9E5A4F', dark: '#7A4036', light: '#C98D80', label: 'Bordeaux' },
  cognac:   { base: '#B0703C', dark: '#8A4E22', light: '#D89A5C', label: 'Cognac' },
  acier:    { base: '#7E8B99', dark: '#5B6672', light: '#B6C2CE', label: 'Acier' },
};
const autoMonogram = (name) => {
  const words = String(name || 'X').trim().split(/\s+/).filter(w => /[A-Za-zÀ-ÿ0-9]/.test(w[0]));
  return (((words[0] || 'X')[0] || 'X') + ((words[1] || 'X')[0] || 'X')).toUpperCase();
};
const slugify = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || 'salon';

/* ---------- tenants ---------- */
function makeTenant(cfg) {
  const id = uid('tnt');
  return {
    id,
    slug: cfg.slug,
    name: cfg.name,
    tagline: cfg.tagline || 'Coiffure & rasage',
    address: cfg.address || '',
    phone: cfg.phone || '',
    currency: cfg.currency || 'DT',
    openTime: cfg.openTime || '09:00', closeTime: cfg.closeTime || '20:00',
    workingDays: Array.isArray(cfg.workingDays) && cfg.workingDays.length ? cfg.workingDays : [1, 2, 3, 4, 5, 6],
    acceptReservations: cfg.acceptReservations !== false,
    maxPerDay: Number(cfg.maxPerDay) || 12,
    minNoticeMinutes: Number(cfg.minNoticeMinutes) || 60,
    stampGoal: Number(cfg.stampGoal) || 10,
    rewardLabel: cfg.rewardLabel || 'Coupe offerte',
    reminderDays: Number(cfg.reminderDays) || 14,
    adminPinHash: cfg.adminPinHash || scryptHash(cfg.adminPin || '1234'),
    accent: ACCENTS[cfg.accent] ? cfg.accent : 'brass',
    monogram: String(cfg.monogram || autoMonogram(cfg.name)).slice(0, 3).toUpperCase(),
    status: cfg.status || 'trial',
    trialEndsAt: cfg.status === 'trial' ? new Date(Date.now() + (Number(cfg.trialDays) || 14) * 864e5).toISOString() : null,
    currentPeriodEnd: cfg.status === 'active' ? new Date(Date.now() + 30 * 864e5).toISOString() : null,
    monthlyPrice: cfg.monthlyPrice !== undefined ? Number(cfg.monthlyPrice) : 40,
    paymentLink: cfg.paymentLink || '',
    createdAt: new Date().toISOString(),
    notes: cfg.notes || '',
  };
}
function makeStore(tenant) {
  return {
    shop: tenant, // référence partagée platform.tenants[i] ↔ stores[id].shop
    clients: [], visits: [], services: [], offers: [], notifications: [], reservations: [], pings: [],
    counters: { stampsIssued: 0, rewardsRedeemed: 0, remindersSent: 0 },
    createdAt: new Date().toISOString(),
  };
}
const findTenantBySlug = (slug) => platform.tenants.find(t => t.slug === slug) || null;
const tenantStore = (tenant) => platform.stores[tenant.id];

/* ---------- seed : Le Barbier de Carthage (actif) + Royal Barber (essai) ---------- */
function defaultServices() {
  return [
    { id: uid('srv'), name: 'Coupe homme', desc: 'Coupe, shampoing et coiffage', price: 15, minutes: 30, active: true },
    { id: uid('srv'), name: 'Taille de barbe', desc: 'Contours nets au coupe-chou', price: 10, minutes: 20, active: true },
    { id: uid('srv'), name: 'Coupe + barbe', desc: 'Le duo complet', price: 22, minutes: 45, active: true },
    { id: uid('srv'), name: 'Rasage traditionnel', desc: 'Serviette chaude, blaireau et coupe-chou', price: 12, minutes: 25, active: true },
    { id: uid('srv'), name: 'Shampoing + coiffage', desc: 'Lavage et brushing', price: 8, minutes: 15, active: true },
    { id: uid('srv'), name: 'Soin du visage', desc: 'Gommage, vapeur et masque', price: 18, minutes: 30, active: true },
    { id: uid('srv'), name: 'Coloration barbe', desc: 'Camouflage des poils blancs', price: 15, minutes: 20, active: true },
    { id: uid('srv'), name: 'Coupe enfant (–12 ans)', desc: 'Dès 6 ans', price: 10, minutes: 25, active: true },
    { id: uid('srv'), name: 'Forfait mariage', desc: 'Le marié : coupe, barbe, soin — le jour J', price: 120, minutes: 90, active: true },
    { id: uid('srv'), name: 'Hot towel & massage', desc: 'Serviette chaude et massage des épaules', price: 25, minutes: 30, active: true },
  ];
}
function defaultOffers() {
  return [
    { id: uid('off'), title: 'Happy Hour', desc: 'Mar – Jeu · 14h → 17h : –20% sur la coupe', badge: '-20%', active: true },
    { id: uid('off'), title: 'Duo père-fils', desc: 'Samedi matin : –15% sur vos deux coupes', badge: '-15%', active: true },
    { id: uid('off'), title: 'Parrainage', desc: 'Vous + votre ami = +1 tampon pour chacun', badge: '+1 tampon', active: true },
    { id: uid('off'), title: 'Produit offert', desc: 'Cire coiffante offerte dès 30 DT d’achat', badge: 'Offert', active: true },
  ];
}
function seedCarthageStore(tenant) {
  const store = makeStore(tenant);
  const day = 864e5;
  const t = Date.now();
  const mk = (name, phone, stamps, daysAgo, visits, rewards = 0) => ({
    id: uid('clt'), name, phone, code: publicCode(),
    token: crypto.randomBytes(24).toString('hex'),
    stamps, totalVisits: visits, rewardsRedeemed: rewards,
    createdAt: new Date(t - (daysAgo + 40) * day).toISOString(),
    lastVisitAt: daysAgo == null ? null : new Date(t - daysAgo * day).toISOString(),
    lastReminderAt: null, birthday: null, notes: '',
    referrals: 0, pushSubscriptions: [], lastBirthdayYear: null,
  });
  store.clients = [
    Object.assign(mk('Yassine Trabelsi', '+21620112233', 6, 3, 21, 2), { birthday: '1990-' + new Date().toISOString().slice(5, 10) }),
    mk('Mehdi Ben Salah', '+21655667788', 9, 0, 19, 1),
    mk('Anis Khelifi', '+21698765432', 2, 21, 12, 1),
    mk('Slim Chaabane', '+21622334455', 4, 17, 9, 0),
    mk('Rami Gharbi', '+21650998877', 8, 6, 27, 2),
    mk('Khalil Mansour', '+21671122334', 0, null, 1, 0),
  ];
  store.services = defaultServices();
  store.offers = defaultOffers();
  store.counters = { stampsIssued: 165, rewardsRedeemed: 6, remindersSent: 0 };
  seedReservations(store);
  return store;
}
function seedRoyalStore(tenant) {
  const store = makeStore(tenant);
  const day = 864e5;
  const t = Date.now();
  const mk = (name, phone, stamps, daysAgo, visits) => ({
    id: uid('clt'), name, phone, code: publicCode(),
    token: crypto.randomBytes(24).toString('hex'),
    stamps, totalVisits: visits, rewardsRedeemed: 0,
    createdAt: new Date(t - 30 * day).toISOString(),
    lastVisitAt: new Date(t - daysAgo * day).toISOString(),
    lastReminderAt: null, birthday: null, notes: '',
    referrals: 0, pushSubscriptions: [], lastBirthdayYear: null,
  });
  store.clients = [mk('Fares Aouadi', '+21622334455', 3, 5, 4), mk('Skander Ben Miled', '+21698555444', 7, 1, 9)];
  store.services = defaultServices().slice(0, 5);
  store.offers = [{ id: uid('off'), title: 'Offre lancement', desc: '–20% sur la première coupe, sans engagement', badge: '-20%', active: true }];
  return store;
}
function seedPlatform() {
  const carthage = makeTenant({
    slug: 'carthage', name: 'Le Barbier de Carthage', tagline: 'Coiffure & rasage traditionnel',
    address: 'Avenue Habib Bourguiba, Tunis', phone: '+216 71 000 000',
    adminPin: '1234', status: 'active', monthlyPrice: 40, accent: 'brass', monogram: 'BC',
    notes: 'Boutique pilote — abonnement actif',
  });
  const royal = makeTenant({
    slug: 'royalbarber', name: 'Royal Barber & Grooming', tagline: 'Grooming de précision, esprit gentleman',
    address: 'Les Berges du Lac 1, Tunis', phone: '+216 70 111 222',
    adminPin: 'royal1234', status: 'trial', trialDays: 14, monthlyPrice: 40, accent: 'bordeaux', monogram: 'RB',
    notes: 'Essai 14 jours',
  });
  const p = { version: PLATFORM_VERSION, tenants: [carthage, royal], stores: {}, vapid: null };
  p.stores[carthage.id] = seedCarthageStore(carthage);
  p.stores[royal.id] = seedRoyalStore(royal);
  return p;
}

/* ---------- migration depuis la v1 mono-boutique ---------- */
function migrateLegacy(old) {
  const s = old.shop || {};
  const t = makeTenant({
    slug: 'carthage', name: s.name || 'Le Barbier de Carthage', tagline: s.tagline, address: s.address, phone: s.phone,
    currency: s.currency || 'DT', openTime: s.openTime || '09:00', closeTime: s.closeTime || '20:00',
    workingDays: s.workingDays, acceptReservations: s.acceptReservations, maxPerDay: s.maxPerDay,
    minNoticeMinutes: s.minNoticeMinutes, stampGoal: s.stampGoal, rewardLabel: s.rewardLabel, reminderDays: s.reminderDays,
    adminPin: s.adminPin || '1234', status: 'active', monthlyPrice: 40, accent: 'brass', monogram: 'BC',
    notes: 'Migré depuis la v1 mono-boutique',
  });
  const store = makeStore(t);
  store.clients = old.clients || []; store.visits = old.visits || [];
  store.services = old.services || defaultServices(); store.offers = old.offers || defaultOffers();
  store.notifications = old.notifications || []; store.reservations = old.reservations || [];
  store.pings = old.pings || []; store.counters = old.counters || store.counters;
  return { version: PLATFORM_VERSION, tenants: [t], stores: { [t.id]: store }, vapid: old.vapid || null };
}

/* ---------- persistance (fichier | postgres) ---------- */
let platform = null;
let platformDirty = false;
function persistFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(platform, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
async function persistPostgres() {
  const { Client } = require('pg'); // dépendance optionnelle — uniquement si POSTGRES_URL est défini
  const client = new Client({ connectionString: process.env.POSTGRES_URL, ssl: process.env.POSTGRES_SSL === 'false' ? false : { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS barbier_kv (key text PRIMARY KEY, value jsonb NOT NULL)');
    await client.query('INSERT INTO barbier_kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', ['platform', JSON.stringify(platform)]);
  } finally { await client.end(); }
}
function saveDb() {
  if (IS_PG) { platformDirty = true; return; } // persisté en fin de requête (Vercel)
  persistFile();
}
async function flushPersist() {
  if (!IS_PG || !platformDirty) return;
  platformDirty = false;
  try { await persistPostgres(); } catch (e) { console.error('[db] persistance Postgres échouée —', e.message); }
}
async function loadPlatform() {
  if (IS_PG) {
    const { Client } = require('pg');
    const client = new Client({ connectionString: process.env.POSTGRES_URL, ssl: process.env.POSTGRES_SSL === 'false' ? false : { rejectUnauthorized: false } });
    await client.connect();
    try {
      await client.query('CREATE TABLE IF NOT EXISTS barbier_kv (key text PRIMARY KEY, value jsonb NOT NULL)');
      const r = await client.query("SELECT value FROM barbier_kv WHERE key='platform'");
      platform = r.rows.length ? r.rows[0].value : (SEED_DEMO ? seedPlatform() : { version: PLATFORM_VERSION, tenants: [], stores: {}, vapid: null });
      if (!r.rows.length) await persistPostgres();
      console.log(`[db] plateforme chargée depuis Postgres — ${platform.tenants.length} salon(s)`);
    } finally { await client.end(); }
    return;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    platform = raw && raw.version === PLATFORM_VERSION ? raw : migrateLegacy(raw);
    if (raw && raw.version !== PLATFORM_VERSION) { persistFile(); console.log('[db] v1 migrée → plateforme multi-tenant'); }
    console.log(`[db] plateforme chargée — ${platform.tenants.length} salon(s)`);
  } catch {
    platform = SEED_DEMO ? seedPlatform() : { version: PLATFORM_VERSION, tenants: [], stores: {}, vapid: null };
    persistFile();
    console.log('[db] plateforme initialisée — 2 salons de démo (carthage · royalbarber)');
  }
}

/* ---------------------------------------------------- admin sessions (par tenant) */
const sessions = new Map(); // token -> { expiry, tenantId }
const newSession = (tenantId) => {
  const s = crypto.randomBytes(24).toString('hex');
  sessions.set(s, { expiry: now() + 12 * 3600e3, tenantId });
  return s;
};
const validSession = (s, tenantId) => {
  const e = s && sessions.get(s);
  return !!(e && e.expiry > now() && e.tenantId === tenantId);
};

/* --------------------------------------------------- rate limiting */
const buckets = new Map(); // key -> {count, reset}
function rateLimit(key, max, windowMs) {
  const b = buckets.get(key);
  const t = now();
  if (!b || b.reset < t) { buckets.set(key, { count: 1, reset: t + windowMs }); return true; }
  if (b.count >= max) return false;
  b.count++; return true;
}

/* --------------------------------------------------------- helpers */
function clientPublic(c) {
  return {
    id: c.id, name: c.name, code: c.code, stamps: c.stamps,
    totalVisits: c.totalVisits, rewardsRedeemed: c.rewardsRedeemed,
    createdAt: c.createdAt, lastVisitAt: c.lastVisitAt, birthday: c.birthday || null,
    referrals: c.referrals || 0, referralCode: c.code,
  };
}
function hoursLabelComputed() {
  const days = workingDays().slice().sort((a, b) => a - b);
  const fmtT = (t) => { const [h, m] = String(t).split(':'); return m === '00' ? `${Number(h)}h` : `${Number(h)}h${m}`; };
  const isRange = (arr, from, to) => arr.length === to - from + 1 && arr.every((d, i) => d === from + i);
  let daysLabel;
  if (isRange(days, 1, 6)) daysLabel = 'Lun – Sam';
  else if (isRange(days, 1, 5)) daysLabel = 'Lun – Ven';
  else if (isRange(days, 0, 6)) daysLabel = 'Tous les jours';
  else daysLabel = days.map(d => ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'][d]).join(' · ');
  return `${daysLabel} · ${fmtT(db.shop.openTime || '09:00')} à ${fmtT(db.shop.closeTime || '20:00')}`;
}
function shopPublic() {
  const s = db.shop;
  return {
    name: s.name, tagline: s.tagline, address: s.address, phone: s.phone,
    slug: s.slug, monogram: s.monogram, accent: s.accent,
    hoursLabel: hoursLabelComputed(),
    openHour: Number(String(s.openTime || '09:00').split(':')[0]),
    closeHour: Number(String(s.closeTime || '20:00').split(':')[0]),
    openTime: s.openTime || '09:00', closeTime: s.closeTime || '20:00',
    workingDays: workingDays(), closedSunday: !workingDays().includes(0),
    currency: s.currency,
    acceptReservations: s.acceptReservations !== false,
    maxPerDay: Number(s.maxPerDay) || 0,
    minNoticeMinutes: Number(s.minNoticeMinutes) || 0,
    stampGoal: s.stampGoal, rewardLabel: s.rewardLabel,
    services: db.services.filter(x => x.active),
    offers: db.offers.filter(x => x.active),
  };
}
function rewardState(c) {
  const goal = db.shop.stampGoal;
  return {
    stampGoal: goal,
    stamps: c.stamps,
    rewardReady: c.stamps >= goal,
    remaining: Math.max(0, goal - c.stamps),
  };
}
function addVisit(c, via) {
  c.stamps += 1;
  c.totalVisits += 1;
  c.lastVisitAt = new Date().toISOString();
  db.counters.stampsIssued += 1;
  db.visits.unshift({ id: uid('vis'), clientId: c.id, clientName: c.name, via, at: new Date().toISOString() });
  db.visits = db.visits.slice(0, 500);
}

/* ------------------------------------------------------- http utils */
function send(res, status, obj, headers = {}) {
  const body = typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': typeof obj === 'object' && !Buffer.isBuffer(obj) ? 'application/json; charset=utf-8' : (headers['Content-Type'] || 'text/plain; charset=utf-8'),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}
const sendJson = (res, status, obj) => send(res, status, obj, { 'Content-Type': 'application/json; charset=utf-8' });
function decodePathnameSafe(url) {
  let p = url.pathname.replace(/\/{2,}/g, '/');   // //s/carthage → /s/carthage
  try { p = decodeURIComponent(p); } catch { /* garder tel quel */ }   // % cassé → ne pas crasher
  p = p.replace(/\/{2,}/g, '/');                     // %2F peut réintroduire des slashes
  return (p.replace(/\/+$/, '') || '/');
}
function notFoundPage(path) {
  const safe = escHtml(path || '/');
  return '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page introuvable — CarteBarber</title><link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="stylesheet" href="/css/style.css"></head><body><div style="min-height:100vh;display:grid;place-items:center;background:#16301F;color:#F6F1E7;text-align:center;padding:30px"><div><div style="font-family:var(--font-display);font-size:44px;color:#C2A04E">404</div><h1 style="font-family:var(--font-display);font-weight:600;margin:6px 0 10px">Cette page n’existe pas.</h1><p style="color:#A79C88;font-size:13px">Chemin demandé : <code style="color:#E3C878">' + safe + '</code></p><p><a href="/" style="color:#E3C878">← Retour à la plateforme</a></p></div></div></body></html>';
}
const notFound = (res, path) => {
  console.warn('[404]', path || '(route)');
  if (!path || path.includes('/api/') || path.startsWith('/api')) return sendJson(res, 404, { error: 'Introuvable' });
  return sendHtml(res, notFoundPage(path), 404);
};
const badRequest = (res, msg) => sendJson(res, 400, { error: msg });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 100 * 1024) { reject(new Error('payload too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('JSON invalide')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
function sendHtml(res, html, status = 200) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}
/* Pages modèles : servies uniquement rendues par salon (renderPublicFile) — jamais en brut */
const TEMPLATED_PAGES = new Set(['/index.html', '/admin.html', '/poster.html', '/display.html', '/paywall.html']);
function serveStaticFile(res, pathname) {
  const rel = pathname; // déjà décodé par decodePathnameSafe
  if (TEMPLATED_PAGES.has(rel)) return notFound(res, pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return notFound(res, pathname);
  fs.readFile(file, (err, buf) => {
    if (err) return notFound(res, pathname);
    const ext = path.extname(file).toLowerCase();
    // sw.js : no-cache — le navigateur doit toujours récupérer la dernière version (sinon l’ancien SW survit)
    const cache = ['.html', '.webmanifest'].includes(ext) ? 'no-store' : (path.basename(file) === 'sw.js' ? 'no-cache' : 'public, max-age=3600');
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache });
    res.end(buf);
  });
}

/* ---------- marque par tenant (placeholder {{VARS}} dans les pages) ---------- */
function tenantBrandVars(t) {
  const accent = ACCENTS[t.accent] || ACCENTS.brass;
  const link = t.paymentLink || process.env.PAYMENT_LINK || '';
  return {
    '{{SHOP_NAME}}': escHtml(t.name),
    '{{TAGLINE}}': escHtml(t.tagline),
    '{{ADDRESS}}': escHtml(t.address),
    '{{PHONE}}': escHtml(t.phone),
    '{{SHOP_DESC}}': 'La carte de fidélité de ' + escHtml(t.name) + ' — scannez le QR du comptoir, collectionnez vos tampons, votre 10e coupe est offerte. Sans application, sans compte.',
    '{{MONOGRAM}}': escHtml(t.monogram),
    '{{API_BASE}}': '/s/' + t.slug,
    '{{API_BASE_JS}}': JSON.stringify('/s/' + t.slug),
    '{{MANIFEST}}': '/s/' + t.slug + '/manifest.webmanifest',
    '{{TENANT_CSS}}': '<style>:root{--brass:' + accent.base + ';--brass-dark:' + accent.dark + ';--brass-light:' + accent.light + '}</style>',
    '{{REPORT_EYEBROW}}': escHtml(t.name) + ' · ' + escHtml(t.address),
    '{{HOURS}}': escHtml(hoursLabelComputed()),
    '{{PHONE_RAW}}': escHtml(t.phone),
    '{{PAYMENT_LINK}}': link ? escHtml(link) : 'mailto:iyedomri922@gmail.com',
    '{{CONTACT_EMAIL}}': 'iyedomri922@gmail.com',
    '{{D17_NUMBER}}': escHtml(process.env.D17_NUMBER || ''),
    '{{D17_BLOCK}}': (() => { const n = String(process.env.D17_NUMBER || '').trim(); return n ? '<div style="margin:0 0 14px;padding:14px 12px;border:1px dashed var(--brass,#C2A04E);border-radius:14px;background:rgba(194,160,78,.08)"><div style="font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--brass-dark,#A8843A);margin-bottom:6px">Paiement D17 — mobile money</div><div style="font-family:var(--font-display);font-size:22px;font-weight:600;color:#16301F;letter-spacing:.04em">' + escHtml(n) + '</div><div style="font-size:11px;color:#5B5343;margin-top:4px">Envoyez <b>{{MONTHLY_PRICE}} DT</b> (un mois d’abonnement) avec votre nom de salon en référence. Le barbier rallume le salon dès réception.</div></div>' : ''; })(),
    '{{STRIPE_BUTTON}}': (() => { const l = link; return l ? '<a href="' + escHtml(l) + '" class="btn btn-brass btn-full" style="text-decoration:none;display:block">Régler par carte — {{MONTHLY_PRICE}} DT / mois</a>' : ''; })(),
    '{{MONTHLY_PRICE}}': String(t.monthlyPrice ?? 40),
  };
}
function renderPublicFile(file, tenant) {
  let html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
  if (tenant) {
    const vars = tenantBrandVars(tenant);
    for (const k of Object.keys(vars)) html = html.split(k).join(vars[k]);
  } else {
    html = html.split('{{TENANT_CSS}}').join('');
  }
  return html;
}
const TENANT_PAGES = { '/': 'index.html', '/admin': 'admin.html', '/poster': 'poster.html', '/display': 'display.html' };
function tenantIsActive(t) {
  if (t.status === 'active') return !t.currentPeriodEnd || new Date(t.currentPeriodEnd) > new Date();
  if (t.status === 'trial') return t.trialEndsAt && new Date(t.trialEndsAt) > new Date();
  return false;
}
function serveTenantPage(res, page, tenant) { sendHtml(res, renderPublicFile(page, tenant)); }
function servePaywall(res, tenant) { sendHtml(res, renderPublicFile('paywall.html', tenant)); }

/* ============================================================ routes */
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });
const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
const match = (pattern, pathname) => {
  const pp = pattern.split('/'), up = pathname.split('/');
  if (pp.length !== up.length) return null;
  const params = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(':')) params[pp[i].slice(1)] = safeDecode(up[i]);
    else if (pp[i] !== up[i]) return null;
  }
  return params;
};


/* ---- Web Push (VAPID) — activé quand le navigateur accepte ------------------ */
function ensureVapid() {
  if (!platform.vapid) {
    try { const keys = webpush.generateVAPIDKeys(); platform.vapid = { publicKey: keys.publicKey, privateKey: keys.privateKey }; if (IS_PG) platformDirty = true; else persistFile(); }
    catch (e) { console.error('[push] VAPID generation failed', e); return false; }
  }
  try { webpush.setVapidDetails('mailto:iyedomri922@gmail.com', platform.vapid.publicKey, platform.vapid.privateKey); }
  catch (e) { console.error('[push] VAPID setup failed', e); return false; }
  return true;
}
const tenantHomeUrl = () => '/s/' + db.shop.slug + '/';
async function sendPush(c, payload) {
  const subs = c.pushSubscriptions || [];
  if (!subs.length || !platform.vapid) return { sent: 0, dead: 0 };
  let sent = 0, dead = 0;
  for (const sub of subs.slice()) {
    try { await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 86400 }); sent++; }
    catch (err) {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) { c.pushSubscriptions = c.pushSubscriptions.filter(s => s.endpoint !== sub.endpoint); dead++; }
      else console.error('[push] send failed (réseau/hors portée) —', err.statusCode || err.message);
    }
  }
  if (sent || dead) saveDb();
  return { sent, dead };
}

/* ---- anniversaire : notification + badge le jour J -------------------------- */
function isBirthdayToday(iso) {
  if (!iso) return false;
  const parts = String(iso).split('-');
  if (parts.length < 3) return false;
  const t = new Date();
  return Number(parts[1]) === t.getMonth() + 1 && Number(parts[2]) === t.getDate();
}
function maybeBirthday(c) {
  if (!isBirthdayToday(c.birthday)) return false;
  const year = new Date().getFullYear();
  if (c.lastBirthdayYear === year) return false;
  c.lastBirthdayYear = year;
  const title = 'Joyeux anniversaire !';
  const body = `${db.shop.name} vous offre la coupe à –50 % aujourd’hui. Venez fêter ça dans le fauteuil.`;
  db.notifications.unshift({ id: uid('ntf'), clientId: c.id, title, body, kind: 'birthday', createdAt: new Date().toISOString(), readAt: null });
  sendPush(c, { title, body }).catch(() => {});
  return true;
}

/* ---- relances : qui est revenu après le mot doux (north star) ---------------- */
function reminderStats(daysBack = 90) {
  const cutoff = Date.now() - daysBack * 864e5;
  const rems = db.notifications.filter(n => n.kind === 'reminder' && new Date(n.createdAt).getTime() > cutoff);
  let returned = 0;
  for (const n of rems) {
    const c = db.clients.find(x => x.id === n.clientId);
    if (c && c.lastVisitAt && new Date(c.lastVisitAt) > new Date(n.createdAt)) returned++;
  }
  return { sent: rems.length, returned, rate: rems.length ? Math.round((returned / rems.length) * 100) : 0 };
}

/* ---- public: shop / services / offers -------------------------------- */
route('GET', '/api/shop', (req, res) => sendJson(res, 200, shopPublic()));

/* ---- public: join / card / stamp / redeem ----------------------------- */
route('POST', '/api/join', async (req, res) => {
  const ip = req.socket.remoteAddress || 'ip';
  if (!rateLimit('join:' + ip, 20, 60e3)) return sendJson(res, 429, { error: 'Trop de tentatives, réessayez dans une minute.' });
  const body = await readBody(req);
  const name = esc(body.name).trim().slice(0, 80);
  const phone = normPhone(body.phone);
  const birthday = esc(body.birthday).slice(0, 10) || null;
  const ref = esc(body.ref).trim().toUpperCase().slice(0, 12);
  if (name.length < 2) return badRequest(res, 'Votre nom est requis.');
  if (!validPhone(phone)) return badRequest(res, 'Numéro de téléphone invalide (ex : +216 98 123 456).');
  let client = db.clients.find(c => c.phone === phone);
  let created = false;
  let referralApplied = false;
  if (!client) {
    client = {
      id: uid('clt'), name, phone, code: publicCode(),
      token: crypto.randomBytes(24).toString('hex'),
      stamps: 0, totalVisits: 0, rewardsRedeemed: 0,
      createdAt: new Date().toISOString(), lastVisitAt: null,
      lastReminderAt: null, birthday, notes: '',
      referrals: 0, pushSubscriptions: [], lastBirthdayYear: null,
    };
    db.clients.push(client);
    created = true;
    // parrainage : +1 tampon pour le nouveau ET pour le parrain (si place)
    if (ref && ref !== client.code) {
      const referrer = db.clients.find(c => c.code === ref);
      if (referrer) {
        const goal = db.shop.stampGoal;
        client.stamps = Math.min(goal, client.stamps + 1);
        referrer.stamps = Math.min(goal, referrer.stamps + 1);
        referrer.referrals = (referrer.referrals || 0) + 1;
        db.notifications.unshift({ id: uid('ntf'), clientId: referrer.id, title: '+1 tampon — parrainage', body: 'Un ami a créé sa carte avec votre code. +1 tampon pour vous deux.', kind: 'referral', createdAt: new Date().toISOString(), readAt: null });
        referralApplied = true;
      }
    }
    maybeBirthday(client);
  } else if (birthday && !client.birthday) {
    client.birthday = birthday;
  }
  saveDb();
  sendJson(res, created ? 201 : 200, { token: client.token, code: client.code, created, card: clientPublic(client), reward: rewardState(client), referralApplied });
});

route('GET', '/api/card', (req, res, query) => {
  const c = db.clients.find(x => x.token === query.get('token'));
  if (!c) return sendJson(res, 401, { error: 'Carte introuvable.' });
  const birthdayJustTriggered = maybeBirthday(c);
  if (birthdayJustTriggered) saveDb();
  sendJson(res, 200, { card: clientPublic(c), reward: rewardState(c), shop: shopPublic(), isBirthdayToday: isBirthdayToday(c.birthday) });
});


route('POST', '/api/onmyway', async (req, res) => {
  const body = await readBody(req);
  const c = db.clients.find(x => x.token === body.token);
  if (!c) return sendJson(res, 401, { error: 'Carte introuvable.' });
  const last = (db.pings || []).find(p => p.clientId === c.id);
  if (last && now() - new Date(last.at).getTime() < 10 * 60e3) {
    return sendJson(res, 429, { error: 'Votre barbier est déjà prévenu — à tout de suite.' });
  }
  db.pings = db.pings || [];
  db.pings.unshift({ id: uid('png'), clientId: c.id, name: c.name, at: new Date().toISOString() });
  db.pings = db.pings.slice(0, 50);
  saveDb();
  sendJson(res, 200, { ok: true, message: 'Votre barbier sait que vous arrivez — la chaise vous attend.' });
});


/* ---- public: disponibilités & réservations ---------------------------------- */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validReservationDate = (d) => {
  if (!DATE_RE.test(d)) return false;
  const dt = new Date(d + 'T12:00:00');
  if (isNaN(dt)) return false;
  if (d < localDateStr()) return false;
  const max = localDateStr(new Date(Date.now() + 60 * 864e5));
  return d <= max;
};
route('GET', '/api/availability', (req, res, query) => {
  const date = String(query.get('date') || localDateStr());
  if (!DATE_RE.test(date)) return badRequest(res, 'Date invalide (YYYY-MM-DD).');
  const s = db.shop;
  sendJson(res, 200, {
    date,
    closed: !isWorkingDay(date),
    openTime: s.openTime || '09:00',
    closeTime: s.closeTime || '20:00',
    acceptReservations: s.acceptReservations !== false,
    busy: mergedBusy(date), // créneaux anonymes — la vie privée des clients reste au salon
  });
});
route('GET', '/api/slots', (req, res, query) => {
  const date = String(query.get('date') || '');
  const duration = Math.max(15, Math.min(240, Number(query.get('duration')) || 30));
  if (!validReservationDate(date)) return badRequest(res, 'Date invalide ou trop lointaine.');
  sendJson(res, 200, { date, duration, slots: slotList(date, duration) });
});
route('POST', '/api/reserve', async (req, res) => {
  const ip = req.socket.remoteAddress || 'ip';
  if (!rateLimit('reserve:' + ip, 10, 3600e3)) return sendJson(res, 429, { error: 'Trop de réservations d’affilée — réessayez plus tard.' });
  const body = await readBody(req);
  if (db.shop.acceptReservations === false) return sendJson(res, 409, { error: 'Les réservations sont momentanément suspendues — passez en direct.' });

  const token = esc(body.token) || null;
  const linked = token ? db.clients.find(c => c.token === token) : null;
  const name = (linked ? linked.name : esc(body.name).trim()).slice(0, 80);
  const phone = linked ? linked.phone : normPhone(body.phone);
  const date = esc(body.date), time = esc(body.time);
  const type = body.type === 'event' ? 'event' : 'normal';
  const notes = esc(body.notes).trim().slice(0, 400);

  let serviceName = 'Coupe homme', durationMin = 30, serviceId = null;
  const svc = body.serviceId ? db.services.find(s => s.id === body.serviceId && s.active) : null;
  if (svc) { serviceName = svc.name; durationMin = svc.minutes; serviceId = svc.id; }
  else if (body.serviceName) { serviceName = esc(body.serviceName).trim().slice(0, 120); durationMin = Math.max(15, Math.min(240, Number(body.durationMin) || 60)); }

  if (name.length < 2) return badRequest(res, 'Votre nom est requis.');
  if (!validPhone(phone)) return badRequest(res, 'Téléphone invalide (ex : +216 98 123 456).');
  if (!validReservationDate(date)) return badRequest(res, 'Date invalide (aujourd’hui → +60 jours).');
  if (!/^\d{2}:\d{2}$/.test(time)) return badRequest(res, 'Heure invalide.');

  // anti-accumulation : max 4 réservations à venir par téléphone
  const upcoming = db.reservations.filter(r => r.phone === phone && r.status !== 'cancelled' && r.date >= localDateStr()).length;
  if (upcoming >= 4) return sendJson(res, 429, { error: 'Vous avez déjà plusieurs réservations à venir — annulez-en une si besoin.' });

  const fit = canFit(date, time, durationMin);
  if (!fit.ok) return sendJson(res, 409, { error: fit.reason });

  const status = type === 'event' ? 'pending' : 'confirmed';
  const reservation = {
    id: uid('rsv'), code: rsvCode(), clientId: linked ? linked.id : null,
    name, phone, serviceId, serviceName, date, time,
    durationMin, endTime: minToTime(timeToMin(time) + durationMin),
    type, notes, status, createdAt: new Date().toISOString(),
  };
  db.reservations.unshift(reservation);

  const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  const title = type === 'event' ? 'Demande de réservation reçue' : 'Réservation confirmée';
  const shopName = db.shop.name;
  const bodyTxt = `${serviceName} — ${dateLabel} à ${time} chez ${shopName}.` + (type === 'event' ? ' Le barbier vous rappelle pour caler les détails.' : ` Présentez-vous 5 min avant — le fauteuil vous attend.`);
  if (linked) {
    db.notifications.unshift({ id: uid('ntf'), clientId: linked.id, title, body: bodyTxt, kind: 'reservation', createdAt: new Date().toISOString(), readAt: null });
    sendPush(linked, { title, body: bodyTxt, url: tenantHomeUrl() }).catch(() => {});
  }
  saveDb();
  sendJson(res, 201, { reservation, message: status === 'confirmed' ? `C’est noté — à très vite chez ${db.shop.name}.` : 'Demande envoyée — le barbier vous confirme rapidement.' });
});
route('GET', '/api/my-reservations', (req, res, query) => {
  const c = db.clients.find(x => x.token === query.get('token'));
  if (!c) return sendJson(res, 401, { error: 'Carte introuvable.' });
  const today = localDateStr();
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const mine = db.reservations.filter(r => r.clientId === c.id);
  const upcoming = mine.filter(r => r.date > today || (r.date === today && timeToMin(r.endTime) >= nowMin)).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const past = mine.filter(r => !(r.date > today || (r.date === today && timeToMin(r.endTime) >= nowMin))).sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time)).slice(0, 5);
  sendJson(res, 200, { upcoming, past });
});
route('POST', '/api/reservations/cancel', async (req, res) => {
  const body = await readBody(req);
  const c = db.clients.find(x => x.token === body.token);
  if (!c) return sendJson(res, 401, { error: 'Carte introuvable.' });
  const r = db.reservations.find(x => x.id === body.id && x.clientId === c.id);
  if (!r) return notFound(res);
  if (r.status === 'cancelled') return sendJson(res, 200, { ok: true });
  r.status = 'cancelled';
  saveDb();
  sendJson(res, 200, { ok: true, message: 'Réservation annulée — le fauteuil est libre.' });
});

/* ---- public: notifications --------------------------------------------- */
route('GET', '/api/notifications', (req, res, query) => {
  const c = db.clients.find(x => x.token === query.get('token'));
  if (!c) return sendJson(res, 401, { error: 'Carte introuvable.' });
  const items = db.notifications.filter(n => n.clientId === c.id).slice(0, 20);
  sendJson(res, 200, { notifications: items, unread: items.filter(n => !n.readAt).length });
});
route('POST', '/api/notifications/read', async (req, res) => {
  const body = await readBody(req);
  const c = db.clients.find(x => x.token === body.token);
  if (!c) return sendJson(res, 401, { error: 'Carte introuvable.' });
  for (const n of db.notifications) {
    if (n.clientId === c.id && (body.all || n.id === body.id)) n.readAt = n.readAt || new Date().toISOString();
  }
  saveDb();
  sendJson(res, 200, { ok: true });
});


route('GET', '/api/push/key', (req, res) => {
  if (!ensureVapid()) return sendJson(res, 503, { error: 'Push indisponible sur ce serveur.' });
  sendJson(res, 200, { publicKey: platform.vapid.publicKey });
});
route('POST', '/api/push/subscribe', async (req, res) => {
  const body = await readBody(req);
  const c = db.clients.find(x => x.token === body.token);
  if (!c) return sendJson(res, 401, { error: 'Carte introuvable.' });
  const sub = body.subscription;
  if (!sub || !sub.endpoint) return badRequest(res, 'Subscription invalide.');
  c.pushSubscriptions = (c.pushSubscriptions || []).filter(s => s.endpoint !== sub.endpoint);
  c.pushSubscriptions.push(sub);
  if (c.pushSubscriptions.length > 5) c.pushSubscriptions = c.pushSubscriptions.slice(-5);
  saveDb();
  sendJson(res, 200, { ok: true });
});

/* ---- admin: auth -------------------------------------------------------- */
route('POST', '/api/admin/login', async (req, res) => {
  const ip = req.socket.remoteAddress || 'ip';
  if (!rateLimit('login:' + ip, 10, 60e3)) return sendJson(res, 429, { error: 'Trop de tentatives. Réessayez dans une minute.' });
  const body = await readBody(req);
  if (!scryptCheck(body.pin, db.shop.adminPinHash)) return sendJson(res, 403, { error: 'Code PIN incorrect.' });
  sendJson(res, 200, { session: newSession(db.shop.id), shopName: db.shop.name });
});
function adminAuth(req, res, query) {
  const s = (req.headers['x-admin-session']) || (query && query.get('session'));
  if (!validSession(s, db.shop.id)) { sendJson(res, 401, { error: 'Session expirée. Reconnectez-vous.' }); return null; }
  return s;
}

/* ---- admin: overview ------------------------------------------------------ */
route('GET', '/api/admin/overview', (req, res, query) => {
  if (!adminAuth(req, res, query)) return;
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const visitsToday = db.visits.filter(v => new Date(v.at) >= dayStart).length;
  const activeClients = db.clients.filter(c => c.lastVisitAt && (now() - new Date(c.lastVisitAt).getTime()) < 30 * 864e5).length;
  const lapsed = lapsedClients(db.shop.reminderDays);
  const redeemedTotal = db.clients.reduce((a, c) => a + c.rewardsRedeemed, 0);
  const stampsInCircles = db.clients.reduce((a, c) => a + c.stamps, 0);
  const reminder = reminderStats(90);
  const todayB = db.clients.filter(c => isBirthdayToday(c.birthday)).map(c => ({ id: c.id, name: c.name, phone: c.phone }));
  const freshPings = (db.pings || []).filter(p => now() - new Date(p.at).getTime() < 90 * 60e3);
  const journal = db.notifications
    .filter(n => n.kind === 'reminder')
    .slice(0, 10)
    .map(n => {
      const c = db.clients.find(x => x.id === n.clientId);
      return {
        clientName: c ? c.name : '—',
        at: n.createdAt,
        read: !!n.readAt,
        returned: !!(c && c.lastVisitAt && new Date(c.lastVisitAt) > new Date(n.createdAt)),
      };
    });
  sendJson(res, 200, {
    stats: {
      totalClients: db.clients.length,
      activeClients,
      lapsedClients: lapsed.length,
      visitsToday,
      stampsIssued: db.counters.stampsIssued,
      rewardsRedeemed: redeemedTotal,
      stampsInCircles,
      remindersSent: db.counters.remindersSent,
      returnedAfterReminder: reminder.returned,
      reminderRate: reminder.rate,
      reservationsToday: db.reservations.filter(r => r.date === localDateStr() && r.status !== 'cancelled').length,
      reservationsPending: db.reservations.filter(r => r.status === 'pending').length,
    },
    recentVisits: db.visits.slice(0, 8),
    lapsed: lapsed.map(clientPublic),
    birthdaysToday: todayB,
    pings: freshPings,
    reminderJournal: journal,
  });
});
function lapsedClients(days) {
  const cutoff = now() - days * 864e5;
  return db.clients
    .filter(c => c.lastVisitAt && new Date(c.lastVisitAt).getTime() < cutoff)
    .sort((a, b) => new Date(a.lastVisitAt) - new Date(b.lastVisitAt));
}

/* ---- admin: clients -------------------------------------------------------- */
route('GET', '/api/admin/clients', (req, res, query) => {
  if (!adminAuth(req, res, query)) return;
  const q = esc(query.get('q')).trim().toLowerCase();
  let list = db.clients.slice();
  if (q) list = list.filter(c => c.name.toLowerCase().includes(q) || c.phone.includes(q) || (c.code || '').toLowerCase().includes(q));
  list.sort((a, b) => new Date(b.lastVisitAt || 0) - new Date(a.lastVisitAt || 0));
  sendJson(res, 200, { clients: list.map(c => ({ ...clientPublic(c), lastReminderAt: c.lastReminderAt })) });
});
route('POST', '/api/admin/stamp', async (req, res) => {
  if (!adminAuth(req, res, new URLSearchParams())) return;
  const body = await readBody(req);
  const c = db.clients.find(x => x.id === body.clientId);
  if (!c) return notFound(res);
  if (c.stamps >= db.shop.stampGoal) return sendJson(res, 409, { error: 'La carte est complète — la coupe est offerte.' });
  addVisit(c, 'admin');
  saveDb();
  sendJson(res, 200, { card: clientPublic(c), reward: rewardState(c) });
});
route('POST', '/api/admin/stamp-by-code', async (req, res) => {
  if (!adminAuth(req, res, new URLSearchParams())) return;
  const b = await readBody(req);
  const code = esc(b.code).trim().toUpperCase();
  const c = db.clients.find(x => x.code === code);
  if (!c) return sendJson(res, 404, { error: 'Aucune carte avec le code ' + code + '.' });
  if (c.stamps >= db.shop.stampGoal) return sendJson(res, 409, { error: 'Carte complète — la coupe est offerte.', card: clientPublic(c), reward: rewardState(c) });
  addVisit(c, 'admin-scan');
  saveDb();
  const reward = rewardState(c);
  sendJson(res, 200, {
    card: clientPublic(c), reward,
    message: reward.rewardReady
      ? `Carte complète — ${c.name.split(' ')[0]} a droit à sa coupe offerte.`
      : `+1 tampon pour ${c.name.split(' ')[0]} — ${c.stamps}/${reward.stampGoal}.`,
  });
});
route('POST', '/api/admin/redeem-by-code', async (req, res) => {
  if (!adminAuth(req, res, new URLSearchParams())) return;
  const b = await readBody(req);
  const code = esc(b.code).trim().toUpperCase();
  const c = db.clients.find(x => x.code === code);
  if (!c) return sendJson(res, 404, { error: 'Aucune carte avec le code ' + code + '.' });
  if (c.stamps < db.shop.stampGoal) return sendJson(res, 409, { error: 'Pas de récompense sur cette carte.' });
  c.stamps = 0; c.rewardsRedeemed += 1; db.counters.rewardsRedeemed += 1;
  saveDb();
  sendJson(res, 200, { card: clientPublic(c), reward: rewardState(c), message: 'Coupe offerte validée — carte remise à zéro.' });
});
route('POST', '/api/admin/redeem', async (req, res) => {
  if (!adminAuth(req, res, new URLSearchParams())) return;
  const body = await readBody(req);
  const c = db.clients.find(x => x.id === body.clientId);
  if (!c) return notFound(res);
  if (c.stamps < db.shop.stampGoal) return sendJson(res, 409, { error: 'Pas de récompense sur cette carte.' });
  c.stamps = 0; c.rewardsRedeemed += 1; db.counters.rewardsRedeemed += 1;
  saveDb();
  sendJson(res, 200, { card: clientPublic(c) });
});
route('DELETE', '/api/admin/clients/:id', (req, res, query, params) => {
  if (!adminAuth(req, res, query)) return;
  const id = params.id;
  db.clients = db.clients.filter(c => c.id !== id);
  db.notifications = db.notifications.filter(n => n.clientId !== id);
  db.visits = db.visits.filter(v => v.clientId !== id);
  db.pings = (db.pings || []).filter(p => p.clientId !== id);
  db.reservations = (db.reservations || []).filter(r => r.clientId !== id);
  saveDb();
  sendJson(res, 200, { ok: true });
});


/* ---- admin: réservations ---------------------------------------------------- */
route('GET', '/api/admin/reservations', (req, res, query) => {
  if (!adminAuth(req, res, query)) return;
  const filter = String(query.get('filter') || 'today');
  const today = localDateStr();
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  let list = db.reservations.slice();
  if (filter === 'today') list = list.filter(r => r.date === today);
  else if (filter === 'upcoming') list = list.filter(r => r.date > today || (r.date === today && timeToMin(r.endTime) >= nowMin));
  else if (filter === 'pending') list = list.filter(r => r.status === 'pending');
  else if (filter === 'history') list = list.filter(r => r.date < today || r.status === 'done' || r.status === 'no_show');
  list.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  if (filter === 'history') list.reverse();
  sendJson(res, 200, { reservations: list.slice(0, 200), today });
});
route('POST', '/api/admin/reservations', async (req, res) => {
  if (!adminAuth(req, res, new URLSearchParams())) return;
  const b = await readBody(req);
  const name = esc(b.name).trim().slice(0, 80);
  const phone = normPhone(b.phone);
  const date = esc(b.date), time = esc(b.time);
  const type = b.type === 'event' ? 'event' : 'normal';
  const serviceName = esc(b.serviceName || 'Sur demande').trim().slice(0, 120);
  const durationMin = Math.max(15, Math.min(360, Number(b.durationMin) || 30));
  const notes = esc(b.notes).trim().slice(0, 400);
  if (name.length < 2) return badRequest(res, 'Nom requis.');
  if (!validPhone(phone)) return badRequest(res, 'Téléphone invalide.');
  if (!DATE_RE.test(date)) return badRequest(res, 'Date invalide.');
  if (!/^\d{2}:\d{2}$/.test(time)) return badRequest(res, 'Heure invalide.');
  const fit = canFit(date, time, durationMin);
  if (!fit.ok) return sendJson(res, 409, { error: fit.reason });
  const reservation = {
    id: uid('rsv'), code: rsvCode(), clientId: null,
    name, phone, serviceId: null, serviceName, date, time,
    durationMin, endTime: minToTime(timeToMin(time) + durationMin),
    type, notes, status: 'confirmed', createdAt: new Date().toISOString(), via: 'admin',
  };
  db.reservations.unshift(reservation);
  saveDb();
  sendJson(res, 201, { reservation });
});
route('PUT', '/api/admin/reservations/:id', async (req, res, query, params) => {
  if (!adminAuth(req, res, query)) return;
  const b = await readBody(req);
  const r = db.reservations.find(x => x.id === params.id);
  if (!r) return notFound(res);
  const before = r.status;
  const allowed = ['pending', 'confirmed', 'done', 'cancelled', 'no_show'];
  if (b.status !== undefined && allowed.includes(b.status)) r.status = b.status;
  if (b.notes !== undefined) r.notes = esc(b.notes).trim().slice(0, 400);
  // confirmation d’un événement → le client est prévenu
  if (before === 'pending' && r.status === 'confirmed' && r.clientId) {
    const c = db.clients.find(x => x.id === r.clientId);
    if (c) {
      const dateLabel = new Date(r.date + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
      const title = 'Réservation confirmée';
      const body = `${r.serviceName} — ${dateLabel} à ${r.time}. On vous attend, le fauteuil est réservé.`;
      db.notifications.unshift({ id: uid('ntf'), clientId: c.id, title, body, kind: 'reservation', createdAt: new Date().toISOString(), readAt: null });
      sendPush(c, { title, body, url: tenantHomeUrl() }).catch(() => {});
    }
  }
  saveDb();
  sendJson(res, 200, { reservation: r });
});
route('DELETE', '/api/admin/reservations/:id', (req, res, query, params) => {
  if (!adminAuth(req, res, query)) return;
  db.reservations = db.reservations.filter(r => r.id !== params.id);
  saveDb();
  sendJson(res, 200, { ok: true });
});

/* ---- admin: reminders (ré-engagement +14 jours) --------------------------- */
route('POST', '/api/admin/remind-lapsed', async (req, res) => {
  if (!adminAuth(req, res, new URLSearchParams())) return;
  const body = await readBody(req);
  const days = Number(body.days) || db.shop.reminderDays;
  const title = esc(body.title || '').trim().slice(0, 120) || 'Votre chevelure s’impatiente';
  const message = esc(body.message || '').trim().slice(0, 300) ||
    'Ça fait un moment… votre chevelure réclame le barbier. Passez quand vous voulez, on vous garde la chaise.';
  const cooldown = 10 * 864e5; // pas plus d’une relance / 10 jours / client
  const targets = lapsedClients(days).filter(c => !c.lastReminderAt || now() - new Date(c.lastReminderAt).getTime() > cooldown);
  const t = new Date().toISOString();
  let pushed = 0;
  for (const c of targets) {
    const notif = { id: uid('ntf'), clientId: c.id, title, body: message, kind: 'reminder', createdAt: t, readAt: null };
    db.notifications.unshift(notif);
    c.lastReminderAt = t;
    db.counters.remindersSent += 1;
    const r = await sendPush(c, { title, body: message, url: tenantHomeUrl() }).catch(() => ({ sent: 0 }));
    pushed += r.sent;
  }
  db.notifications = db.notifications.slice(0, 1000);
  saveDb();
  sendJson(res, 200, { sent: targets.length, pushed, skipped: lapsedClients(days).length - targets.length, title, body: message });
});

/* ---- admin: services CRUD -------------------------------------------------- */
route('GET', '/api/admin/services', (req, res, query) => {
  if (!adminAuth(req, res, query)) return;
  sendJson(res, 200, { services: db.services });
});
route('POST', '/api/admin/services', async (req, res) => {
  if (!adminAuth(req, res, new URLSearchParams())) return;
  const b = await readBody(req);
  if (!esc(b.name).trim()) return badRequest(res, 'Nom du service requis.');
  const svc = { id: uid('srv'), name: esc(b.name).trim().slice(0, 120), desc: esc(b.desc).trim().slice(0, 200), price: Number(b.price) || 0, minutes: Number(b.minutes) || 30, active: b.active !== false };
  db.services.push(svc); saveDb();
  sendJson(res, 201, { service: svc });
});
route('PUT', '/api/admin/services/:id', async (req, res, query, params) => {
  if (!adminAuth(req, res, query)) return;
  const b = await readBody(req);
  const svc = db.services.find(s => s.id === params.id);
  if (!svc) return notFound(res);
  if (b.name !== undefined) svc.name = esc(b.name).trim().slice(0, 120);
  if (b.desc !== undefined) svc.desc = esc(b.desc).trim().slice(0, 200);
  if (b.price !== undefined) svc.price = Number(b.price) || 0;
  if (b.minutes !== undefined) svc.minutes = Number(b.minutes) || 30;
  if (b.active !== undefined) svc.active = !!b.active;
  saveDb();
  sendJson(res, 200, { service: svc });
});
route('DELETE', '/api/admin/services/:id', (req, res, query, params) => {
  if (!adminAuth(req, res, query)) return;
  db.services = db.services.filter(s => s.id !== params.id); saveDb();
  sendJson(res, 200, { ok: true });
});

/* ---- admin: offers CRUD ----------------------------------------------------- */
route('GET', '/api/admin/offers', (req, res, query) => {
  if (!adminAuth(req, res, query)) return;
  sendJson(res, 200, { offers: db.offers });
});
route('POST', '/api/admin/offers', async (req, res) => {
  if (!adminAuth(req, res, new URLSearchParams())) return;
  const b = await readBody(req);
  if (!esc(b.title).trim()) return badRequest(res, 'Titre requis.');
  const offer = { id: uid('off'), title: esc(b.title).trim().slice(0, 120), desc: esc(b.desc).trim().slice(0, 240), badge: esc(b.badge).trim().slice(0, 24) || 'Offre', active: b.active !== false };
  db.offers.push(offer); saveDb();
  sendJson(res, 201, { offer });
});
route('PUT', '/api/admin/offers/:id', async (req, res, query, params) => {
  if (!adminAuth(req, res, query)) return;
  const b = await readBody(req);
  const offer = db.offers.find(o => o.id === params.id);
  if (!offer) return notFound(res);
  if (b.title !== undefined) offer.title = esc(b.title).trim().slice(0, 120);
  if (b.desc !== undefined) offer.desc = esc(b.desc).trim().slice(0, 240);
  if (b.badge !== undefined) offer.badge = esc(b.badge).trim().slice(0, 24);
  if (b.active !== undefined) offer.active = !!b.active;
  saveDb();
  sendJson(res, 200, { offer });
});
route('DELETE', '/api/admin/offers/:id', (req, res, query, params) => {
  if (!adminAuth(req, res, query)) return;
  db.offers = db.offers.filter(o => o.id !== params.id); saveDb();
  sendJson(res, 200, { ok: true });
});

/* ---- admin: settings -------------------------------------------------------- */
route('GET', '/api/admin/settings', (req, res, query) => {
  if (!adminAuth(req, res, query)) return;
  const s = { ...db.shop }; delete s.adminPin; delete s.adminPinHash;
  sendJson(res, 200, { settings: s, adminPinSet: true, accents: Object.keys(ACCENTS) });
});
route('PUT', '/api/admin/settings', async (req, res, query) => {
  if (!adminAuth(req, res, query)) return;
  const b = await readBody(req);
  const s = db.shop;
  for (const k of ['name', 'tagline', 'address', 'phone', 'hoursLabel', 'rewardLabel']) {
    if (b[k] !== undefined) s[k] = esc(b[k]).trim().slice(0, 140);
  }
  for (const k of ['stampGoal', 'reminderDays', 'maxPerDay', 'minNoticeMinutes']) {
    if (b[k] !== undefined && Number.isFinite(Number(b[k]))) s[k] = Number(b[k]);
  }
  if (b.openTime !== undefined && /^\d{2}:\d{2}$/.test(b.openTime)) s.openTime = b.openTime;
  if (b.closeTime !== undefined && /^\d{2}:\d{2}$/.test(b.closeTime)) s.closeTime = b.closeTime;
  if (timeToMin(s.openTime) >= timeToMin(s.closeTime)) { s.openTime = '09:00'; s.closeTime = '20:00'; }
  if (Array.isArray(b.workingDays)) {
    const days = [...new Set(b.workingDays.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b2) => a - b2);
    s.workingDays = days.length ? days : [1, 2, 3, 4, 5, 6];
  }
  if (b.acceptReservations !== undefined) s.acceptReservations = !!b.acceptReservations;
  if (b.currency !== undefined) { const c = String(b.currency).trim().toUpperCase().replace(/[^A-Z€$£]/g, '').slice(0, 4); if (c) s.currency = c; }
  if (b.adminPin !== undefined && String(b.adminPin).trim().length >= 4) s.adminPinHash = scryptHash(String(b.adminPin).trim().slice(0, 24));
  if (b.accent !== undefined && ACCENTS[b.accent]) s.accent = b.accent;
  if (b.monogram !== undefined) s.monogram = String(b.monogram).trim().slice(0, 3).toUpperCase() || s.monogram;
  saveDb();
  sendJson(res, 200, { ok: true });
});


route('GET', '/api/admin/report', (req, res, query) => {
  if (!adminAuth(req, res, query)) return;
  const start = new Date(); start.setDate(1); start.setHours(0, 0, 0, 0);
  const monthStart = start.getTime();
  const monthLabel = new Date().toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  const visitsThisMonth = db.visits.filter(v => new Date(v.at).getTime() >= monthStart).length;
  const newThisMonth = db.clients.filter(c => new Date(c.createdAt).getTime() >= monthStart).length;
  const activeClients = db.clients.filter(c => c.lastVisitAt && (now() - new Date(c.lastVisitAt).getTime()) < 30 * 864e5).length;
  const birthdaysThisMonth = db.clients.filter(c => c.birthday && Number(String(c.birthday).split('-')[1]) === new Date().getMonth() + 1).length;
  const topActive = db.clients.slice().sort((a, b) => b.totalVisits - a.totalVisits).slice(0, 5).map(c => ({ name: c.name, visits: c.totalVisits, stamps: c.stamps }));
  const reminder = reminderStats(90);
  sendJson(res, 200, {
    monthLabel,
    generatedAt: new Date().toISOString(),
    totalClients: db.clients.length,
    newThisMonth,
    activeClients,
    lapsedClients: lapsedClients(db.shop.reminderDays).length,
    visitsThisMonth,
    visitsTotal: db.visits.length,
    rewardsRedeemed: db.clients.reduce((a, c) => a + c.rewardsRedeemed, 0),
    stampsInCircles: db.clients.reduce((a, c) => a + c.stamps, 0),
    stampsIssuedAllTime: db.counters.stampsIssued,
    reminder,
    birthdaysThisMonth,
    topActive,
  });
});

/* ---- QR codes (SVG) ---------------------------------------------------------- */
async function qrSvg(text, dark = '#16301F', light = '#F6F1E7') {
  return QRCode.toString(text, { type: 'svg', margin: 1, width: 512, color: { dark, light } });
}
route('GET', '/api/counter-qr', async (req, res) => {
  const origin = process.env.BASE_URL || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
  const svg = await qrSvg(`${origin}/s/${db.shop.slug}/`);
  res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
  res.end(svg);
});
route('GET', '/api/client-qr', async (req, res, query) => {
  const c = db.clients.find(x => x.token === query.get('token'));
  if (!c) return sendJson(res, 401, { error: 'Carte introuvable.' });
  const svg = await qrSvg(`LEBARBIER:${c.code}`);
  res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
  res.end(svg);
});

/* ============================================================== super-admin (le vendeur) */
const superSessions = new Map(); // token -> expiry
const superSessionOk = (req) => {
  const s = req.headers['x-super-session'];
  const e = s && superSessions.get(s);
  return !!(e && e > now());
};
function findTenantById(id) { return platform.tenants.find(t => t.id === id) || null; }
function tenantStats(t) {
  const store = platform.stores[t.id];
  if (!store) return { clients: 0, stamps: 0, reservations: 0 };
  return {
    clients: store.clients.length,
    stamps: store.counters.stampsIssued || 0,
    reservations: store.reservations.length,
    rewards: store.counters.rewardsRedeemed || 0,
  };
}
function tenantPublic(t) {
  return {
    id: t.id, slug: t.slug, name: t.name, tagline: t.tagline, address: t.address, phone: t.phone,
    currency: t.currency, status: t.status, trialEndsAt: t.trialEndsAt, currentPeriodEnd: t.currentPeriodEnd,
    monthlyPrice: t.monthlyPrice, paymentLink: t.paymentLink || '',
    createdAt: t.createdAt, notes: t.notes || '',
    accent: t.accent, monogram: t.monogram,
    active: tenantIsActive(t),
    stats: tenantStats(t),
  };
}
const readBodyMaybe = (req) => readBody(req);
async function handleSuperApi(req, res, rest) {
  await (async () => {
    if (rest === '/api/health' || rest === '/api/login') {
      // fallthrough below
    }
    if (rest === '/api/login' && req.method === 'POST') {
      const body = await readBodyMaybe(req);
      if (String(body.pin) !== String(SUPER_ADMIN_PIN)) return sendJson(res, 403, { error: 'Code super-admin incorrect.' });
      const s = crypto.randomBytes(24).toString('hex');
      superSessions.set(s, now() + 12 * 3600e3);
      return sendJson(res, 200, { session: s });
    }
    if (!superSessionOk(req)) return sendJson(res, 401, { error: 'Session super-admin requise.' });

    if (rest === '/api/overview' && req.method === 'GET') {
      const tenants = platform.tenants.map(tenantPublic);
      const mrr = platform.tenants.filter(t => t.status === 'active').reduce((sum, t) => sum + (Number(t.monthlyPrice) || 0), 0);
      const trialSoon = platform.tenants.filter(t => t.status === 'trial' && t.trialEndsAt && new Date(t.trialEndsAt) > new Date() && (new Date(t.trialEndsAt) - new Date()) < 7 * 864e5).map(t => ({ slug: t.slug, name: t.name, trialEndsAt: t.trialEndsAt }));
      return sendJson(res, 200, { tenants, mrr, counts: { total: tenants.length, active: tenants.filter(t => t.status === 'active').length, trial: tenants.filter(t => t.status === 'trial').length, paused: tenants.filter(t => t.status === 'paused').length }, trialSoon });
    }
    if (rest === '/api/tenants' && req.method === 'POST') {
      const b = await readBodyMaybe(req);
      const name = String(b.name || '').trim().slice(0, 80);
      if (!name) return sendJson(res, 400, { error: 'Nom du salon requis.' });
      let slug = slugify(b.slug || name);
      let candidate = slug, i = 2;
      while (findTenantBySlug(candidate)) candidate = slug + '-' + (i++);
      slug = candidate;
      const pin = String(b.pin || String(Math.floor(100000 + Math.random() * 900000))).trim();
      if (pin.length < 4) return sendJson(res, 400, { error: 'Le code PIN doit faire au moins 4 caractères.' });
      const t = makeTenant({
        slug, name, tagline: b.tagline, address: b.address, phone: b.phone,
        currency: b.currency || 'DT', openTime: b.openTime, closeTime: b.closeTime,
        adminPin: pin, status: ['trial', 'active'].includes(b.status) ? b.status : 'trial',
        trialDays: Number(b.trialDays) || 14, monthlyPrice: b.monthlyPrice !== undefined ? Number(b.monthlyPrice) : 40,
        paymentLink: b.paymentLink || '', accent: b.accent || 'brass', monogram: b.monogram, notes: b.notes,
      });
      platform.tenants.push(t);
      const store = seedRoyalStore(t); // base minimale générique (services + offres d'amorçage)
      store.clients = []; store.counters = { stampsIssued: 0, rewardsRedeemed: 0, remindersSent: 0 };
      platform.stores[t.id] = store;
      saveDb(); await flushPersist();
      return sendJson(res, 201, { tenant: tenantPublic(t), adminPin: pin });
    }
    const m = rest.match(/^\/api\/tenants\/([^/]+)(\/(pay|pause|resume|delete))?$/);
    if (m) {
      const t = findTenantById(m[1]);
      if (!t) return sendJson(res, 404, { error: 'Salon introuvable.' });
      const action = m[3];
      if (!action && req.method === 'GET') return sendJson(res, 200, { tenant: tenantPublic(t) });
      if (action === 'pay' && req.method === 'POST') {
        t.status = 'active';
        t.currentPeriodEnd = new Date(Date.now() + 30 * 864e5).toISOString();
        t.trialEndsAt = null;
        saveDb(); await flushPersist();
        return sendJson(res, 200, { tenant: tenantPublic(t) });
      }
      if (action === 'pause' && req.method === 'POST') { t.status = 'paused'; saveDb(); await flushPersist(); return sendJson(res, 200, { tenant: tenantPublic(t) }); }
      if (action === 'resume' && req.method === 'POST') {
        t.status = 'active'; t.currentPeriodEnd = new Date(Date.now() + 30 * 864e5).toISOString(); t.trialEndsAt = null;
        saveDb(); await flushPersist(); return sendJson(res, 200, { tenant: tenantPublic(t) });
      }
      if (action === 'delete' && req.method === 'POST') {
        platform.tenants = platform.tenants.filter(x => x.id !== t.id);
        delete platform.stores[t.id];
        saveDb(); await flushPersist(); return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 405, { error: 'Méthode non autorisée.' });
    }
    return sendJson(res, 404, { error: 'Action inconnue.' });
  })().catch(err => { console.error('[super]', err); if (!res.headersSent) sendJson(res, 500, { error: 'Erreur super-admin.' }); });
}

/* ============================================================== server */
const server = http.createServer(async (req, res) => {
  try {
    // tolère les doubles slashes AVANT le parsing (//x serait vu comme une URL protocol-relative → ERR_INVALID_URL)
    const rawReq = String(req.url || '/');
    const qIndex = rawReq.indexOf('?');
    const rawPath = (qIndex === -1 ? rawReq : rawReq.slice(0, qIndex)).replace(/\/{2,}/g, '/') || '/';
    const url = new URL(rawPath + (qIndex === -1 ? '' : rawReq.slice(qIndex)), `http://${req.headers.host || 'localhost'}`);
    const pathname = decodePathnameSafe(url);

    if (pathname === '/healthz') return sendJson(res, 200, { ok: true });

    /* ---------- salons (multi-tenant) : /s/:slug/… ---------- */
    const tm = pathname.match(/^\/s\/([a-z0-9][a-z0-9-]{0,39})(\/.*)?$/);
    if (tm) {
      const tenant = findTenantBySlug(tm[1]);
      if (!tenant) return sendHtml(res, '<!doctype html><title>Salon introuvable</title><body style="font-family:sans-serif;background:#16301F;color:#F6F1E7;display:grid;place-items:center;height:100vh;text-align:center"><div><h1>Salon introuvable</h1><p><a style="color:#E3C878" href="/">Retour à CarteBarber</a></p></div>', 404);
      const rest = tm[2] || '/';
      const store = tenantStore(tenant);
      return als.run(store, async () => {
        try {
          // abonnement inactif → tout est verrouillé sauf la page de paiement
          if (!tenantIsActive(tenant)) {
            if (rest.startsWith('/api/')) return sendJson(res, 402, { error: 'L’abonnement de ce salon est inactif.', paywall: true, paymentLink: tenant.paymentLink || process.env.PAYMENT_LINK || '' });
            return servePaywall(res, tenant);
          }
          for (const r of routes) {
            const params = match(r.pattern, rest);
            if (req.method === r.method && params) { const out = await r.handler(req, res, url.searchParams, params); await flushPersist(); return out; }
          }
          if (rest === '/manifest.webmanifest' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-store' });
            return res.end(JSON.stringify({
              name: tenant.name + ' — Carte de fidélité',
              short_name: tenant.name.slice(0, 12),
              description: 'La carte de fidélité de ' + tenant.name + ', sans application.',
              start_url: '/s/' + tenant.slug + '/',
              display: 'standalone',
              background_color: '#16301F',
              theme_color: '#16301F',
              lang: 'fr',
              icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
            }));
          }
          const pageKey = rest.replace(/\.html$/, '').replace(/\/+$/, '') || '/';
          if (req.method === 'GET' && TENANT_PAGES[pageKey]) return serveTenantPage(res, TENANT_PAGES[pageKey], tenant);
          if (req.method === 'GET') return serveStaticFile(res, rest); // laisse passer /js /css /img éventuels sous le préfixe
          notFound(res, rest);
        } catch (err) {
          console.error('[error]', err);
          if (!res.headersSent) sendJson(res, 500, { error: 'Erreur serveur.' });
        } finally { await flushPersist(); }
      });
    }

    /* ---------- super-admin (le vendeur) : /super ---------- */
    if (pathname === '/super') return serveStaticFile(res, '/super.html');
    if (pathname.startsWith('/super/api/')) return handleSuperApi(req, res, pathname.slice('/super'.length));

    /* ---------- plateforme : landing + assets globaux ---------- */
    if (pathname === '/') return serveStaticFile(res, '/landing.html');
    if (req.method === 'GET') return serveStaticFile(res, pathname);
    notFound(res, pathname);
  } catch (err) {
    console.error('[error]', err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Erreur serveur.' });
  }
});

async function boot() {
  await loadPlatform();
  ensureVapid();
  if (IS_PG) await flushPersist();
}

if (require.main === module) {
  boot().then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`\n  CarteBarber — la carte de fidélité des barbiers`);
      console.log(`  Plateforme : http://localhost:${PORT}/`);
      for (const t of platform.tenants) {
        console.log(`  ${t.status.padEnd(7)} ${t.slug.padEnd(12)} → http://localhost:${PORT}/s/${t.slug}/`);
      }
      console.log(`  Super-admin : http://localhost:${PORT}/super  (PIN : ${SUPER_ADMIN_PIN})\n`);
    });
  }).catch(err => { console.error('[boot]', err); process.exit(1); });
} else {
  module.exports = { server, listener: server.listeners('request')[0], boot, loadPlatform, ensureVapid };
}
