/* Le Barbier de Carthage — logique de la carte client */
'use strict';

const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => [...p.querySelectorAll(s)];
const TOKEN_KEY = 'barbier_card_token';
const token = () => localStorage.getItem(TOKEN_KEY);

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
function renderOpenState() {
  const el = $('#openState');
  if (!shop) return;
  const nowD = new Date();
  const day = nowD.getDay();
  const h = nowD.getHours() + nowD.getMinutes() / 60;
  const closed = (shop.closedSunday && day === 0) || h < shop.openHour || h >= shop.closeHour;
  el.classList.toggle('open', !closed);
  el.classList.toggle('closed', closed);
  el.innerHTML = closed
    ? '<i class="pulse"></i>Fermé · ouvre à ' + shop.openHour + 'h'
    : '<i class="pulse"></i>Ouvert · ferme à ' + shop.closeHour + 'h';
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
  $('#redeemBtn').classList.toggle('hidden', !ready);
  $('#stampBtn').classList.toggle('hidden', ready);
  $('#statusText').innerHTML = ready
    ? 'Carte complète — bien joué.'
    : `Encore <b>${reward.remaining}</b> tampon${reward.remaining > 1 ? 's' : ''} avant <b>${shop ? shop.rewardLabel.toLowerCase() : 'votre récompense'}</b>`;

  $('#clientQr').src = '/api/client-qr?token=' + encodeURIComponent(token());
  $('#clientQrCode').textContent = card.code;
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
function showJoinView() { $('#cardView').classList.add('hidden'); $('#joinView').classList.remove('hidden'); }

async function loadCard() {
  const data = await api('/api/card?token=' + encodeURIComponent(token()));
  shop = data.shop;
  renderOpenState();
  renderCard(data.card, data.reward);
  renderServices(shop.services);
  renderOffers(shop.offers);
  $('#footPhone').textContent = shop.phone;
  showCardView();
  startPolling();
}

/* ---------- tamponnage ---------- */
async function doStamp() {
  const btn = $('#stampBtn');
  btn.disabled = true;
  try {
    const data = await api('/api/stamp', { method: 'POST', body: JSON.stringify({ token: token() }) });
    renderCard(data.card, data.reward);
    toast(data.message);
  } catch (err) {
    toast(err.message, true);
    if (err.data && err.data.reward && err.data.card) renderCard(err.data.card, err.data.reward);
  } finally {
    btn.disabled = false;
  }
}

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
  try {
    const data = await api('/api/join', { method: 'POST', body: JSON.stringify({ name, phone, birthday }) });
    localStorage.setItem(TOKEN_KEY, data.token);
    await loadCard();
    toast(data.created ? 'Bienvenue chez Le Barbier — voici votre carte.' : 'Content de vous revoir — voici votre carte.');
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.add('show');
  }
});
$('#stampBtn').addEventListener('click', doStamp);
$('#redeemBtn').addEventListener('click', async () => {
  $('#redeemBtn').disabled = true;
  try {
    const data = await api('/api/redeem', { method: 'POST', body: JSON.stringify({ token: token() }) });
    renderCard(data.card, data.reward);
    toast(data.message);
  } catch (err) { toast(err.message, true); }
  finally { $('#redeemBtn').disabled = false; }
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
$('#enablePush').addEventListener('click', async () => {
  if (!('Notification' in window)) return toast('Ce navigateur ne gère pas les alertes.', true);
  const perm = await Notification.requestPermission();
  toast(perm === 'granted' ? 'Alertes activées — on vous préviendra en douceur.' : 'Alertes refusées — pas de souci.');
});
$('#privacyLink').addEventListener('click', (e) => { e.preventDefault(); $('#privacyModal').classList.remove('hidden'); });
$$('[data-close-modal]').forEach(b => b.addEventListener('click', () => b.closest('.modal-backdrop').classList.add('hidden')));
$$('.modal-backdrop').forEach(m => m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); }));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $$('.modal-backdrop').forEach(m => m.classList.add('hidden')); });

/* ---------- PWA (optionnel, silencieux) ---------- */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

/* ---------- init ---------- */
(async function init() {
  try { shop = await api('/api/shop'); renderOpenState(); $('#footPhone').textContent = shop.phone; renderServices(shop.services); renderOffers(shop.offers); }
  catch { /* le serveur répondra au prochain chargement */ }
  const params = new URLSearchParams(location.search);
  const wantScan = params.get('scan') === '1';
  if (token()) {
    try {
      await loadCard();
      if (wantScan) { history.replaceState(null, '', '/'); doStamp(); }
      return;
    } catch { localStorage.removeItem(TOKEN_KEY); }
  }
  showJoinView();
  if (wantScan) toast('Créez votre carte d’abord — 30 secondes, promis.');
})();
