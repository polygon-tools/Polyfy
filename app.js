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
  profiles: [], projects: [], clients: [], tags: [], tagsReady: false, running: null,
  view: 'dashboard',
  cal: { from: null, user: null, mode: 'week', zoom: 48 },
  rep: { from: null, to: null, user: '', project: '', client: '', tag: '', desc: '', g1: 'project', g2: 'description', tab: 'summary', open: new Set() },
  team: { status: 'active', role: '', q: '' },
  proj: { search: '', status: 'active', client: '' },
  trk: { weeks: 2, open: new Set() },
  dash: { from: null, to: null, group: 'project', who: 'me' },
  imp: null
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
// "15:15", "1515", "915" of "9" -> [uur, minuut] (24-uurs); ongeldig = null
function parseHM(v) {
  const t = String(v).trim().replace(/[.h]/, ':'), m = t.match(/^(\d{1,2})(?::?(\d{2}))?$/);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2] || 0);
  return h < 24 && mi < 60 ? [h, mi] : null;
}
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
const fmtHMS = sec => { sec = Math.max(0, Math.round(sec)); return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor(sec / 60) % 60)}:${pad(sec % 60)}`; };
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
// Geïmporteerde uren van iemand zonder account hebben user_id = null en een naam/e-mail uit Clockify
const entryUserName = e => profileOf(e.user_id)?.full_name || (e.import_name || e.import_email ? `${e.import_name || e.import_email} (nog geen account)` : '');
const clientOf = p => p ? byId(S.clients, p.client_id) : null;
const byName = (a, b) => a.name.localeCompare(b.name);
// Tags: enkel bewaren als schema-v2 uitgevoerd is (anders bestaat de kolom tag_ids nog niet)
const tagField = ids => S.tagsReady ? { tag_ids: ids || [] } : {};
const tagNames = ids => (ids || []).map(id => byId(S.tags, id)?.name).filter(Boolean);
const tagChips = ids => tagNames(ids).map(n => ` <span class="tag">${esc(n)}</span>`).join('');
const rateFor = e => Number(profileOf(e.user_id)?.hourly_rate || 0);
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
  // Tags bestaan pas na schema-v2-tags-import.sql; zonder die tabel werkt de rest gewoon verder.
  const tg = await sb.from('tags').select('*').order('name');
  S.tagsReady = !tg.error; S.tags = tg.data || [];
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
  logout: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>',
  up: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  dots: '<circle cx="12" cy="5" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="12" cy="19" r="1.2"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  client: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="10" r="3"/><path d="M6.5 18.5a6.5 6.5 0 0 1 11 0"/>',
  pdf: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M9 14h6M9 18h4"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.5"/>'
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
// Paginanamen zoals in Clockify; 4e veld = sectietitel die erboven komt
const NAV = [
  ['tracker', 'Time Tracker', 'clock'], ['calendar', 'Calendar', 'cal'],
  ['dashboard', 'Dashboard', 'dash', 'Analyze'], ['reports', 'Reports', 'rep'],
  ['projects', 'Projects', 'proj', 'Manage'], ['team', 'Team', 'team'], ['clients', 'Clients', 'client'], ['tags', 'Tags', 'tag'], ['import', 'Import', 'up']
];
const navItems = () => NAV.filter(n => n[0] !== 'import' || isAdmin());
const DEFAULT_VIEW = 'tracker';

function renderShell() {
  app.innerHTML = `<div class="shell" id="shell">
    <aside class="side">
      <div class="brand">${LOGO}Polyfy</div>
      <nav class="nav">${navItems().map(([k, l, i, sec]) => `${sec ? `<div class="nav-sec">${sec}</div>` : ''}<a href="#${k}" data-nav="${k}">${icon(i)}<span>${l}</span>${k === 'tracker' ? '<span class="nav-clock num" id="nav-clock"></span>' : ''}</a>`).join('')}</nav>
      <div class="side-foot">
        <button class="me" id="me-btn" title="Profiel & instellingen">${avatar(S.me)}<div class="who"><div style="font-weight:600">${esc(S.me.full_name || S.me.email)}</div><div class="muted small">${isAdmin() ? 'Beheerder' : 'Medewerker'}</div></div></button>
      </div>
    </aside>
    <div class="main">
      <div class="mobile-top"><button class="btn icon ghost" id="nav-toggle" aria-label="Menu">${icon('menu')}</button>Polyfy</div>
      <div class="content" id="page"></div>
    </div>
  </div>`;
  $('#me-btn').onclick = openProfileModal;
  $('#nav-toggle').onclick = () => $('#shell').classList.toggle('nav-open');
  $$('.nav a').forEach(a => a.onclick = () => $('#shell').classList.remove('nav-open'));
  startTick();
}

window.addEventListener('hashchange', () => { if (S.me) route(); });
window.addEventListener('focus', async () => {
  // Timer kan in een ander tabblad/toestel gestart of gestopt zijn
  if (!S.me) return;
  const { data } = await sb.from('time_entries').select('*').eq('user_id', S.me.id).is('end_at', null).maybeSingle();
  if ((data?.id || null) !== (S.running?.id || null)) { S.running = data; renderTimer(); refreshPage(); }
});

function route() {
  const v = (location.hash.slice(1) || DEFAULT_VIEW).split('?')[0];
  S.view = navItems().some(n => n[0] === v) ? v : DEFAULT_VIEW;
  $$('.nav a').forEach(a => a.classList.toggle('active', a.dataset.nav === S.view));
  startTick();
  refreshPage();
}
function refreshPage() {
  const page = $('#page'); if (!page) return;
  ({ tracker: renderTracker, calendar: renderCalendar, dashboard: renderDashboard, reports: renderReports,
     projects: renderProjects, team: renderTeam, clients: renderClients, tags: renderTags, import: renderImport })[S.view](page)
    .catch(fail);
}

// ---------- Timer ----------
let timerTick = null;
let draft = { description: '', project_id: '', billable: true, tag_ids: [] };
// Time Tracker-modus zoals in Clockify: 'timer' (start/stop) of 'manual' (start- en eindtijd ingeven)
let trkMode = (() => { try { return localStorage.getItem('polyfy-mode') || 'timer'; } catch (_) { return 'timer'; } })();
let manual = null;

// Lopende timer: klok op de Time Tracker-pagina, in het menu en in de paginatitel
function startTick() {
  clearInterval(timerTick);
  const upd = () => {
    const r = S.running;
    const c = $('#t-clock'); if (c) c.textContent = fmtHMS(r ? entrySec(r) : 0);
    const n = $('#nav-clock'); if (n) n.textContent = r ? fmtClock(entrySec(r)) : '';
    document.title = r ? `${fmtClock(entrySec(r))} · Polyfy` : `${NAV.find(x => x[0] === S.view)?.[1] || 'Polyfy'} · Polyfy`;
  };
  upd();
  if (S.running) timerTick = setInterval(upd, 1000);
}

// Knoptekst voor een project: gekleurde naam + klant, of "+ Project"
function projBtnHtml(pid) {
  const p = byId(S.projects, pid);
  return p ? `<span class="dot" style="background:${esc(p.color)}"></span><span class="pn" style="color:${esc(p.color)}">${esc(p.name)}</span>${clientOf(p) ? `<span class="muted"> - ${esc(clientOf(p).name)}</span>` : ''}`
    : `${icon('plus')}<span>Project</span>`;
}

function renderTimer() {
  startTick();
  const bar = $('#timerbar'); if (!bar) return;
  const r = S.running, cur = r || draft, man = trkMode === 'manual' && !r;
  if (man && !manual) { const now = new Date(); manual = { date: ymd(now), start: hm(now), end: hm(now) }; }
  bar.classList.toggle('running', !!r);
  bar.innerHTML = `
    <input class="desc" id="t-desc" placeholder="Waar heb je aan gewerkt?" value="${esc(cur.description)}" aria-label="Omschrijving">
    <button class="btn ghost projbtn" id="t-proj" title="Project">${projBtnHtml(cur.project_id)}</button>
    ${S.tagsReady ? `<button class="btn ghost tagbtn" id="t-tags" title="Tags">${tagBtnHtml(cur.tag_ids)}</button>` : ''}
    <button class="billable-toggle ${cur.billable ? 'on' : ''}" id="t-bill" title="Factureerbaar" aria-pressed="${!!cur.billable}">€</button>
    ${man ? `<span class="tb-times"><input class="hm num" id="t-start" value="${manual.start}" aria-label="Start" inputmode="numeric"><span class="muted">–</span><input class="hm num" id="t-end" value="${manual.end}" aria-label="Einde" inputmode="numeric"><input type="date" id="t-date" value="${manual.date}" aria-label="Datum"></span>
        <input class="clock num tb-dur" id="t-dur" aria-label="Duur">
        <button class="btn start" id="t-add">Toevoegen</button>`
      : `<span class="clock num" id="t-clock">${fmtHMS(r ? entrySec(r) : 0)}</span>
        <button class="btn ${r ? 'stop' : 'start'}" id="t-go">${r ? 'Stop' : 'Start'}</button>`}
    <div class="modes"><button class="${man ? '' : 'on'}" data-mode="timer" title="Timer" aria-label="Timer">${icon('clock')}</button><button class="${man ? 'on' : ''}" data-mode="manual" title="Manueel" aria-label="Manueel">${icon('list')}</button></div>`;

  const desc = $('#t-desc'), bill = $('#t-bill');
  const saveRunning = async patch => {
    if (!S.running) { Object.assign(draft, patch); return; }
    const { data, error } = await sb.from('time_entries').update(patch).eq('id', S.running.id).select().single();
    if (error) return fail(error);
    S.running = data;
  };
  desc.onchange = () => saveRunning({ description: desc.value.trim() });
  desc.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); if (man) addManual(); else if (!S.running) startTimer(); else desc.blur(); } };
  $('#t-proj').onclick = () => pickProject($('#t-proj'), cur.project_id, pid => {
    const p = byId(S.projects, pid), patch = { project_id: pid };
    if (p) { patch.billable = p.billable; bill.classList.toggle('on', p.billable); }
    $('#t-proj').innerHTML = projBtnHtml(pid); cur.project_id = pid;
    saveRunning(patch);
  });
  bill.onclick = () => { const on = !bill.classList.contains('on'); bill.classList.toggle('on', on); saveRunning({ billable: on }); };
  if (S.tagsReady) bindTagPicker($('#t-tags'), () => (S.running || draft).tag_ids || [], ids => saveRunning({ tag_ids: ids }));
  $$('.modes [data-mode]', bar).forEach(b => b.onclick = () => {
    trkMode = b.dataset.mode; try { localStorage.setItem('polyfy-mode', trkMode); } catch (_) {}
    draft.description = desc.value; renderTimer();
  });
  if (!man) { $('#t-go').onclick = () => S.running ? stopTimer() : startTimer(); return; }

  // Manueel: duur volgt uit start/einde; een duur typen verschuift het einde
  const times = () => {
    const d = parseYmd($('#t-date').value || ymd(new Date()));
    const at = v => { const [h, m] = parseHM(v) || [0, 0]; const x = new Date(d); x.setHours(h, m, 0, 0); return x; };
    const s = at($('#t-start').value); let e = at($('#t-end').value);
    if (e < s) e = addDays(e, 1);
    return { s, e };
  };
  const showDur = () => { const { s, e } = times(); $('#t-dur').value = fmtHMS((e - s) / 1000); };
  const keep = () => Object.assign(manual, { date: $('#t-date').value, start: $('#t-start').value, end: $('#t-end').value });
  $$('#t-start,#t-end,#t-date', bar).forEach(i => i.addEventListener('change', () => {
    if (i.classList.contains('hm')) { const t = parseHM(i.value); i.value = t ? `${pad(t[0])}:${pad(t[1])}` : manual[i.id === 't-start' ? 'start' : 'end']; }
    keep(); showDur();
  }));
  $$('.hm', bar).forEach(i => { i.onfocus = () => i.select(); i.onkeydown = e => { if (e.key === 'Enter') i.blur(); }; });
  $('#t-dur').onchange = () => {
    const sec = parseDur($('#t-dur').value);
    if (sec == null || sec > 24 * 3600) { toast('Geef een duur in zoals 1:30 of 1,5 (max. 24 uur).', true); return showDur(); }
    const { s } = times(); $('#t-end').value = hm(new Date(s.getTime() + sec * 1000)); keep(); showDur();
  };
  $('#t-dur').onkeydown = e => { if (e.key === 'Enter') e.target.blur(); };
  $('#t-add').onclick = addManual;
  showDur();

  async function addManual() {
    const { s, e } = times();
    if (e - s < 60000) return toast('Geef een start- en eindtijd in.', true);
    const { error } = await sb.from('time_entries').insert({
      user_id: S.me.id, description: desc.value.trim(), project_id: cur.project_id || null, billable: bill.classList.contains('on'),
      start_at: s.toISOString(), end_at: e.toISOString(), ...tagField(draft.tag_ids)
    });
    if (error) return fail(error);
    draft = { description: '', project_id: '', billable: true, tag_ids: [] };
    manual = { date: manual.date, start: hm(e), end: hm(e) };
    toast('Registratie toegevoegd'); renderTimer(); refreshPage();
  }
}

async function startTimer(fromEntry = null) {
  try {
    if (S.running) await stopTimer(true);
    const src = fromEntry || { description: $('#t-desc')?.value.trim() || '', project_id: draft.project_id || null, billable: $('#t-bill')?.classList.contains('on') ?? true, tag_ids: draft.tag_ids };
    const { data, error } = await sb.from('time_entries').insert({
      user_id: S.me.id, description: src.description || '', project_id: src.project_id || null,
      billable: !!src.billable, start_at: new Date().toISOString(), ...tagField(src.tag_ids)
    }).select().single();
    if (error) throw error;
    S.running = data; draft = { description: '', project_id: '', billable: true, tag_ids: [] };
    if (trkMode === 'manual') { trkMode = 'timer'; try { localStorage.setItem('polyfy-mode', 'timer'); } catch (_) {} }
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
  if (!silent) { renderTimer(); refreshPage(); }
}

// ---------- Uitklapmenu (één tegelijk; voor keuzelijsten, export, ⋮) ----------
function closeMenu() { $('#menu')?.remove(); }
function openMenu(anchor, html, bind, cls = '') {
  if ($('#menu')?.anchor === anchor) return closeMenu();
  closeMenu(); closeTagPop();
  const m = document.createElement('div');
  m.className = 'menu ' + cls; m.id = 'menu'; m.anchor = anchor; m.innerHTML = html;
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8)) + 'px';
  m.style.top = (r.bottom + m.offsetHeight + 8 > innerHeight ? Math.max(8, r.top - m.offsetHeight - 4) : r.bottom + 4) + 'px';
  bind(m);
  $('input:not([type=date])', m)?.focus();
  return m;
}
document.addEventListener('mousedown', e => { const m = $('#menu'); if (m && !m.contains(e.target) && !m.anchor.contains(e.target)) closeMenu(); });
addEventListener('scroll', e => { if (!e.target.closest?.('#menu')) closeMenu(); }, true);

// Keuzelijst met zoekveld. items: [{ id, label, dot?, group? }]; id '' = "alle"/"geen".
function pickFrom(anchor, items, current, onPick, { placeholder = 'Zoeken…', emptyLabel = null, cls = '' } = {}) {
  openMenu(anchor, `<input placeholder="${esc(placeholder)}" aria-label="Zoeken"><div class="list"></div>`, m => {
    const inp = $('input', m), list = $('.list', m);
    const draw = () => {
      const q = inp.value.trim().toLowerCase();
      const hits = items.filter(x => !q || (x.label + ' ' + (x.group || '')).toLowerCase().includes(q));
      let html = emptyLabel && !q ? `<button class="mi ${!current ? 'on' : ''}" data-v="">${esc(emptyLabel)}</button>` : '', grp = null;
      for (const x of hits) {
        if (x.group !== undefined && x.group !== grp) { grp = x.group; html += `<div class="mh">${esc(grp)}</div>`; }
        html += `<button class="mi ${x.id === current ? 'on' : ''}" data-v="${esc(x.id)}">${x.dot ? `<span class="dot" style="background:${esc(x.dot)}"></span>` : ''}${esc(x.label)}${x.extra ? ` <span class="muted">${esc(x.extra)}</span>` : ''}</button>`;
      }
      list.innerHTML = html || '<div class="muted small" style="padding:6px 8px">Niets gevonden.</div>';
      $$('[data-v]', list).forEach(b => b.onclick = () => { closeMenu(); onPick(b.dataset.v || null); });
    };
    inp.oninput = draw; draw();
  }, cls);
}
// Project kiezen, gegroepeerd per klant (zoals Clockify)
function pickProject(anchor, current, onPick, { emptyLabel = 'Geen project', includeArchived = false } = {}) {
  const items = S.projects.filter(p => includeArchived || !p.archived || p.id === current)
    .map(p => ({ id: p.id, label: p.name, dot: p.color, group: clientOf(p)?.name || 'Zonder klant', extra: p.archived ? '(gearchiveerd)' : '' }))
    .sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label));
  pickFrom(anchor, items, current, onPick, { placeholder: 'Zoek project of klant…', emptyLabel, cls: 'wide' });
}

// ---------- Periodekiezer (zoals "This week" met vorige/volgende) ----------
const RANGES = [['today', 'Vandaag'], ['yesterday', 'Gisteren'], ['week', 'Deze week'], ['lastweek', 'Vorige week'], ['month', 'Deze maand'], ['lastmonth', 'Vorige maand'], ['year', 'Dit jaar'], ['lastyear', 'Vorig jaar']];
// [van, tot (exclusief)]
function rangeOf(k) {
  const now = new Date(), t = startOfDay(now), wk = startOfWeek(now), mo = startOfMonth(now), y = now.getFullYear(), m = now.getMonth();
  return { today: [t, addDays(t, 1)], yesterday: [addDays(t, -1), t], week: [wk, addDays(wk, 7)], lastweek: [addDays(wk, -7), wk],
    month: [mo, new Date(y, m + 1, 1)], lastmonth: [new Date(y, m - 1, 1), mo], year: [new Date(y, 0, 1), new Date(y + 1, 0, 1)], lastyear: [new Date(y - 1, 0, 1), new Date(y, 0, 1)] }[k];
}
function rangeLabel(a, b) {
  for (const [k, l] of RANGES) { const [x, y] = rangeOf(k); if (+x === +a && +y === +b) return l; }
  const last = addDays(b, -1);
  return sameDay(a, last) ? fmtDate(a, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
    : `${fmtDate(a, { day: 'numeric', month: 'short' })} – ${fmtDate(last, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}
// Hele maanden/jaren verschuiven per maand, anders per lengte van de periode
function shiftRange(a, b, dir) {
  if (a.getDate() === 1 && b.getDate() === 1) {
    const n = (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth();
    return [new Date(a.getFullYear(), a.getMonth() + dir * n, 1), new Date(b.getFullYear(), b.getMonth() + dir * n, 1)];
  }
  const n = Math.round((b - a) / DAY_MS);
  return [addDays(a, dir * n), addDays(b, dir * n)];
}
const rangeHtml = (a, b) => `<div class="range"><button class="btn rlbl" data-r="pick">${icon('cal')}<span>${esc(rangeLabel(a, b))}</span></button><button class="btn icon" data-r="-1" aria-label="Vorige periode">${icon('left')}</button><button class="btn icon" data-r="1" aria-label="Volgende periode">${icon('right')}</button></div>`;
function bindRange(root, a, b, set) {
  $$('.range [data-r]', root).forEach(btn => btn.onclick = () => {
    if (btn.dataset.r !== 'pick') return set(...shiftRange(a, b, Number(btn.dataset.r)));
    openMenu(btn, `${RANGES.map(([k, l]) => `<button class="mi" data-k="${k}">${l}</button>`).join('')}
      <div class="mh">Aangepast</div>
      <div class="row" style="padding:2px 8px;flex-wrap:nowrap"><input type="date" id="rg-a" value="${ymd(a)}" aria-label="Van"><input type="date" id="rg-b" value="${ymd(addDays(b, -1))}" aria-label="Tot"></div>
      <div style="padding:6px 8px"><button class="btn primary" id="rg-ok" style="width:100%">Toepassen</button></div>`, m => {
      $$('[data-k]', m).forEach(x => x.onclick = () => { closeMenu(); set(...rangeOf(x.dataset.k)); });
      $('#rg-ok', m).onclick = () => {
        const p = $('#rg-a', m).value, q = $('#rg-b', m).value; if (!p || !q) return;
        const [x, y] = [parseYmd(p), parseYmd(q)].sort((u, v) => u - v);
        closeMenu(); set(x, addDays(y, 1));
      };
    });
  });
}

// ---------- Tag-kiezer (knop + uitklapmenu met zoeken/aanmaken) ----------
function tagBtnHtml(ids) {
  const n = tagNames(ids);
  return `${icon('tag')}<span class="${n.length ? '' : 'hide-sm'}">${n.length ? esc(n.slice(0, 2).join(', ')) + (n.length > 2 ? ` +${n.length - 2}` : '') : 'Tags'}</span>`;
}
function bindTagPicker(btn, getIds, onChange) {
  btn.classList.toggle('on', getIds().length > 0);
  btn.onclick = ev => {
    ev.preventDefault();
    if ($('#tagpop')?.anchor === btn) return closeTagPop();
    openTagPop(btn, getIds(), ids => { btn.innerHTML = tagBtnHtml(ids); btn.classList.toggle('on', ids.length > 0); onChange(ids); });
  };
}
function closeTagPop() { $('#tagpop')?.remove(); }
function openTagPop(anchor, ids, onChange) {
  closeTagPop(); closeMenu();
  let sel = [...ids];
  const pop = document.createElement('div');
  pop.className = 'tagpop'; pop.id = 'tagpop'; pop.anchor = anchor;
  pop.innerHTML = '<input placeholder="Zoek of maak een tag…" aria-label="Tag zoeken"><div class="list"></div>';
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8)) + 'px';
  pop.style.top = (r.bottom + pop.offsetHeight + 8 > innerHeight ? Math.max(8, r.top - pop.offsetHeight - 4) : r.bottom + 4) + 'px';
  const inp = $('input', pop), list = $('.list', pop);
  const set = next => { sel = next; onChange(sel); draw(); };
  const create = async () => {
    const name = inp.value.trim(); if (!name) return;
    const { data, error } = await sb.from('tags').insert({ name }).select().single();
    if (error) return fail(error);
    S.tags.push(data); S.tags.sort(byName); inp.value = ''; set([...sel, data.id]);
  };
  const draw = () => {
    const q = inp.value.trim().toLowerCase();
    const tags = S.tags.filter(t => (!t.archived || sel.includes(t.id)) && t.name.toLowerCase().includes(q));
    list.innerHTML = tags.map(t => `<label class="check"><input type="checkbox" value="${t.id}" ${sel.includes(t.id) ? 'checked' : ''}>${esc(t.name)}</label>`).join('')
      + (q && !S.tags.some(t => t.name.toLowerCase() === q) ? `<button type="button" class="btn ghost" data-new>${icon('plus')}Tag "${esc(inp.value.trim())}" maken</button>` : '')
      + (!tags.length && !q ? '<div class="muted small">Nog geen tags. Typ om er een te maken.</div>' : '');
    $$('input[type=checkbox]', list).forEach(c => c.onchange = () => set(c.checked ? [...sel, c.value] : sel.filter(x => x !== c.value)));
    const nb = $('[data-new]', list); if (nb) nb.onclick = create;
  };
  inp.oninput = draw;
  inp.onkeydown = e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const t = S.tags.find(t => t.name.toLowerCase() === inp.value.trim().toLowerCase());
    if (!t) return create();
    inp.value = ''; set(sel.includes(t.id) ? sel : [...sel, t.id]);
  };
  draw(); inp.focus();
}
document.addEventListener('mousedown', e => { const p = $('#tagpop'); if (p && !p.contains(e.target) && !p.anchor.contains(e.target)) closeTagPop(); });
addEventListener('scroll', e => { if (!e.target.closest?.('#tagpop')) closeTagPop(); }, true);

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
function closeModal() { closeTagPop(); closeMenu(); $('#modal')?.remove(); }
document.addEventListener('keydown', e => { if (e.key !== 'Escape') return; if ($('#menu')) closeMenu(); else if ($('#tagpop')) closeTagPop(); else closeModal(); });

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
  let tagIds = [...(e.tag_ids || preset.tag_ids || [])];
  const m = openModal(entry ? 'Registratie bewerken' : 'Registratie toevoegen', `
    <label class="field">Omschrijving<input id="m-desc" value="${esc(e.description)}" placeholder="Waar werkte je aan?"></label>
    <label class="field">Project<select id="m-proj">${projectOptions(e.project_id || '')}</select></label>
    ${S.tagsReady ? `<div class="field">Tags<button type="button" class="btn tagbtn" id="m-tags" style="justify-content:flex-start">${tagBtnHtml(tagIds)}</button></div>` : ''}
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
  if (S.tagsReady) bindTagPicker($('#m-tags'), () => tagIds, ids => { tagIds = ids; });

  $('#m-save').onclick = async () => {
    const { s, en: x } = times();
    if (x && x - s > 24 * 3600000) return toast('Een registratie kan maximaal 24 uur duren.', true);
    const row = {
      description: $('#m-desc').value.trim(), project_id: $('#m-proj').value || null,
      billable: $('#m-bill').checked, start_at: s.toISOString(), ...tagField(tagIds)
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
      if (d.segs && h > 0.5) {
        // Gestapeld: segmenten van onder naar boven, met een dun wit randje ertussen
        let yb = padT + ih;
        for (const g of d.segs) { const sh = max ? g.value / max * ih : 0; if (sh < 0.3) continue; s += `<rect x="${x}" y="${yb - sh}" width="${bw}" height="${sh}" fill="${esc(g.color)}" stroke="var(--surface)" stroke-width="1"/>`; yb -= sh; }
      } else if (h > 0.5) s += `<path class="bar" fill="var(--bar)" d="M${x},${padT + ih} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${padT + ih} Z"/>`;
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

// Ringgrafiek. rows: [{ name, sec, color }]
function donut(rows, total, size = 220) {
  const R = size / 2 - 18, C = 2 * Math.PI * R, w = 34;
  let off = 0;
  const segs = total ? rows.filter(r => r.sec > 0).map(r => {
    const len = r.sec / total * C, el = `<circle r="${R}" cx="${size / 2}" cy="${size / 2}" fill="none" stroke="${esc(r.color)}" stroke-width="${w}"
      stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 ${size / 2} ${size / 2})" data-tip="<b>${esc(r.name)}</b><br>${fmtHMS(r.sec)} · ${Math.round(r.sec / total * 1000) / 10}%"/>`;
    off += len; return el;
  }).join('') : '';
  return `<svg class="donut" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="Verdeling">
    <circle r="${R}" cx="${size / 2}" cy="${size / 2}" fill="none" stroke="var(--grid)" stroke-width="${w}"/>${segs}
    <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" class="donut-t">${fmtHMS(total)}</text></svg>`;
}

