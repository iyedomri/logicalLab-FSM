/* Le Barbier de Carthage — logique de l’espace barbier */
'use strict';

const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => [...p.querySelectorAll(s)];
const SS = 'barbier_admin_session';
const session = () => sessionStorage.getItem(SS);

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : 'jamais';
const fmtDateTime = (iso) => iso ? new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const daysSince = (iso) => iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 864e5) : null;

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
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-admin-session': session() || '', ...(opts.headers || {}) },
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (res.status === 401) { sessionStorage.removeItem(SS); showLogin(); throw new Error('Session expirée — reconnectez-vous.'); }
  if (!res.ok) throw new Error((data && data.error) || 'Erreur réseau');
  return data;
};

function showLogin() { $('#adminApp').classList.add('hidden'); $('#loginView').classList.remove('hidden'); }
function showApp() { $('#loginView').classList.add('hidden'); $('#adminApp').classList.remove('hidden'); }

/* ================= connexion ================= */
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#loginError');
  err.classList.remove('show');
  try {
    const data = await fetch('/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: $('#pinInput').value }),
    }).then(r => r.json().then(d => ({ ok: r.ok, d })));
    if (!data.ok) throw new Error(data.d.error || 'PIN incorrect');
    sessionStorage.setItem(SS, data.d.session);
    showApp();
    await refreshAll();
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.add('show');
  }
});
$('#logoutLink').addEventListener('click', (e) => { e.preventDefault(); sessionStorage.removeItem(SS); location.reload(); });

/* ================= navigation ================= */
$$('.nav-btn[data-view]').forEach(btn => btn.addEventListener('click', () => {
  $$('.nav-btn[data-view]').forEach(b => b.classList.toggle('active', b === btn));
  $$('.panel-view').forEach(p => p.classList.toggle('active', p.id === 'view-' + btn.dataset.view));
  if (btn.dataset.view === 'report') loadReport().catch(e => toast(e.message, true));
}));

