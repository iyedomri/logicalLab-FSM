/**
 * Le Barbier de Carthage — Carte de fidélité digitale (démo)
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

const PORT = process.env.PORT || 3000;
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

/* ------------------------------------------------------------ seed data */
function seedDb() {
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
  return {
    shop: {
      name: 'Le Barbier de Carthage',
      tagline: 'Coiffure & rasage traditionnel',
      address: 'Avenue Habib Bourguiba, Tunis',
      phone: '+216 71 000 000',
      hoursLabel: 'Lun – Sam · 9h à 20h',
      openTime: '09:00', closeTime: '20:00', workingDays: [1, 2, 3, 4, 5, 6], // lundi → samedi
      acceptReservations: true, maxPerDay: 12, minNoticeMinutes: 60,
      currency: 'DT',
      adminPin: '1234',
      stampGoal: 10,
      rewardLabel: 'Coupe offerte',
      reminderDays: 14,
    },
    vapid: null,
    pings: [],
    clients: [
      Object.assign(mk('Yassine Trabelsi', '+21620112233', 6, 3, 21, 2), { birthday: '1990-' + new Date().toISOString().slice(5, 10) }), // anniversaire démo : aujourd'hui
      mk('Mehdi Ben Salah', '+21655667788', 9, 0, 19, 1),  // à un tampon de la récompense
      mk('Anis Khelifi', '+21698765432', 2, 21, 12, 1),    // inactif 21 j → relance demo
      mk('Slim Chaabane', '+21622334455', 4, 17, 9, 0),    // inactif 17 j → relance demo
      mk('Rami Gharbi', '+21650998877', 8, 6, 27, 2),
      mk('Khalil Mansour', '+21671122334', 0, null, 1, 0),
    ],
    services: [
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
    ],
    offers: [
      { id: uid('off'), title: 'Happy Hour', desc: 'Mar – Jeu · 14h → 17h : –20% sur la coupe', badge: '-20%', active: true },
      { id: uid('off'), title: 'Duo père-fils', desc: 'Samedi matin : –15% sur vos deux coupes', badge: '-15%', active: true },
      { id: uid('off'), title: 'Parrainage', desc: 'Vous + votre ami = +1 tampon pour chacun', badge: '+1 tampon', active: true },
      { id: uid('off'), title: 'Produit offert', desc: 'Cire coiffante offerte dès 30 DT d’achat', badge: 'Offert', active: true },
    ],
    notifications: [],
    visits: [],
    reservations: [],
    ___seedReservations: true,
    counters: { stampsIssued: 165, rewardsRedeemed: 6, remindersSent: 0 },
    createdAt: new Date().toISOString(),
  };
}
function seedReservations(dbx) {
  const today = localDateStr();
  const d2 = new Date(Date.now() + 864e5);
  while (!workingDays().includes(d2.getDay())) d2.setDate(d2.getDate() + 1); // prochain jour travaillé
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

/* ------------------------------------------------------------- store */
let db;
function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    console.log(`[db] ${db.clients.length} clients chargés`);
  } catch {
    db = seedDb();
    seedReservations(db);
    saveDb();
    console.log('[db] base initialisée avec données de démonstration');
  }
  if (db && !db.reservations) db.reservations = [];
  if (db && !Array.isArray(db.shop.workingDays)) { db.shop.workingDays = [1, 2, 3, 4, 5, 6]; db.shop.openTime = db.shop.openTime || '09:00'; db.shop.closeTime = db.shop.closeTime || '20:00'; }
}
function saveDb() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

/* ---------------------------------------------------- admin sessions */
const sessions = new Map(); // token -> expiry
const newSession = () => {
  const s = crypto.randomBytes(24).toString('hex');
  sessions.set(s, now() + 12 * 3600e3);
  return s;
};
const validSession = (s) => s && sessions.has(s) && sessions.get(s) > now();

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
const notFound = (res) => sendJson(res, 404, { error: 'Introuvable' });
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
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  if (rel === '/admin') rel = '/admin.html';
  if (rel === '/poster') rel = '/poster.html';
  if (rel === '/display') rel = '/display.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return notFound(res);
  fs.readFile(file, (err, buf) => {
    if (err) return notFound(res);
    const ext = path.extname(file).toLowerCase();
    const cache = ['.html', '.webmanifest'].includes(ext) ? 'no-store' : 'public, max-age=3600';
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache });
    res.end(buf);
  });
}