// Kleur per groep: projecten hun eigen kleur, andere groepen uit de vaste lijst
const groupColor = (group, k, i) => group === 'project' ? (byId(S.projects, k)?.color || NO_PROJECT_COLOR) : k ? PROJECT_COLORS[i % PROJECT_COLORS.length] : NO_PROJECT_COLOR;

// Emmers voor grafieken: per dag (≤ 31 dagen), per week (≤ 120) of per maand
function buckets(from, to) {
  const days = Math.round((to - from) / DAY_MS), out = [];
  if (days <= 31) for (let i = 0; i < days; i++) { const d = addDays(from, i); out.push({ a: d, b: addDays(d, 1), label: days <= 7 ? fmtDate(d, { weekday: 'short', day: 'numeric', month: 'short' }) : String(d.getDate()), tip: fmtDate(d, { weekday: 'long', day: 'numeric', month: 'long' }) }); }
  else if (days <= 120) for (let d = startOfWeek(from); d < to; d = addDays(d, 7)) out.push({ a: new Date(Math.max(d, from)), b: new Date(Math.min(addDays(d, 7), to)), label: `W${weekNumber(d)}`, tip: `Week ${weekNumber(d)} (${fmtDate(d, { day: 'numeric', month: 'short' })})` });
  else for (let d = startOfMonth(from); d < to; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) out.push({ a: new Date(Math.max(d, from)), b: new Date(Math.min(new Date(d.getFullYear(), d.getMonth() + 1, 1), to)), label: fmtDate(d, { month: 'short' }), tip: fmtDate(d, { month: 'long', year: 'numeric' }) });
  return out;
}