/* ================= vue d’ensemble ================= */
async function loadOverview() {
  const data = await api('/api/admin/overview');
  $('#todayLabel').textContent = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  const s = data.stats;
  const cards = [
    [s.totalClients, 'Clients inscrits'],
    [s.activeClients, 'Actifs (30 j)'],
    [s.lapsedClients, 'Inactifs 14 j+', s.lapsedClients > 0],
    [s.visitsToday, 'Visites ce jour'],
    [s.stampsIssued, 'Tampons distribués'],
    [s.rewardsRedeemed, 'Coupes offertes utilisées'],
    [s.remindersSent, 'Relances envoyées'],
    [s.returnedAfterReminder ?? 0, 'Relances qui ont ramené'],
    [(s.reminderRate ?? 0) + '%', 'Taux de retour des relancés'],
  ];
  $('#statGrid').innerHTML = cards.map(([n, l, warn]) => `<div class="stat${warn ? ' warn' : ''}"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');

  $('#lapsedCount').textContent = data.lapsed.length;
  $('#lapsedList').innerHTML = data.lapsed.length
    ? `<table class="data-table"><thead><tr><th>Client</th><th>Dernière visite</th><th>En retard</th></tr></thead><tbody>${
        data.lapsed.map(c => `<tr><td><b>${escapeHtml(c.name)}</b><br><span class="mono" style="font-size:10px;color:var(--ink-soft)">${escapeHtml(c.code)}</span></td><td>${fmtDate(c.lastVisitAt)}</td><td>${daysSince(c.lastVisitAt)} j</td></tr>`).join('')
      }</tbody></table>`
    : '<p style="font-size:12px;color:var(--ink-soft)">Aucun client en sommeil — le salon tourne rond.</p>';

  // « En route » : ping temps réel des clients
  const pings = data.pings || [];
  $('#pingsPanel').style.display = pings.length ? '' : 'none';
  $('#pingsCount').textContent = pings.length;
  $('#pingsList').innerHTML = pings.map(p => `<span class="ping-chip"><b>${escapeHtml(p.name)}</b> · ${fmtDateTime(p.at)}</span>`).join('');

  // Anniversaires du jour
  const bdays = data.birthdaysToday || [];
  $('#birthdaysPanel').style.display = bdays.length ? '' : 'none';
  $('#birthdaysList').innerHTML = bdays.map(b => `<span class="ping-chip birthday"><b>${escapeHtml(b.name)}</b> · ${escapeHtml(b.phone)}</span>`).join('');

  // Journal des relances
  const journal = data.reminderJournal || [];
  $('#reminderRateChip').textContent = (data.stats.reminderRate ?? 0) + '% de retour';
  $('#reminderJournal').innerHTML = journal.length
    ? journal.map(j => `<tr><td><b>${escapeHtml(j.clientName)}</b></td><td>${fmtDateTime(j.at)}</td><td>${j.read ? '<span class="badge on">Lue</span>' : '<span class="badge off">Non lue</span>'}</td><td>${j.returned ? '<span class="badge on">Revenu</span>' : '<span class="badge off">En sommeil</span>'}</td></tr>`).join('')
    : '<tr><td colspan="4" style="color:var(--ink-soft)">Aucune relance envoyée pour l’instant.</td></tr>';

  $('#recentVisits').innerHTML = data.recentVisits.length
    ? data.recentVisits.map(v => `<tr><td>${escapeHtml(v.clientName || '—')}</td><td>${fmtDateTime(v.at)}</td><td>${v.via === 'admin' ? 'Caisse (admin)' : 'QR comptoir'}</td></tr>`).join('')
    : '<tr><td colspan="3" style="color:var(--ink-soft)">Pas encore de visite enregistrée.</td></tr>';
}

$('#reminderDays').addEventListener('input', () => loadOverview().catch(() => {}));
const reminderPreview = () => {
  $('#reminderPreview').textContent = `Aperçu côté client : « ${$('#reminderTitle').value || 'Votre chevelure s’impatiente'} — ${$('#reminderBody').value} »`;
};
$('#reminderTitle').addEventListener('input', reminderPreview);
$('#reminderBody').addEventListener('input', reminderPreview);

$('#sendReminders').addEventListener('click', async () => {
  const btn = $('#sendReminders');
  btn.disabled = true;
  try {
    const data = await api('/api/admin/remind-lapsed', {
      method: 'POST',
      body: JSON.stringify({ days: Number($('#reminderDays').value) || 14, title: $('#reminderTitle').value.trim(), message: $('#reminderBody').value.trim() }),
    });
    toast(data.sent === 0 ? 'Personne à relancer (ou relance déjà envoyée récemment).' : `Relance envoyée à ${data.sent} client${data.sent > 1 ? 's' : ''}${data.pushed ? ' · ' + data.pushed + ' push délivrée(s)' : ''}.`);
    await loadOverview();
  } catch (err) { toast(err.message, true); }
  finally { btn.disabled = false; }
});

/* ================= clients ================= */
async function loadClients() {
  const q = $('#clientSearch').value.trim();
  const data = await api('/api/admin/clients' + (q ? '?q=' + encodeURIComponent(q) : ''));
  const goal = window.STAMP_GOAL || 10;
  $('#clientsTable').innerHTML = data.clients.map(c => {
    const full = c.stamps >= goal;
    return `<tr data-id="${c.id}">
      <td><b>${escapeHtml(c.name)}</b><br><span class="mono" style="font-size:10px;color:var(--ink-soft)">${escapeHtml(c.code)} · ${c.totalVisits} visites</span></td>
      <td class="mono">${escapeHtml(c.phone)}</td>
      <td><span class="stamp-pill${full ? ' full' : ''}">${c.stamps}/${goal}</span></td>
      <td>${fmtDate(c.lastVisitAt)}</td>
      <td style="white-space:nowrap">
        <button class="mini-btn primary" data-action="stamp"${full ? ' disabled' : ''}>+1 tampon</button>
        ${full ? '<button class="mini-btn gold" data-action="redeem">Offrir</button>' : ''}
        <button class="mini-btn danger" data-action="delete" title="Supprimer la fiche (RGPD)">✕</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" style="color:var(--ink-soft)">Aucun client trouvé.</td></tr>';
}
$('#clientSearch').addEventListener('input', () => loadClients().catch(() => {}));
$('#refreshClients').addEventListener('click', () => loadClients().catch(e => toast(e.message, true)));
$('#clientsTable').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const tr = btn.closest('tr');
  const id = tr && tr.dataset.id;
  if (!id) return;
  try {
    if (btn.dataset.action === 'stamp') { await api('/api/admin/stamp', { method: 'POST', body: JSON.stringify({ clientId: id }) }); toast('Tampon ajouté.'); }
    if (btn.dataset.action === 'redeem') { await api('/api/admin/redeem', { method: 'POST', body: JSON.stringify({ clientId: id }) }); toast('Coupe offerte utilisée — carte remise à zéro.'); }
    if (btn.dataset.action === 'delete') {
      if (!confirm('Supprimer définitivement cette fiche client ?')) return;
      await api('/api/admin/clients/' + encodeURIComponent(id), { method: 'DELETE' });
      toast('Fiche supprimée.');
    }
    await loadClients();
  } catch (err) { toast(err.message, true); }
});