/* ============================================================ routes */
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });
const match = (pattern, pathname) => {
  const pp = pattern.split('/'), up = pathname.split('/');
  if (pp.length !== up.length) return null;
  const params = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(up[i]);
    else if (pp[i] !== up[i]) return null;
  }
  return params;
};


/* ---- Web Push (VAPID) — activé quand le navigateur accepte ------------------ */
function ensureVapid() {
  if (!db.vapid) {
    try { const keys = webpush.generateVAPIDKeys(); db.vapid = { publicKey: keys.publicKey, privateKey: keys.privateKey }; }
    catch (e) { console.error('[push] VAPID generation failed', e); return false; }
  }
  try { webpush.setVapidDetails('mailto:contact@barbier-carthage.tn', db.vapid.publicKey, db.vapid.privateKey); }
  catch (e) { console.error('[push] VAPID setup failed', e); return false; }
  return true;
}
async function sendPush(c, payload) {
  const subs = c.pushSubscriptions || [];
  if (!subs.length || !db.vapid) return { sent: 0, dead: 0 };
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
  const body = 'Le Barbier vous offre la coupe à –50 % aujourd’hui. Venez fêter ça dans le fauteuil.';
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
        res.locals = { referralApplied: true, referrerName: referrer.name.split(' ')[0] };
      }
    }
    maybeBirthday(client);
  } else if (birthday && !client.birthday) {
    client.birthday = birthday;
  }
  saveDb();
  sendJson(res, created ? 201 : 200, { token: client.token, code: client.code, created, card: clientPublic(client), reward: rewardState(client), referralApplied: !!(res.locals && res.locals.referralApplied) });
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
  const bodyTxt = `${serviceName} — ${dateLabel} à ${time} chez Le Barbier.` + (type === 'event' ? ' Le barbier vous rappelle pour caler les détails.' : ` Présentez-vous 5 min avant — le fauteuil vous attend.`);
  if (linked) {
    db.notifications.unshift({ id: uid('ntf'), clientId: linked.id, title, body: bodyTxt, kind: 'reservation', createdAt: new Date().toISOString(), readAt: null });
    sendPush(linked, { title, body: bodyTxt, url: '/' }).catch(() => {});
  }
  saveDb();
  sendJson(res, 201, { reservation, message: status === 'confirmed' ? 'C’est noté — à très vite chez Le Barbier.' : 'Demande envoyée — le barbier vous confirme rapidement.' });
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
  sendJson(res, 200, { publicKey: db.vapid.publicKey });
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
  if (String(body.pin) !== String(db.shop.adminPin)) return sendJson(res, 403, { error: 'Code PIN incorrect.' });
  sendJson(res, 200, { session: newSession(), shopName: db.shop.name });
});
function adminAuth(req, res, query) {
  const s = (req.headers['x-admin-session']) || (query && query.get('session'));
  if (!validSession(s)) { sendJson(res, 401, { error: 'Session expirée. Reconnectez-vous.' }); return null; }
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
  db.clients = db.clients.filter(c => c.id !== params.id);
  db.notifications = db.notifications.filter(n => n.clientId !== params.id);
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
      sendPush(c, { title, body, url: '/' }).catch(() => {});
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
    const r = await sendPush(c, { title, body: message, url: '/' }).catch(() => ({ sent: 0 }));
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
  const s = { ...db.shop }; delete s.adminPin;
  sendJson(res, 200, { settings: s, adminPinSet: true });
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
  if (b.adminPin !== undefined && String(b.adminPin).trim().length >= 4) s.adminPin = String(b.adminPin).trim().slice(0, 24);
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
  const origin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
  const svg = await qrSvg(`${origin}/`);
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

/* ============================================================== server */
loadDb();
ensureVapid();
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    for (const r of routes) {
      const params = match(r.pattern, pathname);
      if (req.method === r.method && params) return await r.handler(req, res, url.searchParams, params);
    }
    if (req.method === 'GET') return serveStatic(req, res, pathname);
    notFound(res);
  } catch (err) {
    console.error('[error]', err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Erreur serveur.' });
  }
});
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Le Barbier de Carthage — carte de fidélité`);
  console.log(`  Client  : http://localhost:${PORT}/`);
  console.log(`  Admin   : http://localhost:${PORT}/admin  (PIN : ${db.shop.adminPin})`);
  console.log(`  Poster  : http://localhost:${PORT}/poster\n`);
});
