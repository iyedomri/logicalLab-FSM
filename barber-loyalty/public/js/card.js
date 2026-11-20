/* Le Barbier de Carthage — logique de la carte client */
'use strict';

const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => [...p.querySelectorAll(s)];
const TOKEN_KEY = 'barbier_card_token';
const token = () => localStorage.getItem(TOKEN_KEY);
const urlParams = new URLSearchParams(location.search);
const refCode = (urlParams.get('ref') || '').toUpperCase(); // code parrain en lien partagé

let shop = null;
let state = { stamps: 0, stampGoal: 10 };
let seenNotifIds = new Set(JSON.parse(sessionStorage.getItem('barbier_seen') || '[]'));
let pollTimer = null;

const toastEl = $('#toast');
let toastTimer = null;
function toast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.classList.toggle('error', !!isError);
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 4200);
}

const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  let data = null;
  try { data = await res.json(); } catch { /* svg etc. */ }
  if (!res.ok) throw Object.assign(new Error((data && data.error) || 'Erreur réseau'), { status: res.status, data });
  return data;
};

const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

/* ---------- ouverture du salon (calcul en direct) ---------- */
const tToMin = (t) => { const [h, m] = String(t).split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const fmtTFr = (t) => { const [h, m] = String(t).split(':'); const H = Number(h); return m === '00' ? H + 'h' : H + 'h' + m; };
const isShopOpenNow = () => {
  if (!shop) return false;
  const nowD = new Date();
  const day = nowD.getDay();
  if (Array.isArray(shop.workingDays) && !shop.workingDays.includes(day)) return false;
  const mins = nowD.getHours() * 60 + nowD.getMinutes();
  return mins >= tToMin(shop.openTime || '09:00') && mins < tToMin(shop.closeTime || '20:00');
};
function renderOpenState() {
  const el = $('#openState');
  if (!shop) return;
  const open = isShopOpenNow();
  el.classList.toggle('open', open);
  el.classList.toggle('closed', !open);
  el.innerHTML = open
    ? '<i class="pulse"></i>Ouvert · ferme à ' + fmtTFr(shop.closeTime || '20:00')
    : '<i class="pulse"></i>Fermé · ouvre à ' + fmtTFr(shop.openTime || '09:00');
}

/* ---------- rendu de la carte ---------- */
const SCISSORS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>';
const GIFT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></svg>';

function renderCard(card, reward) {
  state = { stamps: card.stamps, stampGoal: reward.stampGoal };
  $('#cardCode').textContent = card.code;
  $('#cardName').textContent = card.name;
  $('#statusCount').textContent = `${card.stamps}/${reward.stampGoal}`;
  $('#progressFill').style.width = `${Math.min(100, (card.stamps / reward.stampGoal) * 100)}%`;

  const grid = $('#stampsGrid');
  grid.innerHTML = '';
  for (let i = 1; i <= reward.stampGoal; i++) {
    const filled = i <= card.stamps;
    const isGift = i === reward.stampGoal;
    const div = document.createElement('div');
    div.className = 'stamp' + (isGift ? ' gift' : '') + (filled ? ' filled' : '');
    div.innerHTML = filled ? (isGift ? GIFT : SCISSORS) : (isGift ? GIFT : `<span class="num">${i}</span>`);
    div.setAttribute('aria-label', isGift ? 'Coupe offerte' : `Tampon ${i}${filled ? ' validé' : ''}`);
    grid.appendChild(div);
  }

  const ready = reward.rewardReady;
  $('#rewardBanner').classList.toggle('hidden', !ready);
  $('#statusText').innerHTML = ready
    ? 'Carte complète — bien joué.'
    : `Encore <b>${reward.remaining}</b> tampon${reward.remaining > 1 ? 's' : ''} avant <b>${shop ? shop.rewardLabel.toLowerCase() : 'votre récompense'}</b>`;

  $('#clientQr').src = '/api/client-qr?token=' + encodeURIComponent(token());
  $('#clientQrCode').textContent = card.code;
}

function applyReservationMode() {
  const walkInOnly = shop && shop.acceptReservations === false;
  const btn = $('#openReserve');
  if (btn) btn.textContent = walkInOnly ? 'Walk-in uniquement' : 'Réserver';
  if (btn) btn.disabled = !!walkInOnly;
  const card = btn && btn.closest('.reserve-card');
  if (card) card.classList.toggle('walk-in', !!walkInOnly);
}

function renderServices(list) {
  $('#servicesList').innerHTML = list.map(s => `
    <div class="service">
      <div class="service-info">
        <div class="service-name">${escapeHtml(s.name)}</div>
        <div class="service-desc">${escapeHtml(s.desc || '')}${s.minutes ? ' · ' + s.minutes + ' min' : ''}</div>
      </div>
      <span class="dots"></span>
      <div class="service-price">${s.price} ${shop.currency}</div>
    </div>`).join('');
}
function renderOffers(list) {
  $('#offersList').innerHTML = list.map(o => `
    <div class="offer">
      <span class="offer-badge">${escapeHtml(o.badge)}</span>
      <b>${escapeHtml(o.title)}</b>
      <p>${escapeHtml(o.desc)}</p>
    </div>`).join('');
}
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

function showCardView() { $('#joinView').classList.add('hidden'); $('#cardView').classList.remove('hidden'); }
function showJoinView() { $('#cardView').classList.add('hidden'); $('#joinView').classList.remove('hidden'); renderBusyStrip(); }

async function loadCard() {
  const data = await api('/api/card?token=' + encodeURIComponent(token()));
  shop = data.shop;
  renderOpenState();
  $('#birthdayRibbon').classList.toggle('hidden', !data.isBirthdayToday);
  renderCard(data.card, data.reward);
  $('#referralCode').textContent = data.card.referralCode || data.card.code;
  renderServices(shop.services);
  renderOffers(shop.offers);
  $('#footPhone').textContent = shop.phone;
  applyReservationMode();
  showCardView();
  startPolling();
  refreshLiveBits();
}

/* ---------- « je suis en route » + parrainage ---------- */
$('#onmywayBtn').addEventListener('click', async () => {
  $('#onmywayBtn').disabled = true;
  try { const data = await api('/api/onmyway', { method: 'POST', body: JSON.stringify({ token: token() }) }); toast(data.message); }
  catch (err) { toast(err.message, true); }
  finally { setTimeout(() => { $('#onmywayBtn').disabled = false; }, 1500); }
});
$('#copyReferral').addEventListener('click', async () => {
  const code = $('#referralCode').textContent.trim();
  const link = location.origin + '/?ref=' + encodeURIComponent(code);
  try { await navigator.clipboard.writeText(link); toast('Lien de parrainage copié : ' + link); }
  catch { try { await navigator.clipboard.writeText(code); toast('Code copié : ' + code); } catch { toast('Code : ' + code); } }
});

/* ---------- notifications (ré-engagement) ---------- */
async function pollNotifications(initial = false) {
  if (!token()) return;
  try {
    const data = await api('/api/notifications?token=' + encodeURIComponent(token()));
    const badge = $('#bellBadge');
    badge.textContent = data.unread;
    badge.classList.toggle('hidden', data.unread === 0);
    const fresh = data.notifications.filter(n => !n.readAt && !seenNotifIds.has(n.id));
    for (const n of fresh) {
      seenNotifIds.add(n.id);
      if (!initial && 'Notification' in window && Notification.permission === 'granted' && document.hidden) {
        new Notification(n.title, { body: n.body, icon: '/icon.svg' });
      }
    }
    sessionStorage.setItem('barbier_seen', JSON.stringify([...seenNotifIds].slice(-100)));
    if (!$('#notifModal').classList.contains('hidden')) renderNotifList(data.notifications);
  } catch { /* hors-ligne : on réessaiera */ }
}
function startPolling() {
  clearInterval(pollTimer);
  pollNotifications(true);
  pollTimer = setInterval(() => pollNotifications(false), 20000);
}
function renderNotifList(items) {
  $('#notifList').innerHTML = items.length
    ? items.map(n => `<div class="notif${n.readAt ? '' : ' unread'}"><div><b>${escapeHtml(n.title)}</b><p>${escapeHtml(n.body)}</p><time>${fmtDate(n.createdAt)}</time></div></div>`).join('')
    : '<p style="font-size:12px;color:var(--ink-soft);padding:12px 4px">Rien pour l’instant. Votre barbier a de la retenue — profitez-en.</p>';
}

/* ---------- événements ---------- */
$('#joinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errBox = $('#joinError');
  errBox.classList.remove('show');
  const name = $('#fName').value.trim();
  const phone = $('#fPhone').value.trim();
  const birthday = $('#fBirthday').value || null;
  const ref = $('#fRef') ? $('#fRef').value.trim().toUpperCase() : '';
  try {
    const data = await api('/api/join', { method: 'POST', body: JSON.stringify({ name, phone, birthday, ref }) });
    localStorage.setItem(TOKEN_KEY, data.token);
    await loadCard();
    toast(data.referralApplied ? 'Parrainage appliqué : +1 tampon pour vous deux.' : (data.created ? 'Bienvenue chez Le Barbier — voici votre carte.' : 'Content de vous revoir — voici votre carte.'));
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.add('show');
  }
});
$('#bellBtn').addEventListener('click', async () => {
  $('#notifModal').classList.remove('hidden');
  try {
    const data = await api('/api/notifications?token=' + encodeURIComponent(token()));
    renderNotifList(data.notifications);
  } catch { $('#notifList').innerHTML = '<p style="font-size:12px">Impossible de charger les messages.</p>'; }
});
$('#notifReadAll').addEventListener('click', async () => {
  try { await api('/api/notifications/read', { method: 'POST', body: JSON.stringify({ token: token(), all: true }) }); } catch {}
  pollNotifications(true);
  const data = await api('/api/notifications?token=' + encodeURIComponent(token())).catch(() => null);
  if (data) renderNotifList(data.notifications);
});
const urlB64ToUint8Array = (base64String) => {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) arr[i] = raw.charCodeAt(i);
  return arr;
};
$('#enablePush').addEventListener('click', async () => {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    return toast('Ce navigateur ne gère pas les alertes push.', true);
  }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return toast('Alertes refusées — pas de souci.');
    const keyRes = await api('/api/push/key');
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(keyRes.publicKey) });
    }
    await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ token: token(), subscription: sub }) });
    toast('Alertes activées — votre téléphone sera prévenu, même la carte fermée.');
  } catch (err) {
    console.warn('[push]', err);
    toast('Impossible d’activer les alertes pour l’instant.', true);
  }
});
$('#privacyLink').addEventListener('click', (e) => { e.preventDefault(); $('#privacyModal').classList.remove('hidden'); });
$$('[data-close-modal]').forEach(b => b.addEventListener('click', () => b.closest('.modal-backdrop').classList.add('hidden')));
$$('.modal-backdrop').forEach(m => m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); }));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $$('.modal-backdrop').forEach(m => m.classList.add('hidden')); });