// =====================================================================
// Time Tracker (zoals Clockify: timer/manueel bovenaan, registraties per week en dag)
// =====================================================================
// "7:30", "7:30:00", "7,5", "7.5" of "7" -> seconden; leeg = 0; ongeldig = null
function parseDur(v) {
  v = String(v).trim();
  if (!v) return 0;
  let m = v.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0);
  m = v.match(/^\d+([.,]\d+)?$/);
  return m ? Math.round(Number(v.replace(',', '.')) * 60) * 60 : null;
}

async function renderTracker(page) {
  const today = startOfDay(new Date()), wk0 = startOfWeek(today);
  const weeks = S.trk.weeks, from = addDays(wk0, -7 * (weeks - 1));
  const entries = await fetchEntries({ from, to: addDays(today, 1), userId: S.me.id });
  if (S.view !== 'tracker') return;
  // Gelijke registraties op dezelfde dag worden gegroepeerd (zoals Clockify)
  const gkey = e => [ymd(entryStart(e)), e.description.trim().toLowerCase(), e.project_id || '', [...(e.tag_ids || [])].sort().join(','), e.billable].join('|');
  const groups = new Map();
  for (const e of [...entries].sort((x, y) => entryStart(y) - entryStart(x))) {
    const k = gkey(e); if (!groups.has(k)) groups.set(k, { key: k, items: [] }); groups.get(k).items.push(e);
  }
  const blocks = [];
  for (let i = 0; i < weeks; i++) {
    const a = addDays(wk0, -7 * i), b = addDays(a, 7);
    const wkEntries = entries.filter(e => entryStart(e) >= a && entryStart(e) < b);
    if (!wkEntries.length) continue;
    const label = i === 0 ? 'Deze week' : i === 1 ? 'Vorige week' : `${fmtDate(a, { day: 'numeric', month: 'short' })} – ${fmtDate(addDays(a, 6), { day: 'numeric', month: 'short' })}`;
    let html = `<div class="wk-head"><span>${esc(label)}</span><span class="muted small">Weektotaal: <b class="wk-tot num">${fmtHMS(wkEntries.reduce((t, e) => t + entrySec(e), 0))}</b></span></div>`;
    for (let d = 6; d >= 0; d--) {
      const day = addDays(a, d), dayGroups = [...groups.values()].filter(g => sameDay(entryStart(g.items[0]), day));
      if (!dayGroups.length) continue;
      const dayTot = dayGroups.reduce((t, g) => t + g.items.reduce((u, e) => u + entrySec(e), 0), 0);
      html += `<div class="card tday"><div class="tday-head"><span>${esc(fmtDayLong(day))}</span><span class="muted small">Totaal: <b class="num">${fmtHMS(dayTot)}</b></span></div>
        ${dayGroups.map(g => trackRow(g) + (g.items.length > 1 && S.trk.open.has(g.key) ? g.items.map(e => trackRow({ key: g.key, items: [e] }, true)).join('') : '')).join('')}</div>`;
    }
    blocks.push(html);
  }
  page.innerHTML = `
    <div class="timerbar card" id="timerbar"></div>
    ${blocks.join('') || '<div class="card empty">Nog geen registraties. Start de timer of voeg manueel uren toe.</div>'}
    <div class="row" style="justify-content:center"><button class="btn" id="trk-more">Oudere registraties tonen</button></div>`;
  renderTimer();
  bindTrackRows(page, groups, entries);
  $('#trk-more').onclick = () => { S.trk.weeks += 4; refreshPage(); };
}

function trackRow(g, child = false) {
  const e = g.items[0], multi = g.items.length > 1 && !child, running = !e.end_at;
  const sec = g.items.reduce((t, x) => t + entrySec(x), 0);
  const first = new Date(Math.min(...g.items.map(entryStart))), last = new Date(Math.max(...g.items.map(entryEnd)));
  const tags = tagNames(e.tag_ids);
  return `<div class="te ${child ? 'child' : ''}" data-g="${esc(g.key)}" ${multi ? '' : `data-id="${e.id}"`}>
    <span class="te-cnt">${multi ? `<button class="cnt ${S.trk.open.has(g.key) ? 'on' : ''}" data-act="toggle" title="${g.items.length} registraties">${g.items.length}</button>` : ''}</span>
    <input class="te-desc" data-act="desc" value="${esc(e.description)}" placeholder="Omschrijving toevoegen" aria-label="Omschrijving">
    <button class="te-proj" data-act="proj">${projBtnHtml(e.project_id)}</button>
    ${S.tagsReady ? `<button class="te-tags ${tags.length ? 'on' : ''}" data-act="tags" title="Tags">${tags.length ? tags.map(t => `<span class="tag t-blue">${esc(t)}</span>`).join('') : icon('tag')}</button>` : ''}
    <button class="te-bill ${e.billable ? 'on' : ''}" data-act="bill" title="Factureerbaar">€</button>
    <span class="te-times num">${multi ? `<span class="muted">${hm(first)} – ${e.end_at ? hm(last) : 'nu'}</span>`
      : `<input class="num" data-act="start" value="${hm(entryStart(e))}" aria-label="Start" inputmode="numeric"><span class="muted">–</span>${running ? '<span class="muted">nu</span>' : `<input class="num" data-act="end" value="${hm(entryEnd(e))}" aria-label="Einde" inputmode="numeric">`}`}</span>
    ${multi ? '<span class="te-ico"></span>' : `<button class="btn icon ghost te-ico" data-act="date" title="Datum wijzigen" aria-label="Datum wijzigen">${icon('cal')}</button>`}
    <span class="te-dur num">${running && !multi ? '<span class="tag live">loopt</span>' : fmtHMS(sec)}</span>
    <button class="btn icon ghost" data-act="play" title="Opnieuw starten" aria-label="Opnieuw starten">${icon('play')}</button>
    <button class="btn icon ghost" data-act="more" title="Meer" aria-label="Meer">${icon('dots')}</button>
  </div>`;
}

function bindTrackRows(root, groups, entries) {
  $$('.te', root).forEach(row => {
    const g = groups.get(row.dataset.g); if (!g) return;
    const items = row.dataset.id ? g.items.filter(e => e.id === row.dataset.id) : g.items, e = items[0];
    const ids = items.map(x => x.id);
    const save = async patch => {
      const { error } = await sb.from('time_entries').update(patch).in('id', ids);
      if (error) return fail(error);
      if (S.running && ids.includes(S.running.id)) Object.assign(S.running, patch);
      refreshPage();
    };
    $$('[data-act]', row).forEach(el => {
      const act = el.dataset.act;
      if (act === 'toggle') el.onclick = () => { S.trk.open.has(g.key) ? S.trk.open.delete(g.key) : S.trk.open.add(g.key); refreshPage(); };
      if (act === 'desc') { el.onchange = () => save({ description: el.value.trim() }); el.onkeydown = ev => { if (ev.key === 'Enter') el.blur(); }; }
      if (act === 'proj') el.onclick = () => pickProject(el, e.project_id, pid => { const p = byId(S.projects, pid); save({ project_id: pid, ...(p ? { billable: p.billable } : {}) }); });
      if (act === 'tags') bindTagPicker(el, () => e.tag_ids || [], ids2 => { e.tag_ids = ids2; clearTimeout(el._t); el._t = setTimeout(() => save({ tag_ids: ids2 }), 600); });
      if (act === 'bill') el.onclick = () => save({ billable: !e.billable });
      if (act === 'start' || act === 'end') { el.onfocus = () => el.select(); el.onkeydown = ev => { if (ev.key === 'Enter') el.blur(); }; }
      if (act === 'start' || act === 'end') el.onchange = () => {
        const t = parseHM(el.value); if (!t) { toast('Geef een tijd in zoals 9:30 of 0930.', true); return refreshPage(); }
        const [h, m] = t;
        const base = startOfDay(entryStart(e)), s = act === 'start' ? new Date(base.setHours(h, m)) : entryStart(e);
        let en = act === 'end' ? new Date(new Date(startOfDay(entryStart(e))).setHours(h, m)) : e.end_at ? entryEnd(e) : null;
        if (en && en <= s) en = addDays(en, 1);
        if (en && en - s > 24 * 3600000) { toast('Een registratie kan maximaal 24 uur duren.', true); return refreshPage(); }
        save({ start_at: s.toISOString(), ...(en ? { end_at: en.toISOString() } : {}) });
      };
      if (act === 'date') el.onclick = () => openMenu(el, `<div style="padding:6px 8px"><input type="date" value="${ymd(entryStart(e))}" aria-label="Datum"></div>`, m => {
        $('input', m).onchange = ev => {
          const d = parseYmd(ev.target.value), shift = startOfDay(d) - startOfDay(entryStart(e));
          closeMenu(); save({ start_at: new Date(entryStart(e).getTime() + shift).toISOString(), ...(e.end_at ? { end_at: new Date(entryEnd(e).getTime() + shift).toISOString() } : {}) });
        };
      });
      if (act === 'play') el.onclick = () => startTimer(e);
      if (act === 'more') el.onclick = () => openMenu(el, items.length > 1
        ? `<button class="mi" data-m="open">${S.trk.open.has(g.key) ? 'Inklappen' : 'Uitklappen'}</button><button class="mi danger" data-m="del">Alle ${items.length} verwijderen</button>`
        : `<button class="mi" data-m="edit">Bewerken</button><button class="mi" data-m="dup">Dupliceren</button><button class="mi danger" data-m="del">Verwijderen</button>`, m => {
        $$('[data-m]', m).forEach(x => x.onclick = async () => {
          closeMenu();
          if (x.dataset.m === 'open') { S.trk.open.has(g.key) ? S.trk.open.delete(g.key) : S.trk.open.add(g.key); return refreshPage(); }
          if (x.dataset.m === 'edit') return openEntryModal(e);
          if (x.dataset.m === 'dup') {
            if (!e.end_at) return toast('Een lopende timer kan je niet dupliceren.', true);
            const { error } = await sb.from('time_entries').insert({ user_id: e.user_id, description: e.description, project_id: e.project_id, billable: e.billable, start_at: e.start_at, end_at: e.end_at, ...tagField(e.tag_ids) });
            if (error) return fail(error);
            toast('Registratie gedupliceerd'); return refreshPage();
          }
          if (!confirm(items.length > 1 ? `Deze ${items.length} registraties verwijderen?` : 'Deze registratie verwijderen?')) return;
          const { error } = await sb.from('time_entries').delete().in('id', ids);
          if (error) return fail(error);
          if (S.running && ids.includes(S.running.id)) { S.running = null; renderTimer(); }
          toast('Verwijderd'); refreshPage();
        });
      });
    });
  });
}