/* ================= services ================= */
let editingServiceId = null;
async function loadServices() {
  const data = await api('/api/admin/services');
  $('#servicesTable').innerHTML = data.services.map(s => `<tr data-id="${s.id}">
    <td><b>${escapeHtml(s.name)}</b><br><span style="font-size:10.5px;color:var(--ink-soft)">${escapeHtml(s.desc || '')}</span></td>
    <td class="mono">${s.price} DT</td><td>${s.minutes} min</td>
    <td><label class="switch"><input type="checkbox" data-action="toggle" ${s.active ? 'checked' : ''}><span class="slider"></span></label></td>
    <td style="white-space:nowrap"><button class="mini-btn" data-action="edit">Éditer</button> <button class="mini-btn danger" data-action="delete">✕</button></td>
  </tr>`).join('');
}
$('#servicesTable').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const tr = btn.closest('tr'); const id = tr.dataset.id;
  const data = await api('/api/admin/services');
  const svc = data.services.find(s => s.id === id);
  if (btn.dataset.action === 'delete') {
    if (!confirm(`Supprimer « ${svc.name} » ?`)) return;
    await api('/api/admin/services/' + id, { method: 'DELETE' });
    toast('Service supprimé.');
    return loadServices();
  }
  if (btn.dataset.action === 'edit') {
    editingServiceId = id;
    const form = $('#serviceForm');
    form.name.value = svc.name; form.desc.value = svc.desc || '';
    form.price.value = svc.price; form.minutes.value = svc.minutes;
    $('#serviceSubmit').textContent = 'Enregistrer';
    $('#serviceCancel').classList.remove('hidden');
    form.name.focus();
  }
});
$('#servicesTable').addEventListener('change', async (e) => {
  const toggle = e.target.closest('input[data-action="toggle"]');
  if (!toggle) return;
  const id = toggle.closest('tr').dataset.id;
  await api('/api/admin/services/' + id, { method: 'PUT', body: JSON.stringify({ active: toggle.checked }) }).catch(err => toast(err.message, true));
  toast(toggle.checked ? 'Service visible.' : 'Service masqué.');
});
$('#serviceCancel').addEventListener('click', () => { editingServiceId = null; $('#serviceForm').reset(); $('#serviceSubmit').textContent = 'Ajouter'; $('#serviceCancel').classList.add('hidden'); });
$('#serviceForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const payload = { name: f.name.value.trim(), desc: f.desc.value.trim(), price: Number(f.price.value), minutes: Number(f.minutes.value) || 30 };
  try {
    if (editingServiceId) await api('/api/admin/services/' + editingServiceId, { method: 'PUT', body: JSON.stringify(payload) });
    else { payload.active = true; await api('/api/admin/services', { method: 'POST', body: JSON.stringify(payload) }); }
    $('#serviceCancel').click();
    toast('Service enregistré.');
    loadServices();
  } catch (err) { toast(err.message, true); }
});

/* ================= offres ================= */
let editingOfferId = null;
async function loadOffers() {
  const data = await api('/api/admin/offers');
  $('#offersListAdmin').innerHTML = data.offers.map(o => `<div class="service" data-id="${o.id}" style="border:1px solid var(--cream-2);border-radius:12px;padding:12px 14px;margin-bottom:8px;background:#FFFDF8;align-items:center">
    <div class="service-info">
      <div class="service-name"><span class="offer-badge" style="margin-right:8px">${escapeHtml(o.badge)}</span>${escapeHtml(o.title)}</div>
      <div class="service-desc">${escapeHtml(o.desc)}</div>
    </div>
    <label class="switch" title="Visible sur la carte"><input type="checkbox" data-action="toggle" ${o.active ? 'checked' : ''}><span class="slider"></span></label>
    <button class="mini-btn" data-action="edit">Éditer</button>
    <button class="mini-btn danger" data-action="delete">✕</button>
  </div>`).join('') || '<p style="font-size:12px;color:var(--ink-soft)">Aucune offre pour l’instant.</p>';
}
$('#offersListAdmin').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const row = btn.closest('[data-id]'); const id = row.dataset.id;
  const data = await api('/api/admin/offers');
  const offer = data.offers.find(o => o.id === id);
  if (btn.dataset.action === 'delete') {
    if (!confirm(`Supprimer l’offre « ${offer.title} » ?`)) return;
    await api('/api/admin/offers/' + id, { method: 'DELETE' });
    toast('Offre supprimée.');
    return loadOffers();
  }
  if (btn.dataset.action === 'edit') {
    editingOfferId = id;
    const f = $('#offerForm');
    f.title.value = offer.title; f.desc.value = offer.desc; f.badge.value = offer.badge;
    $('#offerSubmit').textContent = 'Enregistrer';
    $('#offerCancel').classList.remove('hidden');
    f.title.focus();
  }
});
$('#offersListAdmin').addEventListener('change', async (e) => {
  const toggle = e.target.closest('input[data-action="toggle"]');
  if (!toggle) return;
  const id = toggle.closest('[data-id]').dataset.id;
  await api('/api/admin/offers/' + id, { method: 'PUT', body: JSON.stringify({ active: toggle.checked }) }).catch(err => toast(err.message, true));
  toast(toggle.checked ? 'Offre visible.' : 'Offre masquée.');
});
$('#offerCancel').addEventListener('click', () => { editingOfferId = null; $('#offerForm').reset(); $('#offerSubmit').textContent = 'Ajouter'; $('#offerCancel').classList.add('hidden'); });
$('#offerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const payload = { title: f.title.value.trim(), desc: f.desc.value.trim(), badge: f.badge.value.trim() || 'Offre' };
  try {
    if (editingOfferId) await api('/api/admin/offers/' + editingOfferId, { method: 'PUT', body: JSON.stringify(payload) });
    else { payload.active = true; await api('/api/admin/offers', { method: 'POST', body: JSON.stringify(payload) }); }
    $('#offerCancel').click();
    toast('Offre enregistrée.');
    loadOffers();
  } catch (err) { toast(err.message, true); }
});

