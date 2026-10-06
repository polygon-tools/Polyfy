'use strict';
// =====================================================================
// Polyfy - interne urenregistratie (dashboard, kalender, rapporten,
// projecten en team) op Supabase.
// =====================================================================

const CFG = window.POLYFY_CONFIG || {};
const app = document.getElementById('app');
const IS_CONFIGURED = CFG.SUPABASE_URL && !CFG.SUPABASE_URL.includes('JOUW-PROJECT') && CFG.SUPABASE_ANON_KEY && !CFG.SUPABASE_ANON_KEY.includes('JOUW-');

// Info uit de link van een wachtwoord-reset-mail, uitlezen vóór supabase-js de URL opkuist.
const URL_HASH = new URLSearchParams(location.hash.slice(1));
const IS_RECOVERY_LINK = URL_HASH.get('type') === 'recovery';

const sb = IS_CONFIGURED ? supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY) : null;

// Kleuren voor projecten: vaste volgorde, gevalideerd op kleurenblind-onderscheid.
const PROJECT_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const NO_PROJECT_COLOR = '#8a91a0';

const S = {
  session: null, me: null, recovery: IS_RECOVERY_LINK,
  profiles: [], projects: [], clients: [], running: null,
  view: 'dashboard',
  cal: { week: null, user: null },
  rep: { preset: 'week', from: '', to: '', user: '', project: '', client: '', billable: '', group: 'project', tab: 'summary' },
  proj: { search: '', status: 'active' }
};

// ---------- Kleine hulpjes ----------
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const isAdmin = () => S.me?.role === 'admin';
const byId = (list, id) => list.find(x => x.id === id);
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function toast(msg, isErr = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), isErr ? 6000 : 3000);
}
function fail(err) {
  console.error(err);
  toast(err?.message || String(err), true);
}