// =====================================================================
// Dashboard (zoals Clockify: totaal, topproject/-klant, staven per dag, ring, top-activiteiten)
// =====================================================================
const DASH_GROUPS = [['project', 'Project'], ['client', 'Klant'], ['tag', 'Tag'], ['user', 'Medewerker']];
async function renderDashboard(page) {
  const D = S.dash;
  if (!D.from) [D.from, D.to] = rangeOf('week');
  const team = isAdmin() && D.who === 'team';
  if (!team && D.group === 'user') D.group = 'project';
  const entries = await fetchEntries({ from: D.from, to: D.to, userId: team ? null : S.me.id });
  if (S.view !== 'dashboard') return;
  const secOf = e => clipSec(e, D.from, D.to);
  const total = entries.reduce((t, e) => t + secOf(e), 0);
  const rows = groupRows(entries, D.group, secOf).map((r, i) => ({ ...r, name: groupText(r, D.group), color: groupColor(D.group, r.k, i) }));
  const topP = groupRows(entries, 'project', secOf)[0], topC = groupRows(entries, 'client', secOf).filter(r => r.k)[0];
  const acts = new Map();
  for (const e of entries) {
    const k = e.description.trim().toLowerCase() + '|' + (e.project_id || '');
    const a = acts.get(k) || { e, sec: 0 }; a.sec += secOf(e); acts.set(k, a);
  }
  const top = [...acts.values()].sort((a, b) => b.sec - a.sec).slice(0, 10);

  page.innerHTML = `
    <div class="page-head"><h1>Dashboard</h1>
      <div class="row">
        <select id="d-group" aria-label="Groeperen op">${DASH_GROUPS.filter(g => team || g[0] !== 'user').map(([k, l]) => `<option value="${k}" ${D.group === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        ${isAdmin() ? `<select id="d-who" aria-label="Wie"><option value="me">Enkel ik</option><option value="team" ${team ? 'selected' : ''}>Team</option></select>` : ''}
        ${rangeHtml(D.from, D.to)}
      </div>
    </div>
    <div class="dash">
      <div class="card">
        <div class="kpis">
          <div><div class="label">Totale tijd</div><div class="v num">${fmtHMS(total)}</div></div>
          <div><div class="label">Topproject</div><div class="v sm">${topP ? esc(groupText(topP, 'project')) : '–'}</div></div>
          <div><div class="label">Topklant</div><div class="v sm">${topC ? esc(groupText(topC, 'client')) : '–'}</div></div>
        </div>
        <div class="card-body"><div class="chart" id="d-chart"></div></div>
        <div class="dash-split">
          <div class="donut-wrap">${donut(rows, total)}</div>
          <div class="dlist">${rows.length ? rows.slice(0, 12).map(r => `
            <div class="drow" data-tip="<b>${esc(r.name)}</b><br>${fmtHMS(r.sec)}">
              <span class="dn">${esc(r.name)}</span><span class="num">${fmtHMS(r.sec)}</span>
              <span class="track"><span style="width:${total ? r.sec / rows[0].sec * 100 : 0}%;background:${esc(r.color)}"></span></span>
              <span class="num muted">${total ? (r.sec / total * 100).toFixed(2).replace('.', ',') : 0}%</span>
            </div>`).join('') : '<div class="empty">Geen uren in deze periode.</div>'}</div>
        </div>
      </div>
      <div class="card side-list">
        <div class="card-head"><h2>Meest geregistreerde activiteiten</h2><span class="muted small">Top 10</span></div>
        ${top.length ? top.map(a => `<div class="act"><div class="desc"><div>${a.e.description ? esc(a.e.description) : '<span class="muted">(geen omschrijving)</span>'}</div><div class="small">${projLabel(projectOf(a.e))}</div></div><span class="num">${fmtHMS(a.sec)}</span></div>`).join('') : '<div class="empty">Nog niets.</div>'}
      </div>
    </div>`;

  // Gestapelde staven per dag/week/maand, gekleurd per groep (top 8, rest grijs)
  const colorOf = new Map(rows.slice(0, 8).map(r => [r.k, r.color]));
  barChart($('#d-chart'), buckets(D.from, D.to).map(k => {
    const per = new Map();
    for (const e of entries) {
      const sec = clipSec(e, k.a, k.b); if (!sec) continue;
      for (const g of groupKeys(e, D.group)) { const c = colorOf.has(g) ? g : '~'; per.set(c, (per.get(c) || 0) + sec); }
    }
    const segs = [...per].map(([g, sec]) => ({ value: sec / 3600, color: colorOf.get(g) || NO_PROJECT_COLOR }));
    const sum = [...per.values()].reduce((a, b) => a + b, 0);
    return { label: k.label, value: sum / 3600, segs, valueLabel: fmtHM(sum), tip: `<b>${esc(k.tip)}</b><br>${fmtHMS(sum)}` };
  }), { showValues: false });

  const set = patch => { Object.assign(D, patch); refreshPage(); };
  $('#d-group').onchange = e => set({ group: e.target.value });
  if ($('#d-who')) $('#d-who').onchange = e => set({ who: e.target.value });
  bindRange(page, D.from, D.to, (from, to) => set({ from, to }));
}

// =====================================================================
// Calendar (week of dag, zoom, collega kiezen)
// =====================================================================
async function renderCalendar(page) {
  const C = S.cal, today = startOfDay(new Date());
  if (!C.from) C.from = startOfWeek(today);
  const nd = C.mode === 'day' ? 1 : 7, from = C.from, to = addDays(from, nd), HP = C.zoom;
  const uid = C.user || S.me.id;
  const entries = await fetchEntries({ from, to, userId: uid });
  if (S.view !== 'calendar') return;
  const daily = perDay(entries, from, nd);
  const who = profileOf(uid);

  page.innerHTML = `
    <div class="page-head">
      <div class="row"><h1>Calendar</h1><div class="seg" id="c-mode"><button data-m="week" class="${nd === 7 ? 'on' : ''}">Week</button><button data-m="day" class="${nd === 1 ? 'on' : ''}">Dag</button></div></div>
      <div class="row">
        <div class="seg" id="c-zoom"><button data-z="-12" aria-label="Uitzoomen" ${HP <= 24 ? 'disabled' : ''}>−</button><button data-z="12" aria-label="Inzoomen" ${HP >= 96 ? 'disabled' : ''}>+</button></div>
        ${isAdmin() ? `<button class="btn" id="c-user">${avatar(who)}<span>${esc(uid === S.me.id ? 'Ik' : who?.full_name || who?.email || '')}</span>${icon('down')}</button>` : ''}
        ${rangeHtml(from, to)}
      </div>
    </div>
    <div class="card cal" style="--cols:${nd}">
      <div class="cal-dayhead" style="border-left:0"></div>
      ${daily.map((sec, i) => { const d = addDays(from, i); return `<div class="cal-dayhead ${sameDay(d, today) ? 'today' : ''}"><div class="dn">${esc(fmtDate(d, { weekday: 'short', day: 'numeric', month: 'short' }))}</div><div class="tot num">${fmtHMS(sec)}</div></div>`; }).join('')}
      <div class="cal-scroll" id="cal-scroll">
        <div class="cal-hours">${Array.from({ length: 24 }, (_, h) => `<div style="height:${HP}px">${h ? pad(h) + ':00' : ''}</div>`).join('')}</div>
        ${daily.map((_, i) => `<div class="cal-col ${sameDay(addDays(from, i), today) ? 'today' : ''}" data-day="${i}" style="height:${24 * HP}px;--hp:${HP}px"></div>`).join('')}
      </div>
    </div>
    <div class="muted small">Klik op een leeg vak om een registratie toe te voegen, klik op een blok om te bewerken.</div>`;

  // Blokken per dag positioneren, met kolommen voor overlappende registraties
  $$('.cal-col', page).forEach(col => {
    const i = Number(col.dataset.day), d0 = addDays(from, i), d1 = addDays(from, i + 1);
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
      const top = (g.s - d0) / 3600000 * HP, h = Math.max(18, (g.t - g.s) / 3600000 * HP - 2), w = 100 / g.ncol;
      return `<div class="cal-ev ${g.e.end_at ? '' : 'running'}" data-id="${g.e.id}" style="top:${top}px;height:${h}px;left:calc(${g.col * w}% + 2px);width:calc(${w}% - 4px);background:color-mix(in srgb, ${color} 18%, var(--surface));border-left:3px solid ${color}"
        data-tip="<b>${esc(g.e.description || '(geen omschrijving)')}</b><br>${esc(p?.name || 'Geen project')}${tagNames(g.e.tag_ids).length ? '<br>' + esc(tagNames(g.e.tag_ids).join(', ')) : ''}<br>${hm(entryStart(g.e))} – ${g.e.end_at ? hm(entryEnd(g.e)) : 'nu'} · ${fmtHMS(entrySec(g.e))}">
        <div class="t">${esc(g.e.description || p?.name || '(geen omschrijving)')}</div>
        ${h > 34 ? `<div class="s">${esc(g.e.description ? p?.name || 'Geen project' : clientOf(p)?.name || '')} · ${fmtHM((g.t - g.s) / 1000)}</div>` : ''}
      </div>`;
    }).join('');
    if (sameDay(d0, today)) {
      const now = new Date();
      col.insertAdjacentHTML('beforeend', `<div class="now-line" style="top:${(now - d0) / 3600000 * HP}px"></div>`);
    }
    col.addEventListener('click', ev => {
      const evEl = ev.target.closest('.cal-ev');
      if (evEl) { openEntryModal(entries.find(x => x.id === evEl.dataset.id)); return; }
      const mins = Math.floor((ev.offsetY / HP) * 60 / 15) * 15;
      const s = new Date(d0); s.setMinutes(mins);
      openEntryModal(null, { start: s.getTime(), end: s.getTime() + 3600000, user_id: uid });
    });
  });

  const sc = $('#cal-scroll');
  const firstHour = entries.length ? Math.min(...entries.map(e => new Date(Math.max(from, entryStart(e))).getHours())) : 8;
  sc.scrollTop = Math.max(0, Math.min(8, firstHour) * HP - 8);

  $$('#c-mode button').forEach(b => b.onclick = () => {
    C.mode = b.dataset.m;
    C.from = C.mode === 'day' ? (today >= from && today < to ? today : from) : startOfWeek(from);
    refreshPage();
  });
  $$('#c-zoom button').forEach(b => b.onclick = () => { C.zoom = Math.min(96, Math.max(24, HP + Number(b.dataset.z))); refreshPage(); });
  bindRange(page, from, to, a => { C.from = C.mode === 'day' ? a : startOfWeek(a); refreshPage(); });
  if ($('#c-user')) $('#c-user').onclick = () => pickFrom($('#c-user'), S.profiles.filter(p => p.active).map(p => ({ id: p.id, label: p.full_name || p.email, extra: p.id === S.me.id ? '(ik)' : '' })), uid,
    v => { C.user = v || S.me.id; refreshPage(); }, { placeholder: 'Zoek collega…' });
}

// =====================================================================
// Reports (Samenvatting / Gedetailleerd / Wekelijks, zoals Clockify)
// =====================================================================
const GROUPS = [['project', 'Project'], ['client', 'Klant'], ['user', 'Medewerker'], ['tag', 'Tag'], ['day', 'Dag'], ['description', 'Omschrijving']];
const TABS = [['summary', 'Samenvatting'], ['detailed', 'Gedetailleerd'], ['weekly', 'Wekelijks']];

async function renderReports(page) {
  const R = S.rep;
  if (!R.from) [R.from, R.to] = rangeOf('week');
  const from = R.from, to = R.to;
  const userId = isAdmin() ? (R.user || null) : S.me.id;
  let entries = await fetchEntries({ from, to, userId, projectId: R.project || null });
  if (S.view !== 'reports') return;
  if (R.client) entries = entries.filter(e => R.client === '__none' ? !projectOf(e)?.client_id : projectOf(e)?.client_id === R.client);
  if (R.tag) entries = entries.filter(e => R.tag === '__none' ? !e.tag_ids?.length : e.tag_ids?.includes(R.tag));
  if (R.desc) entries = entries.filter(e => e.description.toLowerCase().includes(R.desc.toLowerCase()));
  if (!isAdmin()) { if (R.g1 === 'user') R.g1 = 'project'; if (R.g2 === 'user') R.g2 = 'description'; }

  const secOf = e => clipSec(e, from, to);
  const total = entries.reduce((a, e) => a + secOf(e), 0);
  const amount = entries.reduce((a, e) => a + amountFor(e, secOf(e)), 0);
  const groups = GROUPS.filter(g => isAdmin() || g[0] !== 'user').filter(g => S.tagsReady || g[0] !== 'tag');
  const fbtn = (k, label, val) => `<button class="fbtn ${val ? 'on' : ''}" data-f="${k}">${label}${val ? `: <b>${esc(val)}</b>` : ''}${icon('down')}</button>`;
  const nameOfFilter = {
    user: R.user && (profileOf(R.user)?.full_name || ''), client: R.client && (R.client === '__none' ? 'zonder klant' : byId(S.clients, R.client)?.name || ''),
    project: R.project && (byId(S.projects, R.project)?.name || ''), tag: R.tag && (R.tag === '__none' ? 'zonder tag' : byId(S.tags, R.tag)?.name || '')
  };

  page.innerHTML = `
    <div class="page-head">
      <div class="seg" id="r-tab">${TABS.map(([k, l]) => `<button data-t="${k}" class="${R.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="row">${rangeHtml(from, to)}<button class="btn" id="r-exp">${icon('dl')}Exporteren${icon('down')}</button></div>
    </div>
    <div class="card filterbar">
      <span class="flabel">Filter</span>
      ${isAdmin() ? fbtn('user', 'Team', nameOfFilter.user) : ''}
      ${fbtn('client', 'Klant', nameOfFilter.client)}
      ${fbtn('project', 'Project', nameOfFilter.project)}
      ${S.tagsReady ? fbtn('tag', 'Tag', nameOfFilter.tag) : ''}
      <input id="r-desc" placeholder="Omschrijving bevat…" value="${esc(R.desc)}" aria-label="Omschrijving">
      ${R.user || R.client || R.project || R.tag || R.desc ? '<button class="linkbtn" id="r-clear">Filters wissen</button>' : ''}
    </div>
    <div class="card">
      <div class="sumband">
        <span>Totaal: <b class="num">${fmtHMS(total)}</b></span>
        ${amount > 0 ? `<span>Bedrag: <b class="num">${fmtMoney(amount)}</b></span>` : ''}
        <span class="muted small">${entries.length} registraties</span>
      </div>
      <div class="card-body"><div class="chart" id="r-chart"></div></div>
    </div>
    <div class="card" id="r-body"></div>`;

  // Grafiek: één kleur, waarde boven de staaf (zoals Clockify)
  const bk = buckets(from, to);
  barChart($('#r-chart'), bk.map(k => {
    const sec = entries.reduce((t, e) => t + clipSec(e, k.a, k.b), 0);
    return { label: k.label, value: sec / 3600, valueLabel: fmtHMS(sec), tip: `<b>${esc(k.tip)}</b><br>${fmtHMS(sec)}` };
  }), { showValues: bk.length <= 14 });

  const body = $('#r-body');
  if (R.tab === 'summary') {
    const rows = groupRows(entries, R.g1, secOf).map((r, i) => ({ ...r, color: groupColor(R.g1, r.k, i) }));
    const sub = r => R.g2 ? groupRows(entries.filter(e => groupKeys(e, R.g1).includes(r.k)), R.g2, secOf) : [];
    const name = (r, g) => g === 'project' ? projLabel(byId(S.projects, r.k)) : g === 'user' && profileOf(r.k) ? `<span class="row" style="flex-wrap:nowrap">${avatar(profileOf(r.k))}${esc(profileOf(r.k).full_name)}</span>` : esc(groupText(r, g));
    body.innerHTML = `
      <div class="card-head"><div class="row small"><span class="muted">Groeperen op</span>
        <select id="r-g1" aria-label="Groeperen op">${groups.map(([k, l]) => `<option value="${k}" ${R.g1 === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select id="r-g2" aria-label="Daarna op"><option value="">(geen)</option>${groups.filter(g => g[0] !== R.g1).map(([k, l]) => `<option value="${k}" ${R.g2 === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
      ${rows.length ? `<div class="sum-split"><div class="table-wrap"><table class="tree"><thead><tr><th>Titel</th><th class="r">Duur</th>${amount > 0 ? '<th class="r">Bedrag</th>' : ''}<th class="r" style="width:70px">%</th></tr></thead><tbody>
        ${rows.map(r => {
          const kids = sub(r), open = R.open.has(r.k);
          return `<tr class="g1"><td>${kids.length ? `<button class="cnt ${open ? 'on' : ''}" data-open="${esc(r.k)}">${kids.length}</button>` : ''}${name(r, R.g1)}</td><td class="r num"><b>${fmtHMS(r.sec)}</b></td>${amount > 0 ? `<td class="r num">${fmtMoney(r.amt)}</td>` : ''}<td class="r num muted">${total ? Math.round(r.sec / total * 100) : 0}%</td></tr>`
            + (open ? kids.map(c => `<tr class="g2"><td>${name(c, R.g2)}</td><td class="r num">${fmtHMS(c.sec)}</td>${amount > 0 ? `<td class="r num">${fmtMoney(c.amt)}</td>` : ''}<td></td></tr>`).join('') : '');
        }).join('')}</tbody></table>
        ${R.g1 === 'tag' || R.g2 === 'tag' ? '<div class="muted small" style="padding:10px 16px">Registraties met meerdere tags tellen bij elke tag mee.</div>' : ''}</div>
        <div class="donut-wrap">${donut(rows.map(r => ({ name: groupText(r, R.g1), sec: r.sec, color: r.color })), total)}</div></div>`
      : '<div class="empty">Geen registraties voor deze filters.</div>'}`;
    $('#r-g1').onchange = e => set({ g1: e.target.value, g2: R.g2 === e.target.value ? '' : R.g2, open: new Set() });
    $('#r-g2').onchange = e => set({ g2: e.target.value });
    $$('[data-open]', body).forEach(b => b.onclick = () => { const k = b.dataset.open; R.open.has(k) ? R.open.delete(k) : R.open.add(k); refreshPage(); });
  } else if (R.tab === 'detailed') {
    const sorted = [...entries].sort((a, b) => entryStart(b) - entryStart(a));
    body.innerHTML = sorted.length ? `<div class="table-wrap"><table><thead><tr><th>Registratie</th>${isAdmin() ? '<th>Medewerker</th>' : ''}<th>Datum</th><th>Tijd</th><th class="r">Duur</th><th></th></tr></thead><tbody>
      ${sorted.map(e => `<tr data-id="${e.id}"><td>${e.description ? esc(e.description) : '<span class="muted">(geen omschrijving)</span>'}${tagChips(e.tag_ids)}<div class="small">${projLabel(projectOf(e))}</div></td>
        ${isAdmin() ? `<td>${esc(entryUserName(e))}</td>` : ''}
        <td class="num">${esc(fmtDate(entryStart(e), { day: '2-digit', month: '2-digit', year: 'numeric' }))}</td>
        <td class="num muted">${hm(entryStart(e))} – ${e.end_at ? hm(entryEnd(e)) : 'nu'}</td><td class="r num"><b>${fmtHMS(entrySec(e))}</b></td>
        <td class="r"><button class="btn icon ghost" data-edit aria-label="Bewerken">${icon('edit')}</button></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">Geen registraties voor deze filters.</div>';
    $$('[data-edit]', body).forEach(b => b.onclick = () => openEntryModal(entries.find(x => x.id === b.closest('tr').dataset.id)));
  } else {
    // Wekelijks: rijen per groep, kolommen per dag/week/maand (zelfde indeling als de grafiek)
    const cols = bk;
    const rows = groupRows(entries, R.g1, secOf);
    const cell = (r, c) => entries.filter(e => groupKeys(e, R.g1).includes(r.k)).reduce((t, e) => t + clipSec(e, c.a, c.b), 0);
    body.innerHTML = `
      <div class="card-head"><div class="row small"><span class="muted">Rijen per</span><select id="r-g1" aria-label="Rijen per">${groups.filter(g => g[0] !== 'day').map(([k, l]) => `<option value="${k}" ${R.g1 === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
      ${rows.length ? `<div class="table-wrap"><table class="weekly"><thead><tr><th>${GROUPS.find(g => g[0] === R.g1)[1]}</th>${cols.map(c => `<th class="r">${esc(c.label)}</th>`).join('')}<th class="r">Totaal</th></tr></thead><tbody>
        ${rows.map(r => `<tr><td>${R.g1 === 'project' ? projLabel(byId(S.projects, r.k)) : esc(groupText(r, R.g1))}</td>${cols.map(c => { const v = cell(r, c); return `<td class="r num ${v ? '' : 'muted'}">${v ? fmtHM(v) : '–'}</td>`; }).join('')}<td class="r num"><b>${fmtHM(r.sec)}</b></td></tr>`).join('')}
      </tbody><tfoot><tr><th>Totaal</th>${cols.map(c => `<th class="r num">${fmtHM(entries.reduce((t, e) => t + clipSec(e, c.a, c.b), 0))}</th>`).join('')}<th class="r num">${fmtHM(total)}</th></tr></tfoot></table></div>`
      : '<div class="empty">Geen registraties voor deze filters.</div>'}`;
    $('#r-g1').onchange = e => set({ g1: e.target.value === 'day' ? 'project' : e.target.value });
  }

  function set(patch) { Object.assign(R, patch); refreshPage(); }
  $$('#r-tab button').forEach(b => b.onclick = () => set({ tab: b.dataset.t }));
  bindRange(page, from, to, (a, b) => set({ from: a, to: b }));
  const desc = $('#r-desc');
  desc.oninput = debounce(() => { R.desc = desc.value.trim(); refreshPage(); setTimeout(() => { const d = $('#r-desc'); d?.focus(); d?.setSelectionRange(d.value.length, d.value.length); }); }, 400);
  if ($('#r-clear')) $('#r-clear').onclick = () => set({ user: '', client: '', project: '', tag: '', desc: '' });
  $$('[data-f]', page).forEach(b => b.onclick = () => {
    const f = b.dataset.f, pick = v => set({ [f]: v || '' });
    if (f === 'project') return pickProject(b, R.project, pick, { emptyLabel: 'Alle projecten', includeArchived: true });
    const items = f === 'user' ? S.profiles.map(p => ({ id: p.id, label: p.full_name || p.email }))
      : f === 'client' ? [{ id: '__none', label: 'Zonder klant' }, ...S.clients.map(c => ({ id: c.id, label: c.name }))]
      : [{ id: '__none', label: 'Zonder tag' }, ...S.tags.map(t => ({ id: t.id, label: t.name }))];
    pickFrom(b, items, R[f], pick, { emptyLabel: f === 'user' ? 'Iedereen' : f === 'client' ? 'Alle klanten' : 'Alle tags' });
  });
  $('#r-exp').onclick = () => openMenu($('#r-exp'), `<button class="mi" data-x="pdf">${icon('pdf')}Opslaan als PDF</button><button class="mi" data-x="csv">${icon('dl')}Opslaan als CSV (Excel)</button>`, m => {
    $$('[data-x]', m).forEach(x => x.onclick = async () => {
      closeMenu();
      if (x.dataset.x === 'csv') return exportCsv(entries, from, to);
      try { await exportPdf(entries, from, to); } catch (err) { fail(err); }
    });
  });
}

// Samenvatting: rijen per groep. Per tag telt een registratie met meerdere tags bij elke tag mee.
function groupKeys(e, group) {
  return {
    project: () => [e.project_id || ''], user: () => [e.user_id || 'imp:' + lc(e.import_email)], client: () => [projectOf(e)?.client_id || ''],
    tag: () => e.tag_ids?.length ? e.tag_ids : [''],
    day: () => [ymd(entryStart(e))], description: () => [e.description.trim().toLowerCase()]
  }[group]();
}
function groupRows(entries, group, secOf) {
  const g = new Map();
  for (const e of entries) for (const k of groupKeys(e, group)) {
    const row = g.get(k) || { k, sample: e, sec: 0, bill: 0, amt: 0, n: 0 };
    const s = secOf(e);
    row.sec += s; row.bill += e.billable ? s : 0; row.amt += amountFor(e, s); row.n++;
    g.set(k, row);
  }
  return [...g.values()].sort((a, b) => group === 'day' ? a.k.localeCompare(b.k) : b.sec - a.sec);
}
// Naam van een groep als platte tekst (voor PDF)
function groupText(r, group) {
  if (group === 'project') { const p = byId(S.projects, r.k); return p ? p.name : 'Geen project'; }
  if (group === 'user') return profileOf(r.k)?.full_name || entryUserName(r.sample) || 'Onbekend';
  if (group === 'client') return byId(S.clients, r.k)?.name || 'Zonder klant';
  if (group === 'tag') return r.k ? byId(S.tags, r.k)?.name || 'Onbekende tag' : 'Zonder tag';
  if (group === 'day') return fmtDate(parseYmd(r.k), { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  return r.sample.description || '(geen omschrijving)';
}

const loadScript = src => new Promise((res, rej) => {
  if ([...document.scripts].some(x => x.src === src)) return res();
  const el = document.createElement('script');
  el.src = src; el.onload = res; el.onerror = () => rej(new Error('PDF-module kon niet geladen worden. Controleer je internetverbinding.'));
  document.head.appendChild(el);
});

// PDF met samenvatting (huidige groepering) en gedetailleerde lijst. jsPDF wordt pas geladen bij de eerste export.
async function exportPdf(entries, from, to) {
  await loadScript('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js');
  await loadScript('https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js');
  const R = S.rep, doc = new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const secOf = e => clipSec(e, from, to);
  const total = entries.reduce((a, e) => a + secOf(e), 0);
  const groupLabel = GROUPS.find(x => x[0] === R.g1)[1];
  const filters = [
    R.desc && `Omschrijving bevat: ${R.desc}`,
    R.user && `Medewerker: ${profileOf(R.user)?.full_name || ''}`, R.client && `Klant: ${byId(S.clients, R.client)?.name || ''}`,
    R.project && `Project: ${byId(S.projects, R.project)?.name || ''}`,
    R.tag && `Tag: ${R.tag === '__none' ? 'zonder tag' : byId(S.tags, R.tag)?.name || ''}`
  ].filter(Boolean);
  const d = x => fmtDate(x, { day: 'numeric', month: 'long', year: 'numeric' });
  const style = { fontSize: 9, cellPadding: 1.6 }, head = { fillColor: [42, 120, 214] };

  doc.setFontSize(16); doc.text('Polyfy - rapport', 14, 16);
  doc.setFontSize(10); doc.setTextColor(90);
  doc.text(`${d(from)} - ${d(addDays(to, -1))}${filters.length ? '   |   ' + filters.join('   |   ') : ''}`, 14, 23);
  doc.text(`Totaal ${fmtHM(total)} u (${fmtDec(total)} uur)   |   ${entries.length} registraties   |   gemaakt op ${d(new Date())}`, 14, 29);
  doc.setTextColor(0);

  doc.autoTable({
    startY: 35, head: [[`Per ${groupLabel.toLowerCase()}`, 'Uren', 'Aandeel']], styles: style, headStyles: head,
    columnStyles: { 1: { halign: 'right', cellWidth: 25 }, 2: { halign: 'right', cellWidth: 22 } },
    body: [...groupRows(entries, R.g1, secOf).map(r => [groupText(r, R.g1), fmtHM(r.sec), `${total ? Math.round(r.sec / total * 100) : 0}%`]), ['Totaal', fmtHM(total), '']],
    didParseCell: c => {
      if (c.section === 'head' && c.column.index > 0) c.cell.styles.halign = 'right';
      if (c.section === 'body' && c.row.index === c.table.body.length - 1) c.cell.styles.fontStyle = 'bold';
    }
  });
  doc.autoTable({
    startY: doc.lastAutoTable.finalY + 8, styles: style, headStyles: head,
    head: [['Datum', 'Tijd', 'Duur', 'Medewerker', 'Klant', 'Project', 'Omschrijving', 'Tags']],
    columnStyles: { 0: { cellWidth: 22 }, 1: { cellWidth: 22 }, 2: { halign: 'right', cellWidth: 14 } },
    didParseCell: c => { if (c.section === 'head' && c.column.index === 2) c.cell.styles.halign = 'right'; },
    body: [...entries].sort((a, b) => entryStart(a) - entryStart(b)).map(e => {
      const p = projectOf(e);
      return [fmtDate(entryStart(e), { day: '2-digit', month: '2-digit', year: 'numeric' }), `${hm(entryStart(e))}-${e.end_at ? hm(entryEnd(e)) : 'nu'}`, fmtHM(entrySec(e)),
        entryUserName(e), clientOf(p)?.name || '', p?.name || '', e.description, tagNames(e.tag_ids).join(', ')];
    })
  });
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) { doc.setPage(i); doc.setFontSize(8); doc.setTextColor(140); doc.text(`Pagina ${i} van ${pages}`, 283, 203, { align: 'right' }); }
  doc.save(`polyfy-rapport-${ymd(from)}-tot-${ymd(addDays(to, -1))}.pdf`);
}

function exportCsv(entries, from, to) {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Datum', 'Start', 'Einde', 'Duur (u:mm)', 'Duur (decimaal)', 'Medewerker', 'E-mail', 'Klant', 'Project', 'Omschrijving', 'Tags', 'Factureerbaar', 'Tarief', 'Bedrag'];
  const rows = [...entries].sort((a, b) => entryStart(a) - entryStart(b)).map(e => {
    const p = projectOf(e), u = profileOf(e.user_id), sec = entrySec(e);
    return [ymd(entryStart(e)), hm(entryStart(e)), e.end_at ? hm(entryEnd(e)) : '', fmtHM(sec), (sec / 3600).toFixed(2).replace('.', ','),
      u?.full_name || e.import_name, u?.email || e.import_email, clientOf(p)?.name, p?.name, e.description, tagNames(e.tag_ids).join(', '), e.billable ? 'Ja' : 'Nee',
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
    .filter(p => !P.client || (P.client === '__none' ? !p.client_id : p.client_id === P.client))
    .filter(p => !P.search || (p.name + ' ' + (clientOf(p)?.name || '')).toLowerCase().includes(P.search.toLowerCase()));

  page.innerHTML = `
    <div class="page-head"><div><h1>Projects</h1><div class="muted">${list.length} van ${S.projects.length} projecten</div></div>${isAdmin() ? `<button class="btn primary" id="p-new">${icon('plus')}Nieuw project</button>` : ''}</div>
    <div class="row">
      <input id="p-search" placeholder="Zoek project of klant…" value="${esc(P.search)}" style="min-width:240px">
      <select id="p-client" aria-label="Klant"><option value="">Alle klanten</option><option value="__none" ${P.client === '__none' ? 'selected' : ''}>Zonder klant</option>${S.clients.map(c => `<option value="${c.id}" ${c.id === P.client ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <div class="seg" id="p-status">${[['active', 'Actief'], ['archived', 'Gearchiveerd'], ['all', 'Alle']].map(([k, l]) => `<button data-s="${k}" class="${P.status === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    </div>
    <div class="card table-wrap">
      ${list.length ? `<table><thead><tr><th>Project</th><th>Klant</th><th class="r">Geregistreerd</th>${isAdmin() ? '<th></th>' : ''}</tr></thead><tbody>
      ${list.map(p => `<tr data-id="${p.id}">
          <td><a href="#reports" data-rep class="proj" style="color:var(--text);text-decoration:none"><span class="dot" style="background:${esc(p.color)}"></span>${esc(p.name)}</a>${p.archived ? ' <span class="tag">gearchiveerd</span>' : ''}</td>
          <td>${esc(clientOf(p)?.name || '–')}</td>
          <td class="r num"><b>${fmtHM(Number(tot.get(p.id)?.total_seconds || 0))}</b></td>
          ${isAdmin() ? `<td class="r"><button class="btn icon ghost" data-edit aria-label="Bewerken">${icon('edit')}</button></td>` : ''}
        </tr>`).join('')}</tbody></table>` : `<div class="empty">${S.projects.length ? 'Geen projecten gevonden.' : isAdmin() ? 'Nog geen projecten. Maak je eerste project aan.' : 'Er zijn nog geen projecten. Vraag een beheerder om ze aan te maken.'}</div>`}
    </div>`;

  const search = $('#p-search');
  search.oninput = debounce(() => { P.search = search.value; refreshPage(); setTimeout(() => { const s = $('#p-search'); s?.focus(); s?.setSelectionRange(s.value.length, s.value.length); }); }, 250);
  $('#p-client').onchange = e => { P.client = e.target.value; refreshPage(); };
  $$('#p-status button').forEach(b => b.onclick = () => { P.status = b.dataset.s; refreshPage(); });
  $$('[data-rep]').forEach(a => a.onclick = ev => {
    const [from, to] = rangeOf('year');
    Object.assign(S.rep, { project: a.closest('tr').dataset.id, client: '', tag: '', desc: '', from, to, tab: 'summary', g1: isAdmin() ? 'user' : 'day', g2: '' });
  });
  if (isAdmin()) {
    $('#p-new').onclick = () => openProjectModal(null);
    $$('[data-edit]').forEach(b => b.onclick = () => openProjectModal(byId(S.projects, b.closest('tr').dataset.id)));
  }
}

// =====================================================================
// Clients
// =====================================================================
async function renderClients(page) {
  const { data: totals, error } = await sb.rpc('project_totals');
  if (error) throw error;
  if (S.view !== 'clients') return;
  const tot = new Map(totals.map(t => [t.project_id, Number(t.total_seconds)]));
  page.innerHTML = `
    <div class="page-head"><h1>Clients</h1>${isAdmin() ? `<button class="btn primary" id="c-new">${icon('plus')}Nieuwe klant</button>` : ''}</div>
    <div class="card table-wrap">
      ${S.clients.length ? `<table><thead><tr><th>Klant</th><th>Projecten</th><th class="r">Geregistreerd</th>${isAdmin() ? '<th></th>' : ''}</tr></thead><tbody>${S.clients.map(c => {
        const ps = S.projects.filter(p => p.client_id === c.id);
        return `<tr data-cid="${c.id}"><td><b>${esc(c.name)}</b>${c.archived ? ' <span class="tag">gearchiveerd</span>' : ''}</td>
          <td><a href="#projects" data-cproj>${ps.length} project${ps.length === 1 ? '' : 'en'}</a></td>
          <td class="r num">${fmtHM(ps.reduce((a, p) => a + (tot.get(p.id) || 0), 0))}</td>
          ${isAdmin() ? `<td class="r"><button class="btn icon ghost" data-cedit aria-label="Bewerken">${icon('edit')}</button></td>` : ''}</tr>`;
      }).join('')}</tbody></table>` : '<div class="empty">Nog geen klanten.</div>'}
    </div>`;
  $$('[data-cproj]').forEach(a => a.onclick = () => Object.assign(S.proj, { client: a.closest('tr').dataset.cid, status: 'all', search: '' }));
  if (isAdmin()) {
    $('#c-new').onclick = () => openClientModal(null);
    $$('[data-cedit]').forEach(b => b.onclick = () => openClientModal(byId(S.clients, b.closest('tr').dataset.cid)));
  }
}

// =====================================================================
// Tags
// =====================================================================
async function renderTags(page) {
  page.innerHTML = `
    <div class="page-head"><h1>Tags</h1>${isAdmin() && S.tagsReady ? `<button class="btn primary" id="tg-new">${icon('plus')}Nieuwe tag</button>` : ''}</div>
    ${!S.tagsReady ? '<div class="card card-body notice">Tags zijn nog niet actief: voer <code>supabase/schema-v2-tags-import.sql</code> uit in Supabase.</div>'
      : `<div class="card table-wrap">${S.tags.length ? `<table><thead><tr><th>Tag</th><th>Status</th>${isAdmin() ? '<th></th>' : ''}</tr></thead><tbody>${S.tags.map(t => `<tr data-tid="${t.id}">
          <td><span class="tag">${esc(t.name)}</span></td><td class="muted">${t.archived ? 'gearchiveerd' : 'actief'}</td>
          ${isAdmin() ? `<td class="r"><button class="btn icon ghost" data-tedit aria-label="Bewerken">${icon('edit')}</button></td>` : ''}</tr>`).join('')}</tbody></table>`
        : '<div class="empty">Nog geen tags. Je kan ze ook rechtstreeks in de Time Tracker maken.</div>'}</div>`}`;
  if (isAdmin() && S.tagsReady) {
    $('#tg-new').onclick = () => openTagModal(null);
    $$('[data-tedit]').forEach(b => b.onclick = () => openTagModal(byId(S.tags, b.closest('tr').dataset.tid)));
  }
}

function openTagModal(t) {
  openModal(t ? 'Tag bewerken' : 'Nieuwe tag', `
    <label class="field">Naam<input id="tm-name" value="${esc(t?.name || '')}" required></label>
    ${t ? `<label class="check"><input type="checkbox" id="tm-arch" ${t.archived ? 'checked' : ''}> Gearchiveerd (niet meer kiesbaar bij registreren)</label>` : ''}`,
    `<div>${t ? `<button class="btn danger" id="tm-del">${icon('trash')}Verwijderen</button>` : ''}</div><div class="row"><button class="btn" data-close>Annuleren</button><button class="btn primary" id="tm-save">Opslaan</button></div>`);
  $('#tm-save').onclick = async () => {
    const name = $('#tm-name').value.trim();
    if (!name) return toast('Geef de tag een naam.', true);
    const row = { name }; if (t) row.archived = $('#tm-arch').checked;
    const { data, error } = t ? await sb.from('tags').update(row).eq('id', t.id).select().single() : await sb.from('tags').insert(row).select().single();
    if (error) return fail(error.code === '23505' ? new Error('Er bestaat al een tag met die naam.') : error);
    if (t) Object.assign(t, data); else S.tags.push(data);
    S.tags.sort(byName);
    closeModal(); toast('Tag opgeslagen'); renderTimer(); refreshPage();
  };
  if (t) $('#tm-del').onclick = async () => {
    if (!confirm(`Tag "${t.name}" verwijderen? Hij verdwijnt ook uit alle registraties. Archiveren is meestal beter.`)) return;
    const { error } = await sb.from('tags').delete().eq('id', t.id);
    if (error) return fail(error);
    S.tags = S.tags.filter(x => x.id !== t.id);
    closeModal(); toast('Tag verwijderd'); renderTimer(); refreshPage();
  };
}

function openProjectModal(p) {
  const used = new Set(S.projects.map(x => x.color));
  const cur = p || { name: '', client_id: null, color: PROJECT_COLORS.find(c => !used.has(c)) || PROJECT_COLORS[S.projects.length % PROJECT_COLORS.length], billable: true, hourly_rate: null, budget_hours: null, archived: false };
  let color = cur.color;
  const m = openModal(p ? 'Project bewerken' : 'Nieuw project', `
    <label class="field">Naam<input id="pm-name" value="${esc(cur.name)}" required></label>
    <label class="field">Klant<select id="pm-client"><option value="">Zonder klant</option>${S.clients.filter(c => !c.archived || c.id === cur.client_id).map(c => `<option value="${c.id}" ${c.id === cur.client_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}<option value="__new">+ Nieuwe klant…</option></select></label>
    <div class="field">Kleur<div class="swatches">${PROJECT_COLORS.map(c => `<button type="button" class="swatch ${c === color ? 'on' : ''}" data-c="${c}" style="background:${c}" aria-label="Kleur ${c}"></button>`).join('')}</div></div>
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
    const row = { name, client_id: $('#pm-client').value || null, color };
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
async function renderTeam(page) {
  const T = S.team;
  const [sum, un] = await Promise.all([
    sb.rpc('team_summary', { week_start: startOfWeek(new Date()).toISOString() }),
    isAdmin() && S.tagsReady ? sb.rpc('unclaimed_imports') : Promise.resolve({ data: [] })
  ]);
  if (sum.error) throw sum.error;
  if (S.view !== 'team') return;
  const live = new Map(sum.data.filter(r => r.running_since).map(r => [r.user_id, r]));
  const q = T.q.toLowerCase();
  const match = (name, email) => !q || `${name} ${email}`.toLowerCase().includes(q);
  const members = [...S.profiles]
    .filter(p => T.status === 'all' || (T.status === 'active') === p.active)
    .filter(p => !T.role || p.role === T.role)
    .filter(p => match(p.full_name, p.email))
    .sort((a, b) => (a.full_name || a.email).localeCompare(b.full_name || b.email));
  // Wie nog geen account heeft maar wel uren uit Clockify (wordt gekoppeld bij registratie)
  const pending = (un.error ? [] : un.data || []).filter(r => T.status !== 'inactive' && !T.role && match(r.import_name || '', r.import_email));
  const roleTag = p => `<span class="tag ${p.role === 'admin' ? 'admin' : ''}">${p.role === 'admin' ? 'Beheerder' : 'Medewerker'}</span>`;

  page.innerHTML = `
    <div class="page-head"><h1>Team</h1>${isAdmin() ? `<button class="btn primary" id="tm-add">${icon('plus')}Nieuw lid toevoegen</button>` : ''}</div>
    <div class="card filterbar">
      <span class="flabel">Filter</span>
      <select id="tm-status" aria-label="Status"><option value="active">Actief</option><option value="inactive" ${T.status === 'inactive' ? 'selected' : ''}>Gedeactiveerd</option><option value="all" ${T.status === 'all' ? 'selected' : ''}>Alle</option></select>
      <select id="tm-role" aria-label="Rol"><option value="">Alle rollen</option><option value="admin" ${T.role === 'admin' ? 'selected' : ''}>Beheerder</option><option value="member" ${T.role === 'member' ? 'selected' : ''}>Medewerker</option></select>
      <input id="tm-q" placeholder="Zoek op naam of e-mail" value="${esc(T.q)}" style="margin-left:auto;min-width:220px" aria-label="Zoeken">
    </div>
    <div class="card table-wrap">
      <div class="card-head"><span class="muted small">Leden</span><span class="muted small">${members.length + pending.length}</span></div>
      ${members.length || pending.length ? `<table><thead><tr><th>Naam</th><th>E-mail</th>${isAdmin() ? `<th>Uurtarief (${esc(CFG.CURRENCY || 'EUR')})</th>` : ''}<th>Rol</th>${isAdmin() ? '<th></th>' : ''}</tr></thead><tbody>
      ${members.map(p => {
        const l = live.get(p.id), pj = l && byId(S.projects, l.running_project);
        return `<tr data-id="${p.id}">
          <td><span class="row" style="flex-wrap:nowrap">${avatar(p)}<span>${esc(p.full_name || p.email)}${p.id === S.me.id ? ' <span class="muted">(jij)</span>' : ''}
            ${l ? `<br><span class="tag live" title="Sinds ${hm(new Date(l.running_since))}">● aan het werk${pj ? ' · ' + esc(pj.name) : ''}</span>` : ''}${p.active ? '' : ' <span class="tag off">gedeactiveerd</span>'}</span></span></td>
          <td>${esc(p.email)}</td>
          ${isAdmin() ? `<td><span class="rate"><span class="num">${Number(p.hourly_rate) ? fmtMoney(Number(p.hourly_rate)) : '–'}</span><button class="linkbtn" data-rate>Wijzig</button></span></td>` : ''}
          <td>${isAdmin() && p.id !== S.me.id ? `<button class="rolebtn" data-role>${roleTag(p)}</button>` : roleTag(p)}</td>
          ${isAdmin() ? `<td class="r"><button class="btn icon ghost" data-more aria-label="Meer">${icon('dots')}</button></td>` : ''}
        </tr>`;
      }).join('')}
      ${pending.map(r => `<tr><td><span class="row" style="flex-wrap:nowrap">${avatar({ id: r.import_email, full_name: r.import_name })}<span>${esc(r.import_name || r.import_email)}<br><span class="muted small">${r.entries} geïmporteerde registraties</span></span></span></td>
        <td>${esc(r.import_email)}</td>${isAdmin() ? '<td class="muted">–</td>' : ''}<td><span class="tag">Nog geen account</span></td>${isAdmin() ? '<td></td>' : ''}</tr>`).join('')}
      </tbody></table>` : '<div class="empty">Geen leden gevonden.</div>'}
    </div>`;

  const set = patch => { Object.assign(T, patch); refreshPage(); };
  $('#tm-status').onchange = e => set({ status: e.target.value });
  $('#tm-role').onchange = e => set({ role: e.target.value });
  const qi = $('#tm-q');
  qi.oninput = debounce(() => { T.q = qi.value.trim(); refreshPage(); setTimeout(() => { const x = $('#tm-q'); x?.focus(); x?.setSelectionRange(x.value.length, x.value.length); }); }, 300);
  if (!isAdmin()) return;
  $('#tm-add').onclick = openInviteModal;
  const saveProfile = async (p, patch) => {
    const { data, error } = await sb.from('profiles').update(patch).eq('id', p.id).select().single();
    if (error) return fail(error);
    Object.assign(p, data); refreshPage();
  };
  $$('tr[data-id]', page).forEach(tr => {
    const p = profileOf(tr.dataset.id);
    const rb = $('[data-rate]', tr);
    if (rb) rb.onclick = () => openMenu(rb, `<div style="padding:8px;display:flex;gap:6px"><input type="number" min="0" step="0.01" value="${Number(p.hourly_rate) || ''}" placeholder="0,00" style="width:110px" aria-label="Uurtarief"><button class="btn primary">Opslaan</button></div>`, m => {
      const inp = $('input', m), go = () => { closeMenu(); saveProfile(p, { hourly_rate: Number(inp.value || 0) }); };
      $('button', m).onclick = go; inp.onkeydown = e => { if (e.key === 'Enter') go(); };
    });
    const ro = $('[data-role]', tr);
    if (ro) ro.onclick = () => openMenu(ro, `<button class="mi ${p.role === 'admin' ? 'on' : ''}" data-v="admin">Beheerder</button><button class="mi ${p.role === 'member' ? 'on' : ''}" data-v="member">Medewerker</button>`, m => {
      $$('[data-v]', m).forEach(x => x.onclick = () => { closeMenu(); if (x.dataset.v !== p.role) saveProfile(p, { role: x.dataset.v }); });
    });
    const mo = $('[data-more]', tr);
    mo.onclick = () => openMenu(mo, `<button class="mi" data-m="edit">Bewerken</button><button class="mi" data-m="rep">Rapport bekijken</button>${p.id !== S.me.id ? `<button class="mi ${p.active ? 'danger' : ''}" data-m="act">${p.active ? 'Deactiveren' : 'Activeren'}</button>` : ''}`, m => {
      $$('[data-m]', m).forEach(x => x.onclick = () => {
        closeMenu();
        if (x.dataset.m === 'edit') return openMemberModal(p);
        if (x.dataset.m === 'rep') { Object.assign(S.rep, { user: p.id, project: '', client: '', tag: '', desc: '', g1: 'project', tab: 'summary' }); location.hash = 'reports'; return; }
        if (p.active && !confirm(`${p.full_name || p.email} deactiveren? Die persoon kan dan niet meer inloggen om uren te registreren.`)) return;
        saveProfile(p, { active: !p.active });
      });
    });
  });
}

function openInviteModal() {
  const link = location.origin + location.pathname, dom = (CFG.ALLOWED_EMAIL_DOMAIN || '').trim();
  openModal('Nieuw lid toevoegen', `
    <p style="margin:0">Stuur deze link naar je collega. Die maakt zelf een account met ${dom ? `een <b>@${esc(dom)}</b>-adres` : 'zijn of haar e-mailadres'} en verschijnt daarna hier als medewerker.</p>
    <div class="row"><input readonly value="${esc(link)}" style="flex:1;min-width:200px" id="inv-link"><button class="btn" id="inv-copy">Kopiëren</button></div>
    <p class="muted small" style="margin:0">Uren uit Clockify worden automatisch aan het account gekoppeld als je collega hetzelfde e-mailadres gebruikt als in Clockify.</p>`,
    `<div></div><button class="btn primary" data-close>Klaar</button>`);
  $('#inv-copy').onclick = async () => { try { await navigator.clipboard.writeText(link); toast('Link gekopieerd'); } catch (_) { $('#inv-link').select(); } };
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

// =====================================================================
// Importeren (Clockify: gedetailleerd rapport en/of projectlijst als CSV)
// =====================================================================
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const head = text.slice(0, text.search(/\r?\n|$/));
  const delim = (head.match(/;/g) || []).length > (head.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c !== '"') f += c; else if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}

// Kolomnamen van Clockify (Engels en Nederlands), vergeleken zonder spaties/leestekens
const IMP_COLS = {
  project: ['project', 'projectnaam', 'name', 'naam'], client: ['client', 'klant'],
  description: ['description', 'beschrijving', 'omschrijving'], user: ['user', 'gebruiker', 'medewerker'],
  email: ['email'], tags: ['tags', 'tag'], billable: ['billable', 'billability', 'factureerbaar'],
  sdate: ['startdate', 'startdatum'], stime: ['starttime', 'starttijd'], edate: ['enddate', 'einddatum'], etime: ['endtime', 'eindtijd'],
  dur: ['durationdecimal', 'duurdecimaal'],
  // Enkel in de projectexport
  tracked: ['trackedh', 'geregistreerdu'], estimate: ['estimatedh', 'geschatu'], rate: ['billablerateeur', 'billablerate', 'uurtarief']
};
// Clockify schrijft soms "(Without client)" e.d. in plaats van een leeg veld
const impVal = v => /^\((without|zonder) [^)]*\)$/i.test(v) ? '' : v;
const lc = v => String(v ?? '').trim().toLowerCase();
const PENDING = '__pending';
const isYes = v => /^(yes|ja|true|1|y|j)$/i.test(String(v).trim());

function parseClock(t) {
  const m = String(t).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  if (m[4]) { const pm = /^p/i.test(m[4]); if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
  return [h, Number(m[2]), Number(m[3] || 0)];
}

function analyzeImport(files) {
  const A = { files: [], entries: [], users: new Map(), projects: new Map(), clients: new Map(), tags: new Map(), errors: [], dupes: 0 };
  const raw = [];
  for (const file of files) {
    const rows = parseCsv(file.text);
    const norm = (rows[0] || []).map(h => lc(h).replace(/[^a-z]/g, ''));
    const ix = Object.fromEntries(Object.entries(IMP_COLS).map(([k, names]) => [k, norm.findIndex(h => names.includes(h))]));
    const get = (r, k) => ix[k] >= 0 ? impVal(String(r[ix[k]] ?? '').trim()) : '';
    const num = v => v === '' ? null : Number(v.replace(',', '.')) || null;
    const isReport = ix.sdate >= 0 && ix.stime >= 0;
    if (!isReport && ix.project < 0) { A.files.push({ name: file.name, kind: 'onbekend', n: 0 }); A.errors.push(`${file.name}: kolommen niet herkend (verwacht een Clockify-export).`); continue; }
    // Een samenvattend rapport heeft geen datums: daaruit komen enkel projecten en klanten
    const kind = isReport ? 'registraties' : ix.tracked >= 0 ? 'projectlijst' : 'enkel projecten, geen registraties';
    if (!isReport && ix.tracked < 0) A.summaryOnly = true;
    A.files.push({ name: file.name, kind, n: rows.length - 1 });
    rows.slice(1).forEach((r, i) => {
      const o = { line: i + 2, file: file.name, project: get(r, 'project'), client: get(r, 'client'), billable: ix.billable < 0 || isYes(get(r, 'billable')) };
      if (o.client) A.clients.set(lc(o.client), o.client);
      if (o.project) {
        const k = lc(o.project) + '|' + lc(o.client), p = A.projects.get(k) || { name: o.project, client: o.client, billable: o.billable };
        if (isReport) { if (o.billable) p.billable = true; }
        else if (ix.tracked >= 0) {
          // Projectlijst: instellingen overnemen en Clockify-totaal bijhouden om te controleren of alle uren mee zijn
          Object.assign(p, { billable: o.billable, budget_hours: num(get(r, 'estimate')), hourly_rate: num(get(r, 'rate')) });
          A.trackedSec = (A.trackedSec || 0) + (num(get(r, 'tracked')) || 0) * 3600;
        }
        A.projects.set(k, p);
      }
      if (!isReport) return;
      Object.assign(o, { description: get(r, 'description'), user: get(r, 'user'), email: get(r, 'email'), sdate: get(r, 'sdate'), stime: get(r, 'stime'), edate: get(r, 'edate'), etime: get(r, 'etime'), dur: get(r, 'dur') });
      o.tags = get(r, 'tags').split(',').map(t => t.trim()).filter(Boolean);
      o.tags.forEach(t => A.tags.set(lc(t), A.tags.get(lc(t)) || t));
      raw.push(o);
    });
  }

  // Datumvolgorde bepalen: dd/mm/jjjj (standaard), mm/dd/jjjj of jjjj-mm-dd
  const parts = raw.flatMap(o => [o.sdate, o.edate]).filter(Boolean).map(d => d.split(/[./-]/).map(Number));
  const order = parts.some(p => String(p[0]).length === 4 || p[0] > 31) ? 'ymd' : parts.some(p => p[1] > 12) ? 'mdy' : 'dmy';
  const toDate = (d, t) => {
    const p = d.split(/[./-]/).map(Number), c = parseClock(t);
    if (p.length !== 3 || !c) return null;
    const [y, m, dd] = order === 'ymd' ? p : order === 'mdy' ? [p[2], p[0], p[1]] : [p[2], p[1], p[0]];
    const x = new Date(y < 100 ? 2000 + y : y, m - 1, dd, ...c);
    return isNaN(x) ? null : x;
  };

  const refs = new Set();
  for (const o of raw) {
    const start = toDate(o.sdate, o.stime);
    let end = o.etime ? toDate(o.edate || o.sdate, o.etime) : null;
    if (!end && start && o.dur) end = new Date(start.getTime() + Number(o.dur.replace(',', '.')) * 3600000);
    if (start && end && end < start) end = addDays(end, 1);
    if (!start || !end || isNaN(end)) { A.errors.push(`${o.file}, regel ${o.line}: datum of tijd niet leesbaar (${o.sdate} ${o.stime} – ${o.edate} ${o.etime})`); continue; }
    const ukey = lc(o.email) || lc(o.user);
    if (!ukey) { A.errors.push(`${o.file}, regel ${o.line}: geen medewerker`); continue; }
    const ref = ['clockify', ukey, start.toISOString(), end.toISOString(), lc(o.project), lc(o.description)].join('|');
    if (refs.has(ref)) { A.dupes++; continue; }
    refs.add(ref);
    const u = A.users.get(ukey) || { key: ukey, name: o.user, email: o.email, n: 0, sec: 0 };
    u.n++; u.sec += (end - start) / 1000; A.users.set(ukey, u);
    A.entries.push({ ukey, project: o.project, client: o.client, description: o.description, tags: o.tags, billable: o.billable, start, end, ref });
  }
  if (A.entries.length) {
    A.from = new Date(Math.min(...A.entries.map(e => e.start)));
    A.to = new Date(Math.max(...A.entries.map(e => e.start)));
  }
  // Medewerkers automatisch koppelen: eerst op e-mail, anders op naam
  // Geen account: wachten tot de collega er een maakt (indien schema-v3), behalve verwijderde Clockify-gebruikers
  A.map = new Map([...A.users.values()].map(u => [u.key,
    (S.profiles.find(p => lc(p.email) === lc(u.email) && u.email) || S.profiles.find(p => lc(p.full_name) === lc(u.name) && u.name))?.id
    || (S.pendingReady && u.email && !/^deleteduser/i.test(u.name) ? PENDING : '')]));
  return A;
}

// Wat moet er nieuw aangemaakt worden?
function importPlan(A) {
  const clientIds = new Map(S.clients.map(c => [lc(c.name), c.id]));
  const newClients = [...A.clients.entries()].filter(([k]) => !clientIds.has(k)).map(([, n]) => n);
  const existing = new Set(S.projects.map(p => lc(p.name) + '|' + lc(clientOf(p)?.name)));
  const newProjects = [...A.projects.entries()].filter(([k]) => !existing.has(k)).map(([, p]) => p);
  const newTags = [...A.tags.entries()].filter(([k]) => !S.tags.some(t => lc(t.name) === k)).map(([, n]) => n);
  return { newClients, newProjects, newTags };
}

async function renderImport(page) {
  // schema-v3 aanwezig? Dan ook importeren voor collega's zonder account
  const un = S.tagsReady ? await sb.rpc('unclaimed_imports') : { error: true };
  if (S.view !== 'import') return;
  S.pendingReady = !un.error;
  const A = S.imp;
  page.innerHTML = `
    <div class="page-head"><div><h1>Import</h1><div class="muted">Registraties, projecten, klanten en tags overzetten naar Polyfy</div></div></div>
    ${S.tagsReady ? '' : '<div class="card card-body notice">Voer eerst <code>supabase/schema-v2-tags-import.sql</code> uit in de Supabase SQL Editor en herlaad daarna deze pagina. Zonder die update kan er niet geïmporteerd worden.</div>'}
    ${S.tagsReady && !S.pendingReady ? '<div class="card card-body notice">Voer ook <code>supabase/schema-v3-import-zonder-account.sql</code> uit om uren te kunnen importeren voor collega\'s die nog geen account hebben. Ze worden dan automatisch gekoppeld zodra ze er een maken.</div>' : ''}
    ${un.data?.length ? `<div class="card table-wrap">
      <div class="card-head"><h2>Wachten op een account</h2><span class="muted small">wordt automatisch gekoppeld bij registratie met dit e-mailadres</span></div>
      <table><thead><tr><th>Uit Clockify</th><th class="r">Registraties</th><th class="r">Uren</th><th>Nu al koppelen aan</th></tr></thead><tbody>
      ${un.data.map(r => `<tr><td><b>${esc(r.import_name || r.import_email)}</b><br><span class="muted small">${esc(r.import_email)}</span></td><td class="r num">${r.entries}</td><td class="r num">${fmtHM(Number(r.seconds))}</td>
        <td><div class="row" style="flex-wrap:nowrap"><select data-claim="${esc(r.import_email)}" aria-label="Account"><option value="">Wachten op account</option>${S.profiles.map(p => `<option value="${p.id}">${esc(p.full_name || p.email)} (${esc(p.email)})</option>`).join('')}</select><button class="btn" data-claim-go>Koppelen</button></div></td></tr>`).join('')}
      </tbody></table>
    </div>` : ''}
    <div class="card">
      <div class="card-head"><h2>1. Exporteer uit Clockify</h2></div>
      <div class="card-body">
        <ol style="margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px">
          <li><b>Registraties:</b> <i>Reports → Detailed</i>, kies de volledige periode (vanaf je allereerste registratie), dan <i>Export → Save as CSV</i>. Lukt één lange periode niet, exporteer dan per jaar en kies hieronder alle bestanden samen.</li>
          <li><b>Alle projecten</b> (ook oude zonder registraties in de export): <i>Projects</i>, filter op <i>Active</i> én <i>Archived</i>, en exporteer de lijst als CSV. Optioneel.</li>
          <li>${S.pendingReady ? 'Collega\'s hoeven nog geen account te hebben: hun uren worden gekoppeld zodra ze zich registreren met hetzelfde e-mailadres als in Clockify.' : 'Laat collega\'s eerst <b>zelf een account maken</b> in Polyfy: registraties worden via het e-mailadres aan hun account gekoppeld.'}</li>
        </ol>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h2>2. Kies de CSV-bestanden</h2></div>
      <div class="card-body row">
        <input type="file" id="i-file" accept=".csv,text/csv" multiple ${S.tagsReady ? '' : 'disabled'}>
        ${A ? `<span class="muted small">${A.files.map(f => `${esc(f.name)} (${f.n} regels, ${f.kind})`).join(' · ')}</span>` : ''}
      </div>
    </div>
    <div id="i-preview"></div>`;
  $('#i-file').onchange = async e => {
    const files = await Promise.all([...e.target.files].map(async f => ({ name: f.name, text: await f.text() })));
    if (!files.length) return;
    S.imp = analyzeImport(files);
    refreshPage();
  };
  $$('[data-claim-go]', page).forEach(b => b.onclick = async () => {
    const sel = $('select', b.parentElement);
    if (!sel.value) return toast('Kies eerst een account.', true);
    const { data, error } = await sb.rpc('assign_imported', { p_email: sel.dataset.claim, p_user: sel.value });
    if (error) return fail(error);
    toast(`${data} registraties gekoppeld`); refreshPage();
  });
  if (A) renderImportPreview($('#i-preview'), A);
}

function renderImportPreview(el, A) {
  const plan = importPlan(A);
  const users = [...A.users.values()].sort((a, b) => b.n - a.n);
  const count = () => A.entries.filter(e => A.map.get(e.ukey)).length;
  const list = (title, items) => items.length ? `<details><summary><b>${items.length}</b> ${title}</summary><div class="row" style="gap:6px;margin-top:8px">${items.map(x => `<span class="tag">${esc(x)}</span>`).join('')}</div></details>` : '';
  el.innerHTML = `
    <div class="tiles">
      <div class="card tile"><div class="label">Registraties</div><div class="value num">${A.entries.length}</div><div class="sub">${A.from ? `${esc(fmtDate(A.from, { day: 'numeric', month: 'short', year: 'numeric' }))} – ${esc(fmtDate(A.to, { day: 'numeric', month: 'short', year: 'numeric' }))}` : 'geen'}</div></div>
      <div class="card tile"><div class="label">Uren</div><div class="value num">${fmtHM(A.entries.reduce((t, e) => t + (e.end - e.start) / 1000, 0))}</div><div class="sub">${users.length} medewerkers</div></div>
      <div class="card tile"><div class="label">Projecten</div><div class="value num">${A.projects.size}</div><div class="sub">${plan.newProjects.length} nieuw</div></div>
      <div class="card tile"><div class="label">Klanten · tags</div><div class="value num">${A.clients.size} · ${A.tags.size}</div><div class="sub">${plan.newClients.length} + ${plan.newTags.length} nieuw</div></div>
    </div>
    ${users.length ? `<div class="card table-wrap">
      <div class="card-head"><h2>3. Koppel medewerkers</h2><span class="muted small">automatisch op e-mail of naam</span></div>
      <table><thead><tr><th>In Clockify</th><th class="r">Registraties</th><th class="r">Uren</th><th>Account in Polyfy</th></tr></thead><tbody>
      ${users.map(u => `<tr><td><b>${esc(u.name || u.email)}</b><br><span class="muted small">${esc(u.email)}</span></td><td class="r num">${u.n}</td><td class="r num">${fmtHM(u.sec)}</td>
        <td><select data-ukey="${esc(u.key)}" aria-label="Account voor ${esc(u.name)}"><option value="">Niet importeren</option>${S.pendingReady && u.email ? `<option value="${PENDING}" ${A.map.get(u.key) === PENDING ? 'selected' : ''}>Koppelen zodra ${esc(u.email)} een account maakt</option>` : ''}${S.profiles.map(p => `<option value="${p.id}" ${A.map.get(u.key) === p.id ? 'selected' : ''}>${esc(p.full_name || p.email)} (${esc(p.email)})</option>`).join('')}</select></td></tr>`).join('')}
      </tbody></table>
      <div class="card-body muted small" style="border-top:1px solid var(--line)">${S.pendingReady
        ? 'Collega\'s zonder account: hun uren worden nu al geïmporteerd en automatisch aan hun account gekoppeld zodra ze zich registreren met hetzelfde e-mailadres. Tot dan zie enkel jij ze (in Reports).'
        : 'Heeft iemand nog geen account? Laat die collega er eerst een maken en importeer hetzelfde bestand later opnieuw: wat al geïmporteerd is, wordt overgeslagen.'}</div>
    </div>` : ''}
    <div class="card">
      <div class="card-head"><h2>${users.length ? '4' : '3'}. Importeren</h2></div>
      <div class="card-body" style="display:flex;flex-direction:column;gap:10px">
        ${list('nieuwe klanten', plan.newClients)}
        ${list('nieuwe projecten', plan.newProjects.map(p => p.name + (p.client ? ' · ' + p.client : '')))}
        ${list('nieuwe tags', plan.newTags)}
        ${A.trackedSec ? (() => {
          const sec = A.entries.reduce((t, e) => t + (e.end - e.start) / 1000, 0), pct = sec / A.trackedSec * 100;
          return `<div class="card-body ${pct < 98 ? 'notice' : ''}" style="border-radius:var(--r-sm)">Volgens de projectlijst staat er in Clockify <b>${fmtHM(A.trackedSec)}</b> uur. De registraties in je bestanden zijn samen <b>${fmtHM(sec)}</b> uur (${Math.round(pct)}%).${pct < 98 ? ' Er ontbreken dus nog registraties: exporteer in Clockify het gedetailleerde rapport over een langere periode (of per jaar) en kies alle bestanden samen.' : ' Alles lijkt mee te zijn.'}</div>`;
        })() : ''}
        ${A.summaryOnly ? '<div class="card-body notice" style="border-radius:var(--r-sm)">Een <b>samenvattend</b> rapport bevat geen afzonderlijke registraties. Gebruik voor de uren <i>Reports → Detailed</i>.</div>' : ''}
        ${A.dupes ? `<div class="muted small">${A.dupes} dubbele regels in de bestanden worden maar één keer geteld.</div>` : ''}
        ${A.errors.length ? `<details class="notice"><summary><b>${A.errors.length}</b> regels kunnen niet gelezen worden en worden overgeslagen</summary><ul class="small">${A.errors.slice(0, 50).map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>` : ''}
        <div class="muted small">Alle projecten worden als <b>actief</b> aangemaakt, zodat je ook op oude projecten verder kan werken. Archiveren kan nadien op de pagina Projects. Uurtarieven en weekdoelen per medewerker stel je in bij Team.</div>
        <div class="row"><button class="btn primary" id="i-go">${icon('up')}<span id="i-go-l"></span></button><span class="muted small" id="i-status"></span></div>
      </div>
    </div>`;
  const label = () => { const n = count(); $('#i-go-l').textContent = n ? `${n} registraties importeren` : (A.projects.size ? 'Projecten en klanten importeren' : 'Niets te importeren'); $('#i-go').disabled = !n && !A.projects.size; };
  $$('[data-ukey]', el).forEach(sel => sel.onchange = () => { A.map.set(sel.dataset.ukey, sel.value); label(); });
  label();
  $('#i-go').onclick = async () => {
    const btn = $('#i-go'), status = $('#i-status');
    btn.disabled = true;
    try {
      const r = await runImport(A, msg => status.textContent = msg);
      await loadBase(); S.imp = null; renderShell(); route();
      toast(`Import klaar: ${r.added} registraties toegevoegd${r.skipped ? `, ${r.skipped} waren er al` : ''}.`);
    } catch (err) { fail(err); btn.disabled = false; status.textContent = ''; }
  };
}

async function runImport(A, progress) {
  const plan = importPlan(A);
  const ins = async (table, rows) => {
    const out = [];
    for (let i = 0; i < rows.length; i += 500) {
      const { data, error } = await sb.from(table).insert(rows.slice(i, i + 500)).select();
      if (error) throw error;
      out.push(...data);
    }
    return out;
  };
  progress('Klanten aanmaken…');
  S.clients.push(...await ins('clients', plan.newClients.map(name => ({ name }))));
  const clientId = new Map(S.clients.map(c => [lc(c.name), c.id]));
  progress('Projecten aanmaken…');
  let ci = S.projects.length;
  S.projects.push(...await ins('projects', plan.newProjects.map(p => ({
    name: p.name, client_id: clientId.get(lc(p.client)) || null, billable: p.billable, color: PROJECT_COLORS[ci++ % PROJECT_COLORS.length],
    budget_hours: p.budget_hours ?? null, hourly_rate: p.hourly_rate ?? null
  }))));
  const projectId = new Map(S.projects.map(p => [lc(p.name) + '|' + lc(clientOf(p)?.name), p.id]));
  progress('Tags aanmaken…');
  S.tags.push(...await ins('tags', plan.newTags.map(name => ({ name }))));
  const tagId = new Map(S.tags.map(t => [lc(t.name), t.id]));

  const rows = A.entries.filter(e => A.map.get(e.ukey)).map(e => ({
    ...(A.map.get(e.ukey) === PENDING
      ? { user_id: null, import_email: lc(A.users.get(e.ukey).email), import_name: A.users.get(e.ukey).name }
      : { user_id: A.map.get(e.ukey) }),
    project_id: e.project ? projectId.get(lc(e.project) + '|' + lc(e.client)) || null : null,
    description: e.description, billable: e.billable, start_at: e.start.toISOString(), end_at: e.end.toISOString(),
    tag_ids: e.tags.map(t => tagId.get(lc(t))).filter(Boolean), source_ref: e.ref
  }));
  let added = 0;
  for (let i = 0; i < rows.length; i += 500) {
    progress(`Registraties importeren… ${i} / ${rows.length}`);
    const { data, error } = await sb.from('time_entries').upsert(rows.slice(i, i + 500), { onConflict: 'source_ref', ignoreDuplicates: true }).select('id');
    if (error) throw error;
    added += data.length;
  }
  return { added, skipped: rows.length - added };
}

init().catch(fail);