/* ================= réglages ================= */
async function loadSettings() {
  const data = await api('/api/admin/settings');
  const s = data.settings;
  window.STAMP_GOAL = s.stampGoal;
  const f = $('#settingsForm');
  f.name.value = s.name; f.tagline.value = s.tagline; f.address.value = s.address; f.phone.value = s.phone;
  f.hoursLabel.value = s.hoursLabel; f.openHour.value = s.openHour; f.closeHour.value = s.closeHour;
  f.stampGoal.value = s.stampGoal; f.rewardLabel.value = s.rewardLabel;
  f.scanCooldownHours.value = s.scanCooldownHours; f.reminderDays.value = s.reminderDays;
}
$('#settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const payload = {
    name: f.name.value, tagline: f.tagline.value, address: f.address.value, phone: f.phone.value,
    hoursLabel: f.hoursLabel.value, openHour: Number(f.openHour.value), closeHour: Number(f.closeHour.value),
    stampGoal: Number(f.stampGoal.value), rewardLabel: f.rewardLabel.value,
    scanCooldownHours: Number(f.scanCooldownHours.value), reminderDays: Number(f.reminderDays.value),
  };
  if (f.adminPin.value.trim()) payload.adminPin = f.adminPin.value.trim();
  try { await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(payload) }); f.adminPin.value = ''; toast('Réglages enregistrés.'); }
  catch (err) { toast(err.message, true); }
});

/* ================= rapport mensuel ================= */
async function loadReport() {
  const r = await api('/api/admin/report');
  $('#reportMonth').textContent = 'Rapport — ' + r.monthLabel;
  const grid = [
    [r.visitsThisMonth, 'Visites ce mois'],
    [r.newThisMonth, 'Nouveaux clients'],
    [r.totalClients, 'Clients inscrits'],
    [r.activeClients, 'Actifs (30 j)'],
    [r.lapsedClients, 'En sommeil (14 j+)'],
    [r.rewardsRedeemed, 'Coupes offertes (total)'],
    [r.stampsIssuedAllTime, 'Tampons distribués'],
    [r.birthdaysThisMonth, 'Anniversaires ce mois'],
  ];
  $('#reportGrid').innerHTML = grid.map(([n, l]) => `<div class="report-stat"><div class="n">${n}</div><div class="l">${escapeHtml(l)}</div></div>`).join('');
  $('#reportReminder').innerHTML = `${r.reminder.sent} relance(s) sur 90 jours → <b>${r.reminder.returned} retour(s)</b>, soit <b>${r.reminder.rate}%</b> de taux de réactivation.`;
  $('#reportTop').innerHTML = r.topActive.map(c => `<li><b>${escapeHtml(c.name)}</b> — ${c.visits} visites · ${c.stamps} tampons en cours</li>`).join('') || '<li>Pas encore de visites enregistrées.</li>';
  $('#reportFoot').textContent = 'Généré le ' + new Date(r.generatedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
$('#printReport').addEventListener('click', () => window.print());

/* ================= chargement global ================= */
async function refreshAll() {
  await Promise.allSettled([loadOverview(), loadClients(), loadServices(), loadOffers(), loadSettings()]);
}
if (session()) { showApp(); refreshAll(); } else { showLogin(); }