/* ================= LE FAUTEUIL — disponibilités & réservations ================= */
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const maxDateStr = () => { const d = new Date(Date.now() + 60 * 864e5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
let availabilityToday = null;

async function renderBusyStrip() {
  try {
    const a = await api('/api/availability?date=' + localToday());
    availabilityToday = a;
    const txt = a.closed
      ? 'Fermé aujourd’hui — le fauteuil se repose.'
      : a.busy.length === 0
        ? 'Libre toute la journée · ' + fmtTFr(a.openTime) + '–' + fmtTFr(a.closeTime)
        : 'Occupé : ' + a.busy.map(b => fmtTFr(b.from) + '–' + fmtTFr(b.to)).join(' · ') + ' — libre sinon';
    const joinEl = $('#busyStripJoin'); if (joinEl) joinEl.textContent = txt;
    const cardEl = $('#busyStripCard'); if (cardEl) cardEl.textContent = txt;
  } catch { /* discret si hors-ligne */ }
}

const fmtDateLong = (dateStr) => new Date(dateStr + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

async function renderMyReservations() {
  const wrap = $('#myReservationsWrap');
  if (!wrap) return;
  if (!token()) { wrap.classList.add('hidden'); return; }
  try {
    const data = await api('/api/my-reservations?token=' + encodeURIComponent(token()));
    if (!data.upcoming.length) { wrap.classList.add('hidden'); return; }
    wrap.classList.remove('hidden');
    $('#myReservations').innerHTML = data.upcoming.map(r => `
      <div class="my-res">
        <div class="my-res-date"><b>${new Date(r.date + 'T12:00:00').getDate()}</b><span>${new Date(r.date + 'T12:00:00').toLocaleDateString('fr-FR', { month: 'short' })}</span></div>
        <div class="my-res-info">
          <b>${escapeHtml(r.serviceName)}</b>
          <span>${fmtDateLong(r.date)} · ${fmtTFr(r.time)} – ${fmtTFr(r.endTime)}</span>
          <span class="my-res-status ${r.status}">${r.status === 'pending' ? 'En attente de confirmation' : 'Confirmée'} · ${escapeHtml(r.code)}</span>
        </div>
        <button class="mini-btn danger" data-cancel-res="${escapeHtml(r.id)}" title="Annuler">✕</button>
      </div>`).join('');
  } catch { wrap.classList.add('hidden'); }
}

let selectedSlot = null;
const reserveState = { durations: {} };

async function openReserveModal() {
  $('#reserveModal').classList.remove('hidden');
  $('#reserveFormView').classList.remove('hidden');
  $('#reserveDoneView').classList.add('hidden');
  selectedSlot = null;
  $('#rSubmit').disabled = true;
  const hasCard = !!token();
  $('#rNoCard').classList.toggle('hidden', hasCard);
  // services
  const sel = $('#rService');
  if (!sel.dataset.loaded) {
    try {
      const s = await api('/api/shop');
      reserveState.durations = {};
      sel.innerHTML = s.services.map(x => `<option value="${escapeHtml(x.id)}" data-dur="${x.minutes}">${escapeHtml(x.name)} — ${x.price} ${s.currency} · ${x.minutes} min</option>`).join('')
        + '<option value="__other">Autre demande / événement…</option>';
      sel.dataset.loaded = '1';
    } catch { sel.innerHTML = '<option value="__other">Autre demande…</option>'; }
  }
  // date min/max + default today
  const dInput = $('#rDate');
  dInput.min = localToday();
  dInput.max = maxDateStr();
  if (!dInput.value) dInput.value = localToday();
  toggleOther();
  await refreshReserveDay();
}
function toggleOther() {
  $('#rOtherWrap').classList.toggle('hidden', $('#rService').value !== '__other');
}
const currentDuration = () => {
  const sel = $('#rService');
  if (sel.value === '__other') return Number($('#rOtherDuration').value) || 60;
  const opt = sel.selectedOptions[0];
  return Number((opt && opt.dataset.dur) || 30);
};
async function refreshReserveDay() {
  const date = $('#rDate').value;
  if (!date) return;
  selectedSlot = null;
  $('#rSubmit').disabled = true;
  const busyEl = $('#reserveBusy');
  const slotsEl = $('#rSlots');
  const noSlotsEl = $('#rNoSlots');
  busyEl.textContent = 'Chargement des disponibilités…';
  slotsEl.innerHTML = '';
  noSlotsEl.classList.add('hidden');
  try {
    const [avail, slotsData] = await Promise.all([
      api('/api/availability?date=' + encodeURIComponent(date)),
      api('/api/slots?date=' + encodeURIComponent(date) + '&duration=' + currentDuration()),
    ]);
    busyEl.textContent = avail.closed
      ? 'Fermé ce jour-là — choisissez un autre jour.'
      : avail.busy.length
        ? 'Occupé (anonyme) : ' + avail.busy.map(b => fmtTFr(b.from) + '–' + fmtTFr(b.to)).join(' · ')
        : 'Personne n’est encore réservé ce jour-là — à vous la chaise.';
    const offered = slotsData.slots || [];
    if (!offered.filter(s => s.available).length) { noSlotsEl.classList.remove('hidden'); return; }
    slotsEl.innerHTML = offered.map(s => `<button type="button" class="slot${s.available ? '' : ' taken'}" data-time="${s.time}" ${s.available ? '' : 'disabled'}>${fmtTFr(s.time)}</button>`).join('');
  } catch (err) {
    busyEl.textContent = 'Impossible de charger les disponibilités.';
  }
}

$('#openReserve').addEventListener('click', () => { openReserveModal().catch(err => toast(err.message, true)); });
$('#rService').addEventListener('change', () => { toggleOther(); refreshReserveDay(); });
$('#rOtherDuration').addEventListener('change', () => refreshReserveDay());
$('#rDate').addEventListener('change', () => refreshReserveDay());
$('#rSlots').addEventListener('click', (e) => {
  const btn = e.target.closest('.slot');
  if (!btn || btn.disabled) return;
  selectedSlot = btn.dataset.time;
  $$('.slot', $('#rSlots')).forEach(b => b.classList.toggle('selected', b === btn));
  $('#rSubmit').disabled = false;
});

let lastReservation = null;
$('#rSubmit').addEventListener('click', async () => {
  if (!selectedSlot) return;
  $('#rSubmit').disabled = true;
  const hasCard = !!token();
  const payload = {
    token: hasCard ? token() : undefined,
    name: hasCard ? undefined : $('#rName').value.trim(),
    phone: hasCard ? undefined : $('#rPhone').value.trim(),
    date: $('#rDate').value,
    time: selectedSlot,
    type: $('#rEvent').checked ? 'event' : 'normal',
    notes: $('#rNotes').value.trim(),
  };
  const svc = $('#rService').value;
  if (svc === '__other') { payload.serviceName = $('#rOtherName').value.trim() || 'Sur demande'; payload.durationMin = Number($('#rOtherDuration').value) || 60; }
  else payload.serviceId = svc;
  try {
    const data = await api('/api/reserve', { method: 'POST', body: JSON.stringify(payload) });
    lastReservation = data.reservation;
    const r = data.reservation;
    $('#rDoneTitle').textContent = r.status === 'pending' ? 'Demande envoyée' : 'C’est noté';
    $('#rDoneCode').textContent = r.code;
    $('#rDoneSummary').textContent = `${r.serviceName} — ${fmtDateLong(r.date)} à ${fmtTFr(r.time)}`;
    $('#rDoneNote').textContent = r.status === 'pending'
      ? 'Le barbier vous rappelle pour caler les détails — vous serez prévenu dès confirmation.'
      : 'Présentez-vous 5 minutes avant. La chaise est réservée, le café est prêt.';
    $('#reserveFormView').classList.add('hidden');
    $('#reserveDoneView').classList.remove('hidden');
    renderBusyStrip();
    renderMyReservations();
  } catch (err) {
    toast(err.message, true);
    refreshReserveDay();
  }
});
$('#myReservations').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-cancel-res]');
  if (!btn) return;
  if (!confirm('Annuler cette réservation ?')) return;
  try {
    await api('/api/reservations/cancel', { method: 'POST', body: JSON.stringify({ token: token(), id: btn.dataset.cancelRes }) });
    toast('Réservation annulée.');
    renderMyReservations();
    renderBusyStrip();
  } catch (err) { toast(err.message, true); }
});
$('#rIcs').addEventListener('click', () => {
  const r = lastReservation;
  if (!r) return;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const dt = (d, t) => d.replace(/-/g, '') + 'T' + t.replace(':', '') + '00';
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Le Barbier de Carthage//Réservation//FR',
    'BEGIN:VEVENT',
    `UID:${r.code}@barbier-carthage.tn`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${dt(r.date, r.time)}`,
    `DTEND:${dt(r.date, r.endTime)}`,
    `SUMMARY:Le Barbier de Carthage — ${r.serviceName}`,
    'LOCATION:Avenue Habib Bourguiba\, Tunis',
    `DESCRIPTION:Réservation ${r.code} — ${r.serviceName} chez Le Barbier de Carthage.`,
    'BEGIN:VALARM', 'TRIGGER:-PT30M', 'ACTION:DISPLAY', 'DESCRIPTION:On vous attend au salon', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'le-barbier-' + r.code + '.ics';
  a.click();
  URL.revokeObjectURL(url);
});

/* ---------- init calls (called after join/load) ---------- */
function refreshLiveBits() { renderBusyStrip(); renderMyReservations(); }

/* ---------- PWA (optionnel, silencieux) ---------- */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

/* ---------- init ---------- */
(async function init() {
  if (refCode && $('#fRef')) $('#fRef').value = refCode;
  try { shop = await api('/api/shop'); renderOpenState(); $('#footPhone').textContent = shop.phone; renderServices(shop.services); renderOffers(shop.offers); }
  catch { /* le serveur répondra au prochain chargement */ }
  const params = new URLSearchParams(location.search);
  const cameFromPoster = params.get('scan') === '1';
  if (cameFromPoster) history.replaceState(null, '', '/');
  if (token()) {
    try {
      await loadCard();
      toast('Montrez ce QR à votre barbier — lui seul tamponne votre carte.');
      return;
    } catch { localStorage.removeItem(TOKEN_KEY); }
  }
  showJoinView();
  if (cameFromPoster) toast('Bienvenue ! Créez votre carte — 30 secondes.');
})();