// ---------- Datum & tijd ----------
const DAY_MS = 86400000;
const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const startOfWeek = d => { const x = startOfDay(d); const wd = (x.getDay() + 6) % 7; return addDays(x, -wd); };
const startOfMonth = d => new Date(d.getFullYear(), d.getMonth(), 1);
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const sameDay = (a, b) => ymd(a) === ymd(b);
const DAYS_SHORT = ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'];
const fmtDate = (d, opts) => d.toLocaleDateString('nl-BE', opts);
const fmtDayLong = d => {
  const today = startOfDay(new Date());
  if (sameDay(d, today)) return 'Vandaag';
  if (sameDay(d, addDays(today, -1))) return 'Gisteren';
  return fmtDate(d, { weekday: 'long', day: 'numeric', month: 'long' });
};
function weekNumber(d) {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = x.getUTCDay() || 7;
  x.setUTCDate(x.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
  return Math.ceil(((x - y0) / DAY_MS + 1) / 7);
}

// Duurweergave: 1:05:09 (timer), 7:30 (uren:minuten), 7,5 (decimaal)
const fmtClock = sec => { sec = Math.max(0, Math.floor(sec)); return `${Math.floor(sec / 3600)}:${pad(Math.floor(sec / 60) % 60)}:${pad(sec % 60)}`; };
const fmtHM = sec => { const m = Math.round(Math.max(0, sec) / 60); return `${Math.floor(m / 60)}:${pad(m % 60)}`; };
const fmtDec = sec => (sec / 3600).toLocaleString('nl-BE', { maximumFractionDigits: 2 });
const fmtMoney = v => v.toLocaleString('nl-BE', { style: 'currency', currency: CFG.CURRENCY || 'EUR' });

const entryStart = e => new Date(e.start_at);
const entryEnd = e => e.end_at ? new Date(e.end_at) : new Date();
const entrySec = e => (entryEnd(e) - entryStart(e)) / 1000;
// Aantal seconden van een registratie binnen [from, to)
const clipSec = (e, from, to) => Math.max(0, (Math.min(entryEnd(e), to) - Math.max(entryStart(e), from)) / 1000);

// Seconden per dag over `days` dagen vanaf `from` (registraties over middernacht worden gesplitst)
function perDay(entries, from, days) {
  const out = new Array(days).fill(0);
  for (const e of entries) {
    for (let i = 0; i < days; i++) {
      const a = addDays(from, i), b = addDays(from, i + 1);
      out[i] += clipSec(e, a, b);
    }
  }
  return out;
}

// ---------- Domein ----------
const projectOf = e => byId(S.projects, e.project_id);
const profileOf = id => byId(S.profiles, id);
const clientOf = p => p ? byId(S.clients, p.client_id) : null;
const rateFor = e => {
  const p = projectOf(e);
  if (p && p.hourly_rate != null) return Number(p.hourly_rate);
  return Number(profileOf(e.user_id)?.hourly_rate || 0);
};
const amountFor = (e, sec) => e.billable ? (sec / 3600) * rateFor(e) : 0;
const initials = name => (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
const userColor = id => PROJECT_COLORS[[...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % PROJECT_COLORS.length];
const avatar = p => `<span class="avatar" style="background:${userColor(p?.id)}" aria-hidden="true">${esc(initials(p?.full_name || p?.email))}</span>`;
const projLabel = p => p
  ? `<span class="proj"><span class="dot" style="background:${esc(p.color)}"></span>${esc(p.name)}${clientOf(p) ? `<span class="muted"> · ${esc(clientOf(p).name)}</span>` : ''}</span>`
  : `<span class="proj muted"><span class="dot" style="background:${NO_PROJECT_COLOR}"></span>Geen project</span>`;

function projectOptions(selected, { includeArchived = false, emptyLabel = 'Geen project' } = {}) {
  const list = S.projects.filter(p => includeArchived || !p.archived || p.id === selected);
  const groups = new Map();
  for (const p of list) {
    const c = clientOf(p)?.name || 'Zonder klant';
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(p);
  }
  let html = `<option value="">${esc(emptyLabel)}</option>`;
  for (const [c, ps] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    html += `<optgroup label="${esc(c)}">` + ps.sort((a, b) => a.name.localeCompare(b.name))
      .map(p => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}${p.archived ? ' (gearchiveerd)' : ''}</option>`).join('') + '</optgroup>';
  }
  return html;
}

// Haalt alle registraties op die overlappen met [from, to)
async function fetchEntries({ from, to, userId, projectId }) {
  let all = [];
  for (let off = 0; ; off += 1000) {
    let q = sb.from('time_entries').select('*')
      .lt('start_at', to.toISOString())
      .or(`end_at.is.null,end_at.gt.${from.toISOString()}`)
      .order('start_at', { ascending: false })
      .range(off, off + 999);
    if (userId) q = q.eq('user_id', userId);
    if (projectId) q = q.eq('project_id', projectId);
    const { data, error } = await q;
    if (error) throw error;
    all = all.concat(data);
    if (data.length < 1000) break;
  }
  return all;
}

async function loadBase() {
  const [pr, pj, cl, run] = await Promise.all([
    sb.from('profiles').select('*').order('full_name'),
    sb.from('projects').select('*').order('name'),
    sb.from('clients').select('*').order('name'),
    sb.from('time_entries').select('*').eq('user_id', S.session.user.id).is('end_at', null).maybeSingle()
  ]);
  for (const r of [pr, pj, cl, run]) if (r.error) throw r.error;
  S.profiles = pr.data; S.projects = pj.data; S.clients = cl.data; S.running = run.data;
  S.me = byId(S.profiles, S.session.user.id);
}

// ---------- Iconen ----------
const I = {
  dash: '<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/>',
  cal: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  rep: '<path d="M3 3v18h18"/><path d="M7 15v3M12 9v9M17 5v13"/>',
  proj: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  team: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>',
  play: '<path d="M7 4v16l13-8z" fill="currentColor" stroke="none"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  left: '<path d="M15 18l-6-6 6-6"/>', right: '<path d="M9 18l6-6-6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', x: '<path d="M6 6l12 12M18 6L6 18"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>', dl: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  logout: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>'
};
const icon = n => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[n]}</svg>`;
const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true"><polygon points="16,2 29,9.5 29,22.5 16,30 3,22.5 3,9.5" fill="#2a78d6"/><path d="M16 9v7l5 3" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"/></svg>`;

// ---------- Tooltip (één gedeelde) ----------
const tip = document.createElement('div');
tip.className = 'tip'; tip.hidden = true; document.body.appendChild(tip);
document.addEventListener('mousemove', e => {
  const t = e.target.closest?.('[data-tip]');
  if (!t) { tip.hidden = true; return; }
  tip.innerHTML = t.dataset.tip; tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let x = e.clientX + 14, y = e.clientY - h - 10;
  if (x + w > innerWidth - 8) x = e.clientX - w - 14;
  if (y < 8) y = e.clientY + 16;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
});

// ---------- Thema ----------
function applyTheme() {
  let t = 'system';
  try { t = localStorage.getItem('polyfy-theme') || 'system'; } catch (_) {}
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = t;
  return t;
}
applyTheme();

// =====================================================================
// Opstart, login
// =====================================================================
async function init() {
  if (!IS_CONFIGURED) return renderSetup();
  const { data: { session } } = await sb.auth.getSession();
  S.session = session;
  sb.auth.onAuthStateChange((event, s) => {
    if (event === 'PASSWORD_RECOVERY') { S.session = s; S.recovery = true; renderAuth('reset'); return; }
    const changed = s?.user?.id !== S.session?.user?.id;
    S.session = s;
    if (changed) start();
  });
  start();
}

async function start() {
  if (S.recovery) return renderAuth('reset');
  if (!S.session) return renderAuth('login');
  app.innerHTML = '<div class="auth"><div class="muted">Laden…</div></div>';
  try {
    await loadBase();
    if (!S.me) throw new Error('Geen profiel gevonden. Werd schema.sql uitgevoerd in Supabase?');
    if (!S.me.active) {
      app.innerHTML = `<div class="auth"><div class="card"><div class="brand">${LOGO}Polyfy</div><p>Je account is gedeactiveerd. Neem contact op met een beheerder.</p><button class="btn" id="lo">Uitloggen</button></div></div>`;
      $('#lo').onclick = () => sb.auth.signOut();
      return;
    }
  } catch (err) {
    app.innerHTML = `<div class="auth"><div class="card"><div class="brand">${LOGO}Polyfy</div><div class="err">${esc(err.message)}</div><p><button class="btn" id="lo">Uitloggen</button></p></div></div>`;
    $('#lo').onclick = () => sb.auth.signOut();
    return;
  }
  renderShell();
  route();
}

function renderSetup() {
  app.innerHTML = `<div class="setup card">
    <div class="brand">${LOGO}Polyfy</div>
    <h2>Nog niet gekoppeld aan Supabase</h2>
    <ol>
      <li>Maak een project aan op <a href="https://supabase.com" target="_blank" rel="noopener">supabase.com</a>.</li>
      <li>Voer <code>supabase/schema.sql</code> uit in de SQL Editor.</li>
      <li>Vul <code>SUPABASE_URL</code> en <code>SUPABASE_ANON_KEY</code> in <code>config.js</code> in.</li>
    </ol>
    <p class="muted">Zie <code>README.md</code> voor alle stappen.</p>
  </div>`;
}

function renderAuth(mode, msg = null) {
  const titles = { login: 'Inloggen', signup: 'Account maken', forgot: 'Wachtwoord vergeten', reset: 'Nieuw wachtwoord' };
  app.innerHTML = `<div class="auth"><div class="card">
    <div class="brand">${LOGO}Polyfy</div>
    <p class="muted" style="text-align:center;margin:0">${titles[mode]}</p>
    <form id="af">
      ${msg ? `<div class="${msg.ok ? 'ok' : 'err'}">${esc(msg.text)}</div>` : ''}
      ${mode === 'signup' ? '<label class="field">Naam<input name="name" required autocomplete="name"></label>' : ''}
      ${mode !== 'reset' ? '<label class="field">E-mail<input name="email" type="email" required autocomplete="email"></label>' : ''}
      ${mode !== 'forgot' ? `<label class="field">${mode === 'reset' ? 'Nieuw wachtwoord' : 'Wachtwoord'}<input name="pw" type="password" required minlength="6" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}"></label>` : ''}
      <button class="btn primary" type="submit">${{ login: 'Inloggen', signup: 'Account maken', forgot: 'Stuur resetlink', reset: 'Opslaan' }[mode]}</button>
      <div class="row small" style="justify-content:space-between">
        ${mode === 'login' ? '<button type="button" class="linkbtn" data-m="signup">Account maken</button><button type="button" class="linkbtn" data-m="forgot">Wachtwoord vergeten?</button>' : ''}
        ${mode === 'signup' || mode === 'forgot' ? '<button type="button" class="linkbtn" data-m="login">Terug naar inloggen</button>' : ''}
      </div>
    </form></div></div>`;
  $$('[data-m]').forEach(b => b.onclick = () => renderAuth(b.dataset.m));
  $('#af').onsubmit = async ev => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const btn = $('button[type=submit]', ev.target); btn.disabled = true;
    try {
      if (mode === 'login') {
        const { error } = await sb.auth.signInWithPassword({ email: f.get('email'), password: f.get('pw') });
        if (error) throw error;
      } else if (mode === 'signup') {
        const email = String(f.get('email')).trim();
        const dom = (CFG.ALLOWED_EMAIL_DOMAIN || '').trim().toLowerCase();
        if (dom && !email.toLowerCase().endsWith('@' + dom)) throw new Error(`Gebruik je e-mailadres van @${dom}.`);
        const { data, error } = await sb.auth.signUp({ email, password: f.get('pw'), options: { data: { full_name: f.get('name') }, emailRedirectTo: location.origin + location.pathname } });
        if (error) throw error;
        if (!data.session) renderAuth('login', { ok: true, text: 'Check je mailbox om je account te bevestigen.' });
      } else if (mode === 'forgot') {
        const { error } = await sb.auth.resetPasswordForEmail(f.get('email'), { redirectTo: location.origin + location.pathname });
        if (error) throw error;
        renderAuth('login', { ok: true, text: 'Als dit adres bestaat, ontvang je een mail met een resetlink.' });
      } else if (mode === 'reset') {
        const { error } = await sb.auth.updateUser({ password: f.get('pw') });
        if (error) throw error;
        S.recovery = false; history.replaceState(null, '', location.pathname);
        start();
      }
    } catch (err) {
      renderAuth(mode, { text: err.message === 'Invalid login credentials' ? 'E-mail of wachtwoord klopt niet.' : err.message });
    }
  };
}

// =====================================================================
// App-schil: navigatie + timerbalk
// =====================================================================
const NAV = [
  ['dashboard', 'Dashboard', 'dash'], ['calendar', 'Kalender', 'cal'], ['reports', 'Rapporten', 'rep'],
  ['projects', 'Projecten', 'proj'], ['team', 'Team', 'team']
];

function renderShell() {
  app.innerHTML = `<div class="shell" id="shell">
    <aside class="side">
      <div class="brand">${LOGO}Polyfy</div>
      <nav class="nav">${NAV.map(([k, l, i]) => `<a href="#${k}" data-nav="${k}">${icon(i)}${l}</a>`).join('')}</nav>
      <div class="side-foot">
        <button class="me" id="me-btn" title="Profiel & instellingen">${avatar(S.me)}<div class="who"><div style="font-weight:600">${esc(S.me.full_name || S.me.email)}</div><div class="muted small">${isAdmin() ? 'Beheerder' : 'Medewerker'}</div></div></button>
      </div>
    </aside>
    <div class="main">
      <div class="mobile-top"><button class="btn icon ghost" id="nav-toggle" aria-label="Menu">${icon('menu')}</button>Polyfy</div>
      <div class="timerbar" id="timerbar"></div>
      <div class="content" id="page"></div>
    </div>
  </div>`;
  $('#me-btn').onclick = openProfileModal;
  $('#nav-toggle').onclick = () => $('#shell').classList.toggle('nav-open');
  $$('.nav a').forEach(a => a.onclick = () => $('#shell').classList.remove('nav-open'));
  renderTimer();
}

window.addEventListener('hashchange', () => { if (S.me) route(); });
window.addEventListener('focus', async () => {
  // Timer kan in een ander tabblad/toestel gestart of gestopt zijn
  if (!S.me) return;
  const { data } = await sb.from('time_entries').select('*').eq('user_id', S.me.id).is('end_at', null).maybeSingle();
  if ((data?.id || null) !== (S.running?.id || null)) { S.running = data; renderTimer(); refreshPage(); }
});

function route() {
  const v = (location.hash.slice(1) || 'dashboard').split('?')[0];
  S.view = NAV.some(n => n[0] === v) ? v : 'dashboard';
  $$('.nav a').forEach(a => a.classList.toggle('active', a.dataset.nav === S.view));
  document.title = `${NAV.find(n => n[0] === S.view)[1]} · Polyfy`;
  refreshPage();
}
function refreshPage() {
  const page = $('#page'); if (!page) return;
  ({ dashboard: renderDashboard, calendar: renderCalendar, reports: renderReports, projects: renderProjects, team: renderTeam })[S.view](page)
    .catch(fail);
}

// ---------- Timer ----------
let timerTick = null;
let draft = { description: '', project_id: '', billable: true };

function renderTimer() {
  const bar = $('#timerbar'); if (!bar) return;
  const r = S.running;
  const cur = r || draft;
  bar.classList.toggle('running', !!r);
  bar.innerHTML = `
    <input class="desc" id="t-desc" placeholder="Waar werk je aan?" value="${esc(cur.description)}" aria-label="Omschrijving">
    <select id="t-proj" aria-label="Project" style="max-width:240px">${projectOptions(cur.project_id || '')}</select>
    <button class="billable-toggle ${cur.billable ? 'on' : ''}" id="t-bill" title="Factureerbaar" aria-pressed="${!!cur.billable}">€</button>
    <span class="clock num" id="t-clock">${r ? fmtClock(entrySec(r)) : '0:00:00'}</span>
    <button class="btn ${r ? 'stop' : 'start'}" id="t-go">${r ? 'Stop' : 'Start'}</button>
    <button class="btn ghost" id="t-manual" title="Registratie manueel toevoegen">${icon('plus')}<span class="hide-sm">Manueel</span></button>`;
  clearInterval(timerTick);
  if (r) timerTick = setInterval(() => { const c = $('#t-clock'); if (c && S.running) c.textContent = fmtClock(entrySec(S.running)); document.title = `${fmtClock(entrySec(S.running))} · Polyfy`; }, 1000);

  const desc = $('#t-desc'), proj = $('#t-proj'), bill = $('#t-bill');
  const saveRunning = async patch => {
    if (!S.running) { Object.assign(draft, patch); return; }
    const { data, error } = await sb.from('time_entries').update(patch).eq('id', S.running.id).select().single();
    if (error) return fail(error);
    S.running = data;
  };
  desc.onchange = () => saveRunning({ description: desc.value.trim() });
  desc.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); if (!S.running) startTimer(); else desc.blur(); } };
  proj.onchange = () => {
    const p = byId(S.projects, proj.value);
    const patch = { project_id: proj.value || null };
    if (p) { patch.billable = p.billable; bill.classList.toggle('on', p.billable); }
    saveRunning(patch);
  };
  bill.onclick = () => { const on = !bill.classList.contains('on'); bill.classList.toggle('on', on); saveRunning({ billable: on }); };
  $('#t-go').onclick = () => S.running ? stopTimer() : startTimer();
  $('#t-manual').onclick = () => openEntryModal(null);
}

async function startTimer(fromEntry = null) {
  try {
    if (S.running) await stopTimer(true);
    const src = fromEntry || {
      description: $('#t-desc')?.value.trim() || '',
      project_id: $('#t-proj')?.value || null,
      billable: $('#t-bill')?.classList.contains('on') ?? true
    };
    const { data, error } = await sb.from('time_entries').insert({
      user_id: S.me.id, description: src.description || '', project_id: src.project_id || null,
      billable: !!src.billable, start_at: new Date().toISOString()
    }).select().single();
    if (error) throw error;
    S.running = data; draft = { description: '', project_id: '', billable: true };
    renderTimer(); refreshPage();
  } catch (err) { fail(err); }
}

async function stopTimer(silent = false) {
  if (!S.running) return;
  const desc = $('#t-desc')?.value.trim();
  const patch = { end_at: new Date().toISOString() };
  if (desc !== undefined && desc !== S.running.description) patch.description = desc;
  const { error } = await sb.from('time_entries').update(patch).eq('id', S.running.id);
  if (error) return fail(error);
  S.running = null;
  if (!silent) { renderTimer(); refreshPage(); document.title = 'Polyfy'; }
}

// =====================================================================
// Modals
// =====================================================================
function openModal(title, bodyHtml, footHtml) {
  closeModal();
  const bg = document.createElement('div');
  bg.className = 'modal-bg'; bg.id = 'modal';
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-head"><h2>${esc(title)}</h2><button class="btn icon ghost" data-close aria-label="Sluiten">${icon('x')}</button></div>
    <div class="modal-body">${bodyHtml}</div>
    <div class="modal-foot">${footHtml}</div></div>`;
  document.body.appendChild(bg);
  bg.addEventListener('mousedown', e => { if (e.target === bg) closeModal(); });
  $$('[data-close]', bg).forEach(b => b.onclick = closeModal);
  const first = $('input,select,textarea', bg); if (first) setTimeout(() => first.focus(), 30);
  return bg;
}
function closeModal() { $('#modal')?.remove(); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// Registratie toevoegen of bewerken. `entry` = null voor nieuw; `preset` vult velden voor.
function openEntryModal(entry, preset = {}) {
  const e = entry || {
    description: '', project_id: preset.project_id || null, billable: true,
    user_id: preset.user_id || S.me.id,
    // Standaard: het afgelopen uur, afgerond op een kwartier
    start_at: preset.start || (() => { const d = new Date(); d.setMinutes(Math.floor(d.getMinutes() / 15) * 15, 0, 0); return d.getTime() - 3600000; })(),
    end_at: preset.end || null
  };
  const st = new Date(e.start_at);
  const en = e.end_at ? new Date(e.end_at) : (entry ? null : new Date(st.getTime() + 3600000));
  const running = entry && !entry.end_at;
  const canEditUser = isAdmin() && !entry;
  const m = openModal(entry ? 'Registratie bewerken' : 'Registratie toevoegen', `
    <label class="field">Omschrijving<input id="m-desc" value="${esc(e.description)}" placeholder="Waar werkte je aan?"></label>
    <label class="field">Project<select id="m-proj">${projectOptions(e.project_id || '')}</select></label>
    ${canEditUser ? `<label class="field">Medewerker<select id="m-user">${S.profiles.filter(p => p.active).map(p => `<option value="${p.id}" ${p.id === e.user_id ? 'selected' : ''}>${esc(p.full_name || p.email)}</option>`).join('')}</select></label>` : ''}
    <div class="grid2">
      <label class="field">Datum<input type="date" id="m-date" value="${ymd(st)}" required></label>
      <div class="grid2" style="gap:8px">
        <label class="field">Start<input type="time" id="m-start" value="${hm(st)}" required></label>
        <label class="field">Einde${running ? '<input disabled value="loopt nog">' : `<input type="time" id="m-end" value="${en ? hm(en) : ''}" required>`}</label>
      </div>
    </div>
    <div class="row" style="justify-content:space-between">
      <label class="check"><input type="checkbox" id="m-bill" ${e.billable ? 'checked' : ''}> Factureerbaar</label>
      <span class="muted">Duur: <b class="num" id="m-dur">–</b></span>
    </div>`,
    `<div>${entry ? `<button class="btn danger" id="m-del">${icon('trash')}Verwijderen</button>` : ''}</div>
     <div class="row"><button class="btn" data-close>Annuleren</button><button class="btn primary" id="m-save">Opslaan</button></div>`);

  const times = () => {
    const day = parseYmd($('#m-date').value || ymd(st));
    const [sh, sm] = ($('#m-start').value || '00:00').split(':').map(Number);
    const s = new Date(day); s.setHours(sh, sm, 0, 0);
    if (running) return { s, en: null };
    const [eh, em] = ($('#m-end').value || '00:00').split(':').map(Number);
    let en2 = new Date(day); en2.setHours(eh, em, 0, 0);
    if (en2 <= s) en2 = addDays(en2, 1); // eindigt na middernacht
    return { s, en: en2 };
  };
  const upd = () => { const { s, en: x } = times(); $('#m-dur').textContent = fmtHM(((x || new Date()) - s) / 1000); };
  $$('#m-date,#m-start,#m-end', m).forEach(i => i.addEventListener('input', upd)); upd();
  $('#m-proj').onchange = () => { const p = byId(S.projects, $('#m-proj').value); if (p) $('#m-bill').checked = p.billable; };

  $('#m-save').onclick = async () => {
    const { s, en: x } = times();
    if (x && x - s > 24 * 3600000) return toast('Een registratie kan maximaal 24 uur duren.', true);
    const row = {
      description: $('#m-desc').value.trim(), project_id: $('#m-proj').value || null,
      billable: $('#m-bill').checked, start_at: s.toISOString()
    };
    if (!running) row.end_at = x.toISOString();
    if (canEditUser) row.user_id = $('#m-user').value; else if (!entry) row.user_id = S.me.id;
    const q = entry ? sb.from('time_entries').update(row).eq('id', entry.id) : sb.from('time_entries').insert(row);
    const { error } = await q;
    if (error) return fail(error);
    closeModal(); toast(entry ? 'Registratie bijgewerkt' : 'Registratie toegevoegd');
    if (running) { S.running = { ...S.running, ...row }; renderTimer(); }
    refreshPage();
  };
  if (entry) $('#m-del').onclick = () => deleteEntry(entry);
}

async function deleteEntry(entry) {
  if (!confirm('Deze registratie verwijderen?')) return;
  const { error } = await sb.from('time_entries').delete().eq('id', entry.id);
  if (error) return fail(error);
  if (S.running?.id === entry.id) { S.running = null; renderTimer(); }
  closeModal(); toast('Registratie verwijderd'); refreshPage();
}

function openProfileModal() {
  const theme = applyTheme();
  const m = openModal('Profiel & instellingen', `
    <div class="row">${avatar(S.me)}<div><div style="font-weight:600">${esc(S.me.email)}</div><div class="muted small">${isAdmin() ? 'Beheerder' : 'Medewerker'}</div></div></div>
    <label class="field">Naam<input id="p-name" value="${esc(S.me.full_name)}"></label>
    <label class="field">Nieuw wachtwoord <span class="muted">(leeg laten om niet te wijzigen)</span><input id="p-pw" type="password" minlength="6" autocomplete="new-password"></label>
    <div class="field">Weergave<div class="seg" id="p-theme">${[['system', 'Systeem'], ['light', 'Licht'], ['dark', 'Donker']].map(([k, l]) => `<button type="button" data-t="${k}" class="${theme === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>`,
    `<button class="btn" id="p-out">${icon('logout')}Uitloggen</button><div class="row"><button class="btn" data-close>Annuleren</button><button class="btn primary" id="p-save">Opslaan</button></div>`);
  $$('#p-theme button', m).forEach(b => b.onclick = () => {
    try { localStorage.setItem('polyfy-theme', b.dataset.t); } catch (_) {}
    applyTheme(); $$('#p-theme button', m).forEach(x => x.classList.toggle('on', x === b)); refreshPage();
  });
  $('#p-out').onclick = async () => { closeModal(); clearInterval(timerTick); S.me = null; await sb.auth.signOut(); };
  $('#p-save').onclick = async () => {
    try {
      const name = $('#p-name').value.trim();
      if (name !== S.me.full_name) {
        const { data, error } = await sb.from('profiles').update({ full_name: name }).eq('id', S.me.id).select().single();
        if (error) throw error;
        Object.assign(S.me, data);
      }
      const pw = $('#p-pw').value;
      if (pw) { const { error } = await sb.auth.updateUser({ password: pw }); if (error) throw error; }
      closeModal(); toast('Profiel opgeslagen'); renderShell(); route();
    } catch (err) { fail(err); }
  };
}

// =====================================================================
// Grafieken (eigen SVG, geen bibliotheek)
// =====================================================================
function niceMax(v) {
  if (v <= 0) return 4;
  const steps = [1, 2, 4, 5, 8, 10, 20, 25, 40, 50, 100, 200, 250, 500, 1000, 2000, 5000];
  for (const s of steps) if (v <= s * 4) return s * 4;
  return Math.ceil(v / 1000) * 1000;
}
// data: [{ label, value (uren), tip }]
function barChart(el, data, { height = 220, showValues = true } = {}) {
  const draw = () => {
    const W = el.clientWidth || 600, H = height;
    const padL = 36, padR = 8, padT = 18, padB = 26;
    const iw = W - padL - padR, ih = H - padT - padB;
    const max = niceMax(Math.max(...data.map(d => d.value)));
    const ticks = 4, band = iw / data.length;
    const bw = Math.max(4, Math.min(44, band * 0.62));
    const labelEvery = Math.ceil(data.length / Math.max(1, Math.floor(iw / 44)));
    let s = `<svg width="${W}" height="${H}" role="img" aria-label="Staafdiagram van geregistreerde uren">`;
    for (let i = 0; i <= ticks; i++) {
      const y = padT + ih - (ih * i) / ticks;
      s += `<line class="${i === 0 ? 'baseline' : 'gridline'}" x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}"/>`;
      s += `<g class="axis"><text x="${padL - 6}" y="${y + 4}" text-anchor="end">${(max * i / ticks).toLocaleString('nl-BE')}u</text></g>`;
    }
    data.forEach((d, i) => {
      const cx = padL + band * i + band / 2;
      const h = max ? (d.value / max) * ih : 0;
      const x = cx - bw / 2, y = padT + ih - h, r = Math.min(4, h, bw / 2);
      if (h > 0.5) s += `<path class="bar" fill="var(--bar)" d="M${x},${padT + ih} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${padT + ih} Z"/>`;
      if (showValues && d.value > 0 && data.length <= 14) s += `<text class="barval" x="${cx}" y="${y - 5}" text-anchor="middle">${esc(d.valueLabel ?? fmtHM(d.value * 3600))}</text>`;
      if (i % labelEvery === 0) s += `<g class="axis"><text x="${cx}" y="${H - 8}" text-anchor="middle">${esc(d.label)}</text></g>`;
      s += `<rect class="hit" x="${padL + band * i}" y="${padT}" width="${band}" height="${ih}" data-tip="${esc(d.tip)}"/>`;
    });
    el.innerHTML = s + '</svg>';
  };
  draw();
  const ro = new ResizeObserver(debounce(() => { if (el.isConnected) draw(); else ro.disconnect(); }, 80));
  ro.observe(el);
}

// Horizontale balken per project/groep, met label en waarde (identiteit nooit enkel via kleur)
function hbars(rows, total) {
  if (!rows.length) return '<div class="empty">Nog geen uren in deze periode.</div>';
  const max = Math.max(...rows.map(r => r.sec));
  return `<div class="hbars">${rows.map(r => `
    <div class="hbar" data-tip="<b>${esc(r.name)}</b><br>${fmtHM(r.sec)} u · ${total ? Math.round(r.sec / total * 100) : 0}%">
      <div class="top"><span class="proj"><span class="dot" style="background:${esc(r.color)}"></span>${esc(r.name)}</span><span class="num"><b>${fmtHM(r.sec)}</b> <span class="muted">${total ? Math.round(r.sec / total * 100) : 0}%</span></span></div>
      <div class="track"><div class="fill" style="width:${max ? r.sec / max * 100 : 0}%;background:${esc(r.color)}"></div></div>
    </div>`).join('')}</div>`;
}

// Registraties per dag gegroepeerd (dashboard)
function entryList(entries, { showUser = false } = {}) {
  if (!entries.length) return '<div class="empty">Nog geen registraties. Start de timer of voeg manueel uren toe.</div>';
  const groups = new Map();
  for (const e of entries) {
    const k = ymd(entryStart(e));
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  return [...groups].map(([k, list]) => `
    <div class="day-group">
      <div class="day-head"><span>${esc(fmtDayLong(parseYmd(k)))}</span><span class="num">${fmtHM(list.reduce((a, e) => a + entrySec(e), 0))}</span></div>
      ${list.map(e => `
        <div class="entry" data-id="${e.id}">
          <div class="desc"><div>${e.description ? esc(e.description) : '<span class="muted">(geen omschrijving)</span>'}${e.billable ? ' <span class="muted" title="Factureerbaar">€</span>' : ''}</div>
            <div class="small">${projLabel(projectOf(e))}${showUser ? ` <span class="muted">· ${esc(profileOf(e.user_id)?.full_name || '')}</span>` : ''}</div></div>
          <div class="times num">${hm(entryStart(e))} – ${e.end_at ? hm(entryEnd(e)) : 'nu'}</div>
          <div class="dur num">${e.end_at ? fmtHM(entrySec(e)) : '<span class="tag live">loopt</span>'}</div>
          <div class="acts">
            ${e.user_id === S.me.id ? `<button class="btn icon ghost" data-act="cont" title="Opnieuw starten" aria-label="Opnieuw starten">${icon('play')}</button>` : ''}
            <button class="btn icon ghost" data-act="edit" title="Bewerken" aria-label="Bewerken">${icon('edit')}</button>
            <button class="btn icon ghost" data-act="del" title="Verwijderen" aria-label="Verwijderen">${icon('trash')}</button>
          </div>
        </div>`).join('')}
    </div>`).join('');
}
function bindEntryList(root, entries) {
  $$('.entry', root).forEach(row => {
    const e = entries.find(x => x.id === row.dataset.id);
    $$('[data-act]', row).forEach(b => b.onclick = () => {
      if (b.dataset.act === 'cont') startTimer(e);
      if (b.dataset.act === 'edit') openEntryModal(e);
      if (b.dataset.act === 'del') deleteEntry(e);
    });
  });
}

// =====================================================================
// Dashboard
// =====================================================================
async function renderDashboard(page) {
  const now = new Date(), today = startOfDay(now), wk = startOfWeek(now), mo = startOfMonth(now);
  const from = new Date(Math.min(wk, mo, addDays(today, -6)));
  const entries = await fetchEntries({ from, to: addDays(today, 1), userId: S.me.id });
  if (S.view !== 'dashboard') return;

  const sum = (a, b) => entries.reduce((t, e) => t + clipSec(e, a, b), 0);
  const tToday = sum(today, addDays(today, 1));
  const tWeek = sum(wk, addDays(wk, 7));
  const tMonth = sum(mo, new Date(now.getFullYear(), now.getMonth() + 1, 1));
  const weekEntries = entries.filter(e => clipSec(e, wk, addDays(wk, 7)) > 0);
  const tBill = weekEntries.filter(e => e.billable).reduce((t, e) => t + clipSec(e, wk, addDays(wk, 7)), 0);
  const target = Number(S.me.weekly_target || 0) * 3600;
  const daily = perDay(entries, wk, 7);

  const byProj = new Map();
  for (const e of weekEntries) {
    const k = e.project_id || '';
    byProj.set(k, (byProj.get(k) || 0) + clipSec(e, wk, addDays(wk, 7)));
  }
  const projRows = [...byProj].map(([id, sec]) => {
    const p = byId(S.projects, id);
    return { name: p ? p.name : 'Geen project', color: p ? p.color : NO_PROJECT_COLOR, sec };
  }).sort((a, b) => b.sec - a.sec);

  const recent = entries.filter(e => entryStart(e) >= addDays(today, -6));
  const hello = now.getHours() < 12 ? 'Goedemorgen' : now.getHours() < 18 ? 'Goedemiddag' : 'Goedenavond';

  page.innerHTML = `
    <div class="page-head"><div><h1>${hello}, ${esc((S.me.full_name || '').split(' ')[0] || 'collega')}</h1><div class="muted">Week ${weekNumber(now)} · ${fmtDate(wk, { day: 'numeric', month: 'short' })} – ${fmtDate(addDays(wk, 6), { day: 'numeric', month: 'short' })}</div></div></div>
    <div class="tiles">
      <div class="card tile"><div class="label">Vandaag</div><div class="value num">${fmtHM(tToday)}</div><div class="sub">${S.running ? 'Timer loopt' : 'uren:minuten'}</div></div>
      <div class="card tile"><div class="label">Deze week</div><div class="value num">${fmtHM(tWeek)}</div>
        ${target ? `<div class="sub">${Math.round(tWeek / target * 100)}% van ${fmtHM(target)} doel</div><div class="meter ${tWeek > target ? 'over' : ''}"><span style="width:${Math.min(100, tWeek / target * 100)}%"></span></div>` : ''}</div>
      <div class="card tile"><div class="label">Deze maand</div><div class="value num">${fmtHM(tMonth)}</div><div class="sub">${fmtDate(now, { month: 'long' })}</div></div>
      <div class="card tile"><div class="label">Factureerbaar (week)</div><div class="value num">${tWeek ? Math.round(tBill / tWeek * 100) : 0}%</div><div class="sub">${fmtHM(tBill)} van ${fmtHM(tWeek)}</div></div>
    </div>
    <div class="cols">
      <div class="card"><div class="card-head"><h2>Uren per dag</h2><span class="muted small">deze week</span></div><div class="card-body"><div class="chart" id="d-chart"></div></div></div>
      <div class="card"><div class="card-head"><h2>Projecten</h2><span class="muted small">deze week</span></div><div class="card-body">${hbars(projRows.slice(0, 8), tWeek)}</div></div>
    </div>
    ${isAdmin() ? '<div class="card" id="d-live"></div>' : ''}
    <div class="card"><div class="card-head"><h2>Recente registraties</h2><a href="#calendar" class="small">Naar kalender</a></div><div id="d-list">${entryList(recent)}</div></div>`;

  barChart($('#d-chart'), daily.map((sec, i) => {
    const d = addDays(wk, i);
    return { label: `${DAYS_SHORT[i]} ${d.getDate()}`, value: sec / 3600, tip: `<b>${esc(fmtDate(d, { weekday: 'long', day: 'numeric', month: 'long' }))}</b><br>${fmtHM(sec)} u` };
  }));
  bindEntryList($('#d-list'), recent);
  if (isAdmin()) renderLiveTeam($('#d-live'));
}

async function renderLiveTeam(el) {
  const { data, error } = await sb.rpc('team_summary', { week_start: startOfWeek(new Date()).toISOString() });
  if (error) return fail(error);
  const live = data.filter(r => r.running_since);
  el.innerHTML = `<div class="card-head"><h2>Nu aan het werk</h2><a href="#team" class="small">Team</a></div>
    ${live.length ? `<table><tbody>${live.map(r => {
      const p = profileOf(r.user_id), pj = byId(S.projects, r.running_project);
      return `<tr><td><span class="row">${avatar(p)}${esc(p?.full_name || p?.email)}</span></td><td>${projLabel(pj)}</td><td class="r num muted">sinds ${hm(new Date(r.running_since))}</td></tr>`;
    }).join('')}</tbody></table>` : '<div class="empty">Er loopt momenteel geen timer bij je team.</div>'}`;
}

// =====================================================================
// Kalender (weekweergave)
// =====================================================================
const HOUR_PX = 48;
async function renderCalendar(page) {
  if (!S.cal.week) S.cal.week = startOfWeek(new Date());
  const uid = S.cal.user || S.me.id;
  const wk = S.cal.week, end = addDays(wk, 7);
  const entries = await fetchEntries({ from: wk, to: end, userId: uid });
  if (S.view !== 'calendar') return;
  const daily = perDay(entries, wk, 7);
  const total = daily.reduce((a, b) => a + b, 0);
  const today = startOfDay(new Date());

  page.innerHTML = `
    <div class="page-head">
      <div><h1>Kalender</h1><div class="muted">Week ${weekNumber(wk)} · ${fmtDate(wk, { day: 'numeric', month: 'long' })} – ${fmtDate(addDays(wk, 6), { day: 'numeric', month: 'long', year: 'numeric' })} · totaal <b class="num">${fmtHM(total)}</b></div></div>
      <div class="row">
        ${isAdmin() ? `<select id="c-user" aria-label="Medewerker">${S.profiles.map(p => `<option value="${p.id}" ${p.id === uid ? 'selected' : ''}>${esc(p.full_name || p.email)}</option>`).join('')}</select>` : ''}
        <button class="btn icon" id="c-prev" aria-label="Vorige week">${icon('left')}</button>
        <button class="btn" id="c-today">Deze week</button>
        <button class="btn icon" id="c-next" aria-label="Volgende week">${icon('right')}</button>
      </div>
    </div>
    <div class="card cal" id="cal">
      <div class="cal-dayhead" style="border-left:0"></div>
      ${[0, 1, 2, 3, 4, 5, 6].map(i => { const d = addDays(wk, i); return `<div class="cal-dayhead ${sameDay(d, today) ? 'today' : ''}"><div class="dn">${DAYS_SHORT[i]}</div><div class="dd">${d.getDate()}</div><div class="tot num">${fmtHM(daily[i])}</div></div>`; }).join('')}
      <div class="cal-scroll" id="cal-scroll">
        <div class="cal-hours">${Array.from({ length: 24 }, (_, h) => `<div>${h ? pad(h) + ':00' : ''}</div>`).join('')}</div>
        ${[0, 1, 2, 3, 4, 5, 6].map(i => `<div class="cal-col ${sameDay(addDays(wk, i), today) ? 'today' : ''}" data-day="${i}" style="height:${24 * HOUR_PX}px"></div>`).join('')}
      </div>
    </div>
    <div class="muted small">Klik op een leeg vak om een registratie toe te voegen, klik op een blok om te bewerken.</div>`;

  // Blokken per dag positioneren, met kolommen voor overlappende registraties
  $$('.cal-col', page).forEach(col => {
    const i = Number(col.dataset.day), d0 = addDays(wk, i), d1 = addDays(wk, i + 1);
    const segs = entries.map(e => ({ e, s: new Date(Math.max(entryStart(e), d0)), t: new Date(Math.min(entryEnd(e), d1)) }))
      .filter(x => x.t > x.s).sort((a, b) => a.s - b.s || b.t - a.t);
    let cluster = [], clusterEnd = 0;
    const flush = () => {
      const cols = [];
      for (const g of cluster) {
        let c = cols.findIndex(end => end <= g.s);
        if (c < 0) { c = cols.length; cols.push(0); }
        cols[c] = g.t; g.col = c;
      }
      cluster.forEach(g => g.ncol = cols.length);
      cluster = [];
    };
    for (const g of segs) { if (cluster.length && g.s >= clusterEnd) flush(); cluster.push(g); clusterEnd = Math.max(clusterEnd, g.t); }
    flush();
    col.innerHTML = segs.map(g => {
      const p = projectOf(g.e), color = p ? p.color : NO_PROJECT_COLOR;
      const top = (g.s - d0) / 3600000 * HOUR_PX, h = Math.max(18, (g.t - g.s) / 3600000 * HOUR_PX - 2);
      const w = 100 / g.ncol;
      return `<div class="cal-ev ${g.e.end_at ? '' : 'running'}" data-id="${g.e.id}" style="top:${top}px;height:${h}px;left:calc(${g.col * w}% + 2px);width:calc(${w}% - 4px);background:color-mix(in srgb, ${color} 18%, var(--surface));border-left:3px solid ${color}"
        data-tip="<b>${esc(g.e.description || '(geen omschrijving)')}</b><br>${esc(p?.name || 'Geen project')}<br>${hm(entryStart(g.e))} – ${g.e.end_at ? hm(entryEnd(g.e)) : 'nu'} · ${fmtHM(entrySec(g.e))}">
        <div class="t">${esc(g.e.description || p?.name || '(geen omschrijving)')}</div>
        ${h > 34 ? `<div class="s">${esc(p?.name || 'Geen project')} · ${fmtHM((g.t - g.s) / 1000)}</div>` : ''}
      </div>`;
    }).join('');
    if (sameDay(d0, today)) {
      const now = new Date();
      col.insertAdjacentHTML('beforeend', `<div class="now-line" style="top:${(now - d0) / 3600000 * HOUR_PX}px"></div>`);
    }
    col.addEventListener('click', ev => {
      const evEl = ev.target.closest('.cal-ev');
      if (evEl) { openEntryModal(entries.find(x => x.id === evEl.dataset.id)); return; }
      const mins = Math.floor((ev.offsetY / HOUR_PX) * 60 / 15) * 15;
      const s = new Date(d0); s.setMinutes(mins);
      openEntryModal(null, { start: s.getTime(), end: s.getTime() + 3600000, user_id: uid });
    });
  });

  const sc = $('#cal-scroll');
  const firstHour = entries.length ? Math.min(...entries.map(e => Math.max(wk, entryStart(e))).map(t => new Date(t).getHours())) : 7;
  sc.scrollTop = Math.max(0, Math.min(7, firstHour) * HOUR_PX - 8);

  $('#c-prev').onclick = () => { S.cal.week = addDays(wk, -7); refreshPage(); };
  $('#c-next').onclick = () => { S.cal.week = addDays(wk, 7); refreshPage(); };
  $('#c-today').onclick = () => { S.cal.week = startOfWeek(new Date()); refreshPage(); };
  if ($('#c-user')) $('#c-user').onchange = e => { S.cal.user = e.target.value; refreshPage(); };
}

// =====================================================================
// Rapporten
// =====================================================================
const PRESETS = [['week', 'Deze week'], ['lastweek', 'Vorige week'], ['month', 'Deze maand'], ['lastmonth', 'Vorige maand'], ['year', 'Dit jaar'], ['custom', 'Aangepast']];
function presetRange(k) {
  const now = new Date(), wk = startOfWeek(now), mo = startOfMonth(now);
  switch (k) {
    case 'week': return [wk, addDays(wk, 6)];
    case 'lastweek': return [addDays(wk, -7), addDays(wk, -1)];
    case 'month': return [mo, addDays(new Date(now.getFullYear(), now.getMonth() + 1, 1), -1)];
    case 'lastmonth': return [new Date(now.getFullYear(), now.getMonth() - 1, 1), addDays(mo, -1)];
    case 'year': return [new Date(now.getFullYear(), 0, 1), new Date(now.getFullYear(), 11, 31)];
  }
  return null;
}
const GROUPS = [['project', 'Project'], ['user', 'Medewerker'], ['client', 'Klant'], ['day', 'Dag'], ['description', 'Omschrijving']];

async function renderReports(page) {
  const R = S.rep;
  if (R.preset !== 'custom') { const [a, b] = presetRange(R.preset); R.from = ymd(a); R.to = ymd(b); }
  const from = parseYmd(R.from), to = addDays(parseYmd(R.to), 1);
  const userId = isAdmin() ? (R.user || null) : S.me.id;
  let entries = await fetchEntries({ from, to, userId, projectId: R.project || null });
  if (S.view !== 'reports') return;
  if (R.client) entries = entries.filter(e => projectOf(e)?.client_id === R.client);
  if (R.billable) entries = entries.filter(e => String(e.billable) === R.billable);

  const secOf = e => clipSec(e, from, to);
  const total = entries.reduce((a, e) => a + secOf(e), 0);
  const billSec = entries.filter(e => e.billable).reduce((a, e) => a + secOf(e), 0);
  const amount = entries.reduce((a, e) => a + amountFor(e, secOf(e)), 0);
  const days = Math.round((to - from) / DAY_MS);

  page.innerHTML = `
    <div class="page-head"><h1>Rapporten</h1>
      <div class="row"><button class="btn" id="r-csv">${icon('dl')}CSV exporteren</button></div></div>
    <div class="card card-body" style="display:flex;flex-direction:column;gap:12px">
      <div class="row">
        <div class="seg" id="r-preset">${PRESETS.map(([k, l]) => `<button data-p="${k}" class="${R.preset === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        <input type="date" id="r-from" value="${R.from}" aria-label="Van"><span class="muted">tot</span><input type="date" id="r-to" value="${R.to}" aria-label="Tot">
      </div>
      <div class="row">
        ${isAdmin() ? `<select id="r-user" aria-label="Medewerker"><option value="">Alle medewerkers</option>${S.profiles.map(p => `<option value="${p.id}" ${p.id === R.user ? 'selected' : ''}>${esc(p.full_name || p.email)}</option>`).join('')}</select>` : ''}
        <select id="r-client" aria-label="Klant"><option value="">Alle klanten</option>${S.clients.map(c => `<option value="${c.id}" ${c.id === R.client ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
        <select id="r-project" aria-label="Project">${projectOptions(R.project, { includeArchived: true, emptyLabel: 'Alle projecten' })}</select>
        <select id="r-bill" aria-label="Factureerbaar"><option value="">Factureerbaar en niet</option><option value="true" ${R.billable === 'true' ? 'selected' : ''}>Enkel factureerbaar</option><option value="false" ${R.billable === 'false' ? 'selected' : ''}>Enkel niet-factureerbaar</option></select>
      </div>
    </div>
    <div class="tiles">
      <div class="card tile"><div class="label">Totaal</div><div class="value num">${fmtHM(total)}</div><div class="sub">${fmtDec(total)} uur</div></div>
      <div class="card tile"><div class="label">Factureerbaar</div><div class="value num">${fmtHM(billSec)}</div><div class="sub">${total ? Math.round(billSec / total * 100) : 0}% van totaal</div></div>
      <div class="card tile"><div class="label">Bedrag</div><div class="value num">${fmtMoney(amount)}</div><div class="sub">factureerbare uren × tarief</div></div>
      <div class="card tile"><div class="label">Registraties</div><div class="value num">${entries.length}</div><div class="sub">${days} dag${days === 1 ? '' : 'en'}</div></div>
    </div>
    <div class="card"><div class="card-head"><h2>Uren per ${days <= 31 ? 'dag' : days <= 120 ? 'week' : 'maand'}</h2></div><div class="card-body"><div class="chart" id="r-chart"></div></div></div>
    <div class="card">
      <div class="card-head">
        <div class="seg" id="r-tab"><button data-t="summary" class="${R.tab === 'summary' ? 'on' : ''}">Samenvatting</button><button data-t="detail" class="${R.tab === 'detail' ? 'on' : ''}">Gedetailleerd</button></div>
        ${R.tab === 'summary' ? `<label class="row small muted">Groeperen op <select id="r-group">${GROUPS.filter(g => isAdmin() || g[0] !== 'user').map(([k, l]) => `<option value="${k}" ${R.group === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>` : ''}
      </div>
      <div class="table-wrap" id="r-table"></div>
    </div>`;

  // Grafiek: emmers per dag/week/maand
  const buckets = [];
  if (days <= 31) for (let i = 0; i < days; i++) { const d = addDays(from, i); buckets.push({ a: d, b: addDays(d, 1), label: days <= 7 ? `${DAYS_SHORT[(d.getDay() + 6) % 7]} ${d.getDate()}` : String(d.getDate()), tip: fmtDate(d, { weekday: 'long', day: 'numeric', month: 'long' }) }); }
  else if (days <= 120) for (let d = startOfWeek(from); d < to; d = addDays(d, 7)) buckets.push({ a: new Date(Math.max(d, from)), b: new Date(Math.min(addDays(d, 7), to)), label: `W${weekNumber(d)}`, tip: `Week ${weekNumber(d)} (${fmtDate(d, { day: 'numeric', month: 'short' })})` });
  else for (let d = startOfMonth(from); d < to; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) buckets.push({ a: new Date(Math.max(d, from)), b: new Date(Math.min(new Date(d.getFullYear(), d.getMonth() + 1, 1), to)), label: fmtDate(d, { month: 'short' }), tip: fmtDate(d, { month: 'long', year: 'numeric' }) });
  barChart($('#r-chart'), buckets.map(k => {
    const sec = entries.reduce((t, e) => t + clipSec(e, k.a, k.b), 0);
    return { label: k.label, value: sec / 3600, valueLabel: fmtHM(sec), tip: `<b>${esc(k.tip)}</b><br>${fmtHM(sec)} u` };
  }), { showValues: buckets.length <= 14 });

  const tbl = $('#r-table');
  if (R.tab === 'summary') {
    const keyOf = {
      project: e => e.project_id || '', user: e => e.user_id, client: e => projectOf(e)?.client_id || '',
      day: e => ymd(entryStart(e)), description: e => e.description.trim().toLowerCase()
    }[R.group];
    const g = new Map();
    for (const e of entries) {
      const k = keyOf(e);
      const row = g.get(k) || { k, sample: e, sec: 0, bill: 0, amt: 0, n: 0 };
      const s = secOf(e);
      row.sec += s; row.bill += e.billable ? s : 0; row.amt += amountFor(e, s); row.n++;
      g.set(k, row);
    }
    const nameOf = r => {
      if (R.group === 'project') return projLabel(byId(S.projects, r.k));
      if (R.group === 'user') { const p = profileOf(r.k); return `<span class="row">${avatar(p)}${esc(p?.full_name || p?.email || 'Onbekend')}</span>`; }
      if (R.group === 'client') return esc(byId(S.clients, r.k)?.name || 'Zonder klant');
      if (R.group === 'day') return esc(fmtDate(parseYmd(r.k), { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }));
      return r.sample.description ? esc(r.sample.description) : '<span class="muted">(geen omschrijving)</span>';
    };
    const rows = [...g.values()].sort((a, b) => R.group === 'day' ? a.k.localeCompare(b.k) : b.sec - a.sec);
    tbl.innerHTML = rows.length ? `<table><thead><tr><th>${GROUPS.find(x => x[0] === R.group)[1]}</th><th class="r">Uren</th><th class="r">Factureerbaar</th><th class="r">Bedrag</th><th style="width:22%">Aandeel</th></tr></thead><tbody>
      ${rows.map(r => `<tr><td>${nameOf(r)}</td><td class="r num"><b>${fmtHM(r.sec)}</b></td><td class="r num">${fmtHM(r.bill)}</td><td class="r num">${fmtMoney(r.amt)}</td>
        <td><div class="row" style="flex-wrap:nowrap"><div class="meter" style="flex:1;margin:0"><span style="width:${total ? r.sec / total * 100 : 0}%"></span></div><span class="small muted num" style="width:36px;text-align:right">${total ? Math.round(r.sec / total * 100) : 0}%</span></div></td></tr>`).join('')}
      <tr><td><b>Totaal</b></td><td class="r num"><b>${fmtHM(total)}</b></td><td class="r num"><b>${fmtHM(billSec)}</b></td><td class="r num"><b>${fmtMoney(amount)}</b></td><td></td></tr>
      </tbody></table>` : '<div class="empty">Geen registraties voor deze filters.</div>';
  } else {
    const sorted = [...entries].sort((a, b) => entryStart(b) - entryStart(a));
    tbl.innerHTML = sorted.length ? `<table><thead><tr><th>Datum</th><th>Omschrijving</th><th>Project</th>${isAdmin() ? '<th>Medewerker</th>' : ''}<th>Tijd</th><th class="r">Duur</th><th class="r">Bedrag</th><th></th></tr></thead><tbody>
      ${sorted.map(e => `<tr data-id="${e.id}"><td class="num">${esc(fmtDate(entryStart(e), { day: '2-digit', month: '2-digit', year: 'numeric' }))}</td>
        <td>${e.description ? esc(e.description) : '<span class="muted">(geen omschrijving)</span>'}</td><td>${projLabel(projectOf(e))}</td>
        ${isAdmin() ? `<td>${esc(profileOf(e.user_id)?.full_name || '')}</td>` : ''}
        <td class="num muted">${hm(entryStart(e))}–${e.end_at ? hm(entryEnd(e)) : 'nu'}</td><td class="r num"><b>${fmtHM(entrySec(e))}</b></td>
        <td class="r num">${e.billable ? fmtMoney(amountFor(e, entrySec(e))) : '<span class="muted">–</span>'}</td>
        <td class="r"><button class="btn icon ghost" data-edit aria-label="Bewerken">${icon('edit')}</button></td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">Geen registraties voor deze filters.</div>';
    $$('[data-edit]', tbl).forEach(b => b.onclick = () => openEntryModal(entries.find(x => x.id === b.closest('tr').dataset.id)));
  }

  const set = patch => { Object.assign(R, patch); refreshPage(); };
  $$('#r-preset button').forEach(b => b.onclick = () => set({ preset: b.dataset.p }));
  $('#r-from').onchange = e => e.target.value && set({ preset: 'custom', from: e.target.value, to: R.to < e.target.value ? e.target.value : R.to });
  $('#r-to').onchange = e => e.target.value && set({ preset: 'custom', to: e.target.value, from: R.from > e.target.value ? e.target.value : R.from });
  if ($('#r-user')) $('#r-user').onchange = e => set({ user: e.target.value });
  $('#r-client').onchange = e => set({ client: e.target.value });
  $('#r-project').onchange = e => set({ project: e.target.value });
  $('#r-bill').onchange = e => set({ billable: e.target.value });
  $$('#r-tab button').forEach(b => b.onclick = () => set({ tab: b.dataset.t }));
  if ($('#r-group')) $('#r-group').onchange = e => set({ group: e.target.value });
  $('#r-csv').onclick = () => exportCsv(entries, from, to);
}

function exportCsv(entries, from, to) {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Datum', 'Start', 'Einde', 'Duur (u:mm)', 'Duur (decimaal)', 'Medewerker', 'E-mail', 'Klant', 'Project', 'Omschrijving', 'Factureerbaar', 'Tarief', 'Bedrag'];
  const rows = [...entries].sort((a, b) => entryStart(a) - entryStart(b)).map(e => {
    const p = projectOf(e), u = profileOf(e.user_id), sec = entrySec(e);
    return [ymd(entryStart(e)), hm(entryStart(e)), e.end_at ? hm(entryEnd(e)) : '', fmtHM(sec), (sec / 3600).toFixed(2).replace('.', ','),
      u?.full_name, u?.email, clientOf(p)?.name, p?.name, e.description, e.billable ? 'Ja' : 'Nee',
      rateFor(e).toFixed(2).replace('.', ','), amountFor(e, sec).toFixed(2).replace('.', ',')];
  });
  const csv = '﻿' + [head, ...rows].map(r => r.map(q).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `polyfy-rapport-${ymd(from)}-tot-${ymd(addDays(to, -1))}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// =====================================================================
// Projecten & klanten
// =====================================================================
async function renderProjects(page) {
  const { data: totals, error } = await sb.rpc('project_totals');
  if (error) throw error;
  if (S.view !== 'projects') return;
  const tot = new Map(totals.map(t => [t.project_id, t]));
  const P = S.proj;
  const list = S.projects
    .filter(p => P.status === 'all' || (P.status === 'archived') === p.archived)
    .filter(p => !P.search || (p.name + ' ' + (clientOf(p)?.name || '')).toLowerCase().includes(P.search.toLowerCase()));

  page.innerHTML = `
    <div class="page-head"><h1>Projecten</h1>${isAdmin() ? `<button class="btn primary" id="p-new">${icon('plus')}Nieuw project</button>` : ''}</div>
    <div class="row">
      <input id="p-search" placeholder="Zoek project of klant…" value="${esc(P.search)}" style="min-width:240px">
      <div class="seg" id="p-status">${[['active', 'Actief'], ['archived', 'Gearchiveerd'], ['all', 'Alle']].map(([k, l]) => `<button data-s="${k}" class="${P.status === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    </div>
    <div class="card table-wrap">
      ${list.length ? `<table><thead><tr><th>Project</th><th>Klant</th><th class="r">Geregistreerd</th><th style="width:22%">Budget</th><th>Type</th><th class="r">Tarief</th>${isAdmin() ? '<th></th>' : ''}</tr></thead><tbody>
      ${list.map(p => {
        const t = tot.get(p.id), sec = Number(t?.total_seconds || 0), budget = p.budget_hours ? Number(p.budget_hours) * 3600 : 0, pct = budget ? sec / budget * 100 : 0;
        return `<tr data-id="${p.id}">
          <td><a href="#reports" data-rep class="proj" style="color:var(--text);text-decoration:none"><span class="dot" style="background:${esc(p.color)}"></span>${esc(p.name)}</a>${p.archived ? ' <span class="tag">gearchiveerd</span>' : ''}</td>
          <td>${esc(clientOf(p)?.name || '–')}</td>
          <td class="r num"><b>${fmtHM(sec)}</b></td>
          <td>${budget ? `<div class="small num ${pct > 100 ? '' : 'muted'}" style="${pct > 100 ? 'color:var(--warn);font-weight:600' : ''}">${fmtHM(sec)} / ${fmtHM(budget)} (${Math.round(pct)}%)</div><div class="meter ${pct > 100 ? 'over' : ''}" style="margin-top:4px"><span style="width:${Math.min(100, pct)}%"></span></div>` : '<span class="muted">geen budget</span>'}</td>
          <td>${p.billable ? '<span class="tag">factureerbaar</span>' : '<span class="tag">intern</span>'}</td>
          <td class="r num">${p.hourly_rate != null ? fmtMoney(Number(p.hourly_rate)) : '<span class="muted">per persoon</span>'}</td>
          ${isAdmin() ? `<td class="r"><button class="btn icon ghost" data-edit aria-label="Bewerken">${icon('edit')}</button></td>` : ''}
        </tr>`;
      }).join('')}</tbody></table>` : `<div class="empty">${S.projects.length ? 'Geen projecten gevonden.' : isAdmin() ? 'Nog geen projecten. Maak je eerste project aan.' : 'Er zijn nog geen projecten. Vraag een beheerder om ze aan te maken.'}</div>`}
    </div>
    <div class="card">
      <div class="card-head"><h2>Klanten</h2>${isAdmin() ? `<button class="btn" id="c-new">${icon('plus')}Klant</button>` : ''}</div>
      ${S.clients.length ? `<table><tbody>${S.clients.map(c => {
        const ps = S.projects.filter(p => p.client_id === c.id);
        const sec = ps.reduce((a, p) => a + Number(tot.get(p.id)?.total_seconds || 0), 0);
        return `<tr data-cid="${c.id}"><td><b>${esc(c.name)}</b>${c.archived ? ' <span class="tag">gearchiveerd</span>' : ''}</td><td class="muted">${ps.length} project${ps.length === 1 ? '' : 'en'}</td><td class="r num">${fmtHM(sec)}</td>
          ${isAdmin() ? `<td class="r"><button class="btn icon ghost" data-cedit aria-label="Bewerken">${icon('edit')}</button></td>` : ''}</tr>`;
      }).join('')}</tbody></table>` : '<div class="empty">Nog geen klanten.</div>'}
    </div>`;

  const search = $('#p-search');
  search.oninput = debounce(() => { P.search = search.value; refreshPage(); setTimeout(() => { const s = $('#p-search'); s?.focus(); s?.setSelectionRange(s.value.length, s.value.length); }); }, 250);
  $$('#p-status button').forEach(b => b.onclick = () => { P.status = b.dataset.s; refreshPage(); });
  $$('[data-rep]').forEach(a => a.onclick = ev => {
    Object.assign(S.rep, { project: a.closest('tr').dataset.id, client: '', preset: 'year', tab: 'summary', group: isAdmin() ? 'user' : 'day' });
  });
  if (isAdmin()) {
    $('#p-new').onclick = () => openProjectModal(null);
    $('#c-new').onclick = () => openClientModal(null);
    $$('[data-edit]').forEach(b => b.onclick = () => openProjectModal(byId(S.projects, b.closest('tr').dataset.id)));
    $$('[data-cedit]').forEach(b => b.onclick = () => openClientModal(byId(S.clients, b.closest('tr').dataset.cid)));
  }
}

function openProjectModal(p) {
  const used = new Set(S.projects.map(x => x.color));
  const cur = p || { name: '', client_id: null, color: PROJECT_COLORS.find(c => !used.has(c)) || PROJECT_COLORS[S.projects.length % PROJECT_COLORS.length], billable: true, hourly_rate: null, budget_hours: null, archived: false };
  let color = cur.color;
  const m = openModal(p ? 'Project bewerken' : 'Nieuw project', `
    <label class="field">Naam<input id="pm-name" value="${esc(cur.name)}" required></label>
    <label class="field">Klant<select id="pm-client"><option value="">Zonder klant</option>${S.clients.filter(c => !c.archived || c.id === cur.client_id).map(c => `<option value="${c.id}" ${c.id === cur.client_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}<option value="__new">+ Nieuwe klant…</option></select></label>
    <div class="field">Kleur<div class="swatches">${PROJECT_COLORS.map(c => `<button type="button" class="swatch ${c === color ? 'on' : ''}" data-c="${c}" style="background:${c}" aria-label="Kleur ${c}"></button>`).join('')}</div></div>
    <div class="grid2">
      <label class="field">Uurtarief (${esc(CFG.CURRENCY || 'EUR')})<input id="pm-rate" type="number" min="0" step="0.01" value="${cur.hourly_rate ?? ''}" placeholder="tarief per medewerker"></label>
      <label class="field">Budget (uren)<input id="pm-budget" type="number" min="0" step="0.5" value="${cur.budget_hours ?? ''}" placeholder="geen budget"></label>
    </div>
    <label class="check"><input type="checkbox" id="pm-bill" ${cur.billable ? 'checked' : ''}> Standaard factureerbaar</label>
    ${p ? `<label class="check"><input type="checkbox" id="pm-arch" ${cur.archived ? 'checked' : ''}> Gearchiveerd (niet meer kiesbaar bij registreren)</label>` : ''}`,
    `<div>${p ? `<button class="btn danger" id="pm-del">${icon('trash')}Verwijderen</button>` : ''}</div><div class="row"><button class="btn" data-close>Annuleren</button><button class="btn primary" id="pm-save">Opslaan</button></div>`);
  $$('.swatch', m).forEach(s => s.onclick = () => { color = s.dataset.c; $$('.swatch', m).forEach(x => x.classList.toggle('on', x === s)); });
  $('#pm-client').onchange = async e => {
    if (e.target.value !== '__new') return;
    const name = prompt('Naam van de nieuwe klant');
    if (!name?.trim()) { e.target.value = cur.client_id || ''; return; }
    const { data, error } = await sb.from('clients').insert({ name: name.trim() }).select().single();
    if (error) { e.target.value = ''; return fail(error); }
    S.clients.push(data); S.clients.sort((a, b) => a.name.localeCompare(b.name));
    const opt = new Option(data.name, data.id, true, true);
    e.target.insertBefore(opt, e.target.querySelector('option[value="__new"]'));
  };
  $('#pm-save').onclick = async () => {
    const name = $('#pm-name').value.trim();
    if (!name) return toast('Geef het project een naam.', true);
    const num = v => v === '' ? null : Number(v);
    const row = { name, client_id: $('#pm-client').value || null, color, billable: $('#pm-bill').checked, hourly_rate: num($('#pm-rate').value), budget_hours: num($('#pm-budget').value) };
    if (p) row.archived = $('#pm-arch').checked;
    const { data, error } = p ? await sb.from('projects').update(row).eq('id', p.id).select().single() : await sb.from('projects').insert(row).select().single();
    if (error) return fail(error);
    if (p) Object.assign(p, data); else S.projects.push(data);
    S.projects.sort((a, b) => a.name.localeCompare(b.name));
    closeModal(); toast('Project opgeslagen'); renderTimer(); refreshPage();
  };
  if (p) $('#pm-del').onclick = async () => {
    if (!confirm(`Project "${p.name}" verwijderen? Bestaande registraties blijven bewaard zonder project. Archiveren is meestal beter.`)) return;
    const { error } = await sb.from('projects').delete().eq('id', p.id);
    if (error) return fail(error);
    S.projects = S.projects.filter(x => x.id !== p.id);
    closeModal(); toast('Project verwijderd'); renderTimer(); refreshPage();
  };
}

function openClientModal(c) {
  openModal(c ? 'Klant bewerken' : 'Nieuwe klant', `
    <label class="field">Naam<input id="cm-name" value="${esc(c?.name || '')}" required></label>
    ${c ? `<label class="check"><input type="checkbox" id="cm-arch" ${c.archived ? 'checked' : ''}> Gearchiveerd</label>` : ''}`,
    `<div>${c ? `<button class="btn danger" id="cm-del">${icon('trash')}Verwijderen</button>` : ''}</div><div class="row"><button class="btn" data-close>Annuleren</button><button class="btn primary" id="cm-save">Opslaan</button></div>`);
  $('#cm-save').onclick = async () => {
    const name = $('#cm-name').value.trim();
    if (!name) return toast('Geef de klant een naam.', true);
    const row = { name }; if (c) row.archived = $('#cm-arch').checked;
    const { data, error } = c ? await sb.from('clients').update(row).eq('id', c.id).select().single() : await sb.from('clients').insert(row).select().single();
    if (error) return fail(error);
    if (c) Object.assign(c, data); else S.clients.push(data);
    S.clients.sort((a, b) => a.name.localeCompare(b.name));
    closeModal(); toast('Klant opgeslagen'); renderTimer(); refreshPage();
  };
  if (c) $('#cm-del').onclick = async () => {
    if (!confirm(`Klant "${c.name}" verwijderen? De projecten blijven bestaan, zonder klant.`)) return;
    const { error } = await sb.from('clients').delete().eq('id', c.id);
    if (error) return fail(error);
    S.clients = S.clients.filter(x => x.id !== c.id);
    S.projects.forEach(p => { if (p.client_id === c.id) p.client_id = null; });
    closeModal(); toast('Klant verwijderd'); renderTimer(); refreshPage();
  };
}

// =====================================================================
// Team
// =====================================================================
function relTime(d) {
  const min = Math.round((Date.now() - d) / 60000);
  if (min < 1) return 'zonet';
  if (min < 60) return `${min} min geleden`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} u geleden`;
  const days = Math.round(h / 24);
  return days === 1 ? 'gisteren' : `${days} dagen geleden`;
}

async function renderTeam(page) {
  const wk = startOfWeek(new Date());
  const { data, error } = await sb.rpc('team_summary', { week_start: wk.toISOString() });
  if (error) throw error;
  if (S.view !== 'team') return;
  const sum = new Map(data.map(r => [r.user_id, r]));
  const members = [...S.profiles].sort((a, b) => (b.active - a.active) || (a.full_name || a.email).localeCompare(b.full_name || b.email));
  const teamWeek = data.reduce((a, r) => a + Number(r.week_seconds), 0);
  const liveCount = data.filter(r => r.running_since).length;
  const link = location.origin + location.pathname;

  page.innerHTML = `
    <div class="page-head"><div><h1>Team</h1><div class="muted">${members.filter(m => m.active).length} actieve leden · week ${weekNumber(wk)}</div></div></div>
    <div class="tiles">
      <div class="card tile"><div class="label">Teamuren deze week</div><div class="value num">${fmtHM(teamWeek)}</div></div>
      <div class="card tile"><div class="label">Nu aan het werk</div><div class="value num">${liveCount}</div><div class="sub">lopende timers</div></div>
      <div class="card tile"><div class="label">Gemiddeld per lid</div><div class="value num">${fmtHM(teamWeek / Math.max(1, members.filter(m => m.active).length))}</div></div>
      <div class="card tile"><div class="label">Beheerders</div><div class="value num">${members.filter(m => m.role === 'admin').length}</div></div>
    </div>
    <div class="card table-wrap"><table>
      <thead><tr><th>Lid</th><th>Status</th><th style="width:24%">Deze week</th>${isAdmin() ? '<th class="r">Uurtarief</th><th></th>' : ''}</tr></thead>
      <tbody>${members.map(p => {
        const r = sum.get(p.id) || {}, sec = Number(r.week_seconds || 0), target = Number(p.weekly_target || 0) * 3600, pj = byId(S.projects, r.running_project);
        return `<tr data-id="${p.id}">
          <td><span class="row" style="flex-wrap:nowrap">${avatar(p)}<span><b>${esc(p.full_name || p.email)}</b> ${p.role === 'admin' ? '<span class="tag admin">beheerder</span>' : ''} ${p.active ? '' : '<span class="tag off">gedeactiveerd</span>'}<br><span class="muted small">${esc(p.email)}</span></span></span></td>
          <td>${r.running_since ? `<span class="tag live">● aan het werk</span> <span class="small">${pj ? esc(pj.name) : ''} sinds ${hm(new Date(r.running_since))}</span>` : `<span class="muted small">${r.last_activity ? 'laatst actief ' + relTime(new Date(r.last_activity)) : 'nog geen registraties'}</span>`}</td>
          <td><div class="small num"><b>${fmtHM(sec)}</b>${target ? ` <span class="muted">/ ${fmtHM(target)}</span>` : ''}</div>${target ? `<div class="meter ${sec > target ? 'over' : ''}" style="margin-top:4px"><span style="width:${Math.min(100, sec / target * 100)}%"></span></div>` : ''}</td>
          ${isAdmin() ? `<td class="r num">${fmtMoney(Number(p.hourly_rate || 0))}</td><td class="r" style="white-space:nowrap"><a class="btn icon ghost" href="#reports" data-rep title="Rapport" aria-label="Rapport">${icon('rep')}</a><button class="btn icon ghost" data-edit aria-label="Bewerken">${icon('edit')}</button></td>` : ''}
        </tr>`;
      }).join('')}</tbody></table></div>
    <div class="card"><div class="card-head"><h2>Collega's uitnodigen</h2></div><div class="card-body">
      <p style="margin-top:0">Deel deze link. Nieuwe collega's maken zelf een account en verschijnen dan hier als medewerker.${CFG.ALLOWED_EMAIL_DOMAIN ? ` Enkel adressen van <b>@${esc(CFG.ALLOWED_EMAIL_DOMAIN)}</b> kunnen registreren.` : ''}</p>
      <div class="row"><input readonly value="${esc(link)}" style="flex:1;min-width:200px" id="t-link"><button class="btn" id="t-copy">Kopiëren</button></div>
    </div></div>`;

  $('#t-copy').onclick = async () => { try { await navigator.clipboard.writeText(link); toast('Link gekopieerd'); } catch (_) { $('#t-link').select(); } };
  if (isAdmin()) {
    $$('[data-edit]').forEach(b => b.onclick = () => openMemberModal(profileOf(b.closest('tr').dataset.id)));
    $$('[data-rep]').forEach(a => a.onclick = () => Object.assign(S.rep, { user: a.closest('tr').dataset.id, project: '', client: '', group: 'project', tab: 'summary' }));
  }
}

function openMemberModal(p) {
  const self = p.id === S.me.id;
  openModal('Teamlid bewerken', `
    <div class="row">${avatar(p)}<div><b>${esc(p.full_name || p.email)}</b><div class="muted small">${esc(p.email)}</div></div></div>
    <label class="field">Naam<input id="mm-name" value="${esc(p.full_name)}"></label>
    <div class="grid2">
      <label class="field">Rol<select id="mm-role" ${self ? 'disabled' : ''}><option value="member" ${p.role === 'member' ? 'selected' : ''}>Medewerker</option><option value="admin" ${p.role === 'admin' ? 'selected' : ''}>Beheerder</option></select></label>
      <label class="field">Uurtarief (${esc(CFG.CURRENCY || 'EUR')})<input id="mm-rate" type="number" min="0" step="0.01" value="${p.hourly_rate}"></label>
    </div>
    <label class="field">Weekdoel (uren)<input id="mm-target" type="number" min="0" max="168" step="0.5" value="${p.weekly_target}"></label>
    ${self ? '<div class="muted small">Je kan je eigen rol niet wijzigen of je eigen account deactiveren.</div>' : `<label class="check"><input type="checkbox" id="mm-active" ${p.active ? 'checked' : ''}> Actief (uitgeschakeld = kan niet meer registreren)</label>`}`,
    `<div></div><div class="row"><button class="btn" data-close>Annuleren</button><button class="btn primary" id="mm-save">Opslaan</button></div>`);
  $('#mm-save').onclick = async () => {
    const row = { full_name: $('#mm-name').value.trim(), hourly_rate: Number($('#mm-rate').value || 0), weekly_target: Number($('#mm-target').value || 0) };
    if (!self) { row.role = $('#mm-role').value; row.active = $('#mm-active').checked; }
    const { data, error } = await sb.from('profiles').update(row).eq('id', p.id).select().single();
    if (error) return fail(error);
    Object.assign(p, data);
    closeModal(); toast('Teamlid opgeslagen'); refreshPage();
  };
}

init().catch(fail);
