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
  proj: { search: '', status: 'active', client: '', sort: 'name', dir: 1 },
  trk: { limit: 50, open: new Set() },
  dash: { from: null, to: null, group: 'project', who: 'me' }
};

// ---------- Kleine hulpjes ----------
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const isAdmin = () => S.me?.role === 'admin';
const byId = (list, id) => list.find(x => x.id === id);
const lc = v => String(v ?? '').trim().toLowerCase();
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
const DAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
// Engels zoals Clockify ("Tue, Sep 29"); numerieke datums als dd/mm/jjjj
const fmtDate = (d, opts) => d.toLocaleDateString(opts?.month === '2-digit' ? 'en-GB' : 'en-US', opts);
const fmtDayLong = d => {
  const today = startOfDay(new Date());
  if (sameDay(d, today)) return 'Today';
  if (sameDay(d, addDays(today, -1))) return 'Yesterday';
  return fmtDate(d, { weekday: 'short', month: 'short', day: 'numeric' });
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
const fmtDec = sec => (sec / 3600).toLocaleString('en-US', { maximumFractionDigits: 2 });

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
// Vroegere medewerkers (verwijderd in Clockify) heten "Former employee N" en krijgen nooit een account
const isFormer = e => /^deleteduser/i.test(e.import_email || '');
const entryUserName = e => profileOf(e.user_id)?.full_name || (isFormer(e) ? e.import_name : e.import_name || e.import_email ? `${e.import_name || e.import_email} (no account yet)` : '');
const clientOf = p => p ? byId(S.clients, p.client_id) : null;
const byName = (a, b) => a.name.localeCompare(b.name);
// Tags: enkel bewaren als schema-v2 uitgevoerd is (anders bestaat de kolom tag_ids nog niet)
const tagField = ids => S.tagsReady ? { tag_ids: ids || [] } : {};
const tagNames = ids => (ids || []).map(id => byId(S.tags, id)?.name).filter(Boolean);
const tagChips = ids => tagNames(ids).map(n => ` <span class="tag">${esc(n)}</span>`).join('');
const initials = name => (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
const userColor = id => PROJECT_COLORS[[...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % PROJECT_COLORS.length];
const avatar = p => `<span class="avatar" style="background:${userColor(p?.id)}" aria-hidden="true">${esc(initials(p?.full_name || p?.email))}</span>`;
const projLabel = p => p
  ? `<span class="proj"><span class="dot" style="background:${esc(p.color)}"></span>${esc(p.name)}${clientOf(p) ? `<span class="muted"> · ${esc(clientOf(p).name)}</span>` : ''}</span>`
  : `<span class="proj muted"><span class="dot" style="background:${NO_PROJECT_COLOR}"></span>No project</span>`;

function projectOptions(selected, { includeArchived = false, emptyLabel = 'No project' } = {}) {
  const list = S.projects.filter(p => includeArchived || !p.archived || p.id === selected);
  const groups = new Map();
  for (const p of list) {
    const c = clientOf(p)?.name || 'Without client';
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(p);
  }
  let html = `<option value="">${esc(emptyLabel)}</option>`;
  for (const [c, ps] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    html += `<optgroup label="${esc(c)}">` + ps.sort((a, b) => a.name.localeCompare(b.name))
      .map(p => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}${p.archived ? ' (archived)' : ''}</option>`).join('') + '</optgroup>';
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
  // Geïmporteerde uren met mijn (bevestigd) e-mailadres automatisch aan mij koppelen (schema-v5; zonder v5 gewoon overslaan)
  await sb.rpc('claim_my_entries').then(() => {}, () => {});
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
  app.innerHTML = '<div class="auth"><div class="muted">Loading…</div></div>';
  try {
    await loadBase();
    if (!S.me) throw new Error('No profile found. Was schema.sql run in Supabase?');
    if (!S.me.active) {
      app.innerHTML = `<div class="auth"><div class="card"><div class="brand">${LOGO}Polyfy</div><p>Your account has been deactivated. Please contact an admin.</p><button class="btn" id="lo">Log out</button></div></div>`;
      $('#lo').onclick = () => sb.auth.signOut();
      return;
    }
  } catch (err) {
    app.innerHTML = `<div class="auth"><div class="card"><div class="brand">${LOGO}Polyfy</div><div class="err">${esc(err.message)}</div><p><button class="btn" id="lo">Log out</button></p></div></div>`;
    $('#lo').onclick = () => sb.auth.signOut();
    return;
  }
  renderShell();
  route();
}

function renderSetup() {
  app.innerHTML = `<div class="setup card">
    <div class="brand">${LOGO}Polyfy</div>
    <h2>Not connected to Supabase yet</h2>
    <ol>
      <li>Create a project on <a href="https://supabase.com" target="_blank" rel="noopener">supabase.com</a>.</li>
      <li>Run <code>supabase/schema.sql</code> in the SQL Editor.</li>
      <li>Fill in <code>SUPABASE_URL</code> and <code>SUPABASE_ANON_KEY</code> in <code>config.js</code>.</li>
    </ol>
    <p class="muted">See <code>README.md</code> for all steps.</p>
  </div>`;
}

function renderAuth(mode, msg = null) {
  const titles = { login: 'Log in', signup: 'Sign up', forgot: 'Forgot password', reset: 'New password' };
  app.innerHTML = `<div class="auth"><div class="card">
    <div class="brand">${LOGO}Polyfy</div>
    <p class="muted" style="text-align:center;margin:0">${titles[mode]}</p>
    <form id="af">
      ${msg ? `<div class="${msg.ok ? 'ok' : 'err'}">${esc(msg.text)}</div>` : ''}
      ${mode === 'signup' ? '<label class="field">Name<input name="name" required autocomplete="name"></label>' : ''}
      ${mode !== 'reset' ? '<label class="field">Email<input name="email" type="email" required autocomplete="email"></label>' : ''}
      ${mode !== 'forgot' ? `<label class="field">${mode === 'reset' ? 'New password' : 'Password'}<input name="pw" type="password" required minlength="6" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}"></label>` : ''}
      <button class="btn primary" type="submit">${{ login: 'Log in', signup: 'Sign up', forgot: 'Send reset link', reset: 'Save' }[mode]}</button>
      <div class="row small" style="justify-content:space-between">
        ${mode === 'login' ? '<button type="button" class="linkbtn" data-m="signup">Sign up</button><button type="button" class="linkbtn" data-m="forgot">Forgot password?</button>' : ''}
        ${mode === 'signup' || mode === 'forgot' ? '<button type="button" class="linkbtn" data-m="login">Back to log in</button>' : ''}
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
        if (dom && !email.toLowerCase().endsWith('@' + dom)) throw new Error(`Please use your @${dom} email address.`);
        const { data, error } = await sb.auth.signUp({ email, password: f.get('pw'), options: { data: { full_name: f.get('name') }, emailRedirectTo: location.origin + location.pathname } });
        if (error) throw error;
        if (!data.session) renderAuth('login', { ok: true, text: 'Check your inbox to confirm your account.' });
      } else if (mode === 'forgot') {
        const { error } = await sb.auth.resetPasswordForEmail(f.get('email'), { redirectTo: location.origin + location.pathname });
        if (error) throw error;
        renderAuth('login', { ok: true, text: 'If this address exists, you will receive an email with a reset link.' });
      } else if (mode === 'reset') {
        const { error } = await sb.auth.updateUser({ password: f.get('pw') });
        if (error) throw error;
        S.recovery = false; history.replaceState(null, '', location.pathname);
        start();
      }
    } catch (err) {
      renderAuth(mode, { text: err.message === 'Invalid login credentials' ? 'Incorrect email or password.' : err.message });
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
  ['projects', 'Projects', 'proj', 'Manage'], ['team', 'Team', 'team'], ['clients', 'Clients', 'client'], ['tags', 'Tags', 'tag']
];
const navItems = () => NAV;
const DEFAULT_VIEW = 'tracker';

function renderShell() {
  app.innerHTML = `<div class="shell" id="shell">
    <header class="topbar">
      <button class="btn icon ghost nav-toggle" id="nav-toggle" aria-label="Menu">${icon('menu')}</button>
      <div class="brand">${LOGO}<span>Polyfy</span></div>
      <span class="ws">POLYGON</span>
      <button class="me" id="me-btn" title="${esc(S.me.full_name || S.me.email)} · Profile settings" aria-label="Profile settings">${avatar(S.me)}</button>
    </header>
    <aside class="side">
      <nav class="nav">${navItems().map(([k, l, i, sec]) => `${sec ? `<div class="nav-sec">${sec}</div>` : ''}<a href="#${k}" data-nav="${k}">${icon(i)}<span>${l}</span>${k === 'tracker' ? '<span class="nav-clock num" id="nav-clock"></span>' : ''}</a>`).join('')}</nav>
    </aside>
    <div class="main">
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
     projects: renderProjects, team: renderTeam, clients: renderClients, tags: renderTags })[S.view](page)
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
    <input class="desc" id="t-desc" placeholder="What have you worked on?" value="${esc(cur.description)}" aria-label="Description">
    <button class="btn ghost projbtn" id="t-proj" title="Project">${projBtnHtml(cur.project_id)}</button>
    ${S.tagsReady ? `<button class="btn ghost tagbtn" id="t-tags" title="Tags">${tagBtnHtml(cur.tag_ids)}</button>` : ''}
    <button class="billable-toggle ${cur.billable ? 'on' : ''}" id="t-bill" title="Billable" aria-pressed="${!!cur.billable}">€</button>
    ${man ? `<span class="tb-times"><input class="hm num" id="t-start" value="${manual.start}" aria-label="Start" inputmode="numeric"><span class="muted">–</span><input class="hm num" id="t-end" value="${manual.end}" aria-label="End" inputmode="numeric"><input type="date" id="t-date" value="${manual.date}" aria-label="Date"></span>
        <input class="clock num tb-dur" id="t-dur" aria-label="Duration">
        <button class="btn start" id="t-add">Add</button>`
      : `<span class="clock num" id="t-clock">${fmtHMS(r ? entrySec(r) : 0)}</span>
        <button class="btn ${r ? 'stop' : 'start'}" id="t-go">${r ? 'Stop' : 'Start'}</button>`}
    <div class="modes"><button class="${man ? '' : 'on'}" data-mode="timer" title="Timer mode" aria-label="Timer mode">${icon('clock')}</button><button class="${man ? 'on' : ''}" data-mode="manual" title="Manual mode" aria-label="Manual mode">${icon('list')}</button></div>`;

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
    if (sec == null || sec > 24 * 3600) { toast('Enter a duration like 1:30 or 1.5 (max. 24 hours).', true); return showDur(); }
    const { s } = times(); $('#t-end').value = hm(new Date(s.getTime() + sec * 1000)); keep(); showDur();
  };
  $('#t-dur').onkeydown = e => { if (e.key === 'Enter') e.target.blur(); };
  $('#t-add').onclick = addManual;
  showDur();

  async function addManual() {
    const { s, e } = times();
    if (e - s < 60000) return toast('Enter a start and end time.', true);
    const { error } = await sb.from('time_entries').insert({
      user_id: S.me.id, description: desc.value.trim(), project_id: cur.project_id || null, billable: bill.classList.contains('on'),
      start_at: s.toISOString(), end_at: e.toISOString(), ...tagField(draft.tag_ids)
    });
    if (error) return fail(error);
    draft = { description: '', project_id: '', billable: true, tag_ids: [] };
    manual = { date: manual.date, start: hm(e), end: hm(e) };
    toast('Time entry added'); renderTimer(); refreshPage();
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
function pickFrom(anchor, items, current, onPick, { placeholder = 'Search…', emptyLabel = null, cls = '' } = {}) {
  openMenu(anchor, `<input placeholder="${esc(placeholder)}" aria-label="Search"><div class="list"></div>`, m => {
    const inp = $('input', m), list = $('.list', m);
    const draw = () => {
      const q = inp.value.trim().toLowerCase();
      const hits = items.filter(x => !q || (x.label + ' ' + (x.group || '')).toLowerCase().includes(q));
      let html = emptyLabel && !q ? `<button class="mi ${!current ? 'on' : ''}" data-v="">${esc(emptyLabel)}</button>` : '', grp = null;
      for (const x of hits) {
        if (x.group !== undefined && x.group !== grp) { grp = x.group; html += `<div class="mh">${esc(grp)}</div>`; }
        html += `<button class="mi ${x.id === current ? 'on' : ''}" data-v="${esc(x.id)}">${x.dot ? `<span class="dot" style="background:${esc(x.dot)}"></span>` : ''}${esc(x.label)}${x.extra ? ` <span class="muted">${esc(x.extra)}</span>` : ''}</button>`;
      }
      list.innerHTML = html || '<div class="muted small" style="padding:6px 8px">No results.</div>';
      $$('[data-v]', list).forEach(b => b.onclick = () => { closeMenu(); onPick(b.dataset.v || null); });
    };
    inp.oninput = draw; draw();
  }, cls);
}
// Project kiezen, gegroepeerd per klant (zoals Clockify)
function pickProject(anchor, current, onPick, { emptyLabel = 'No project', includeArchived = false } = {}) {
  const items = S.projects.filter(p => includeArchived || !p.archived || p.id === current)
    .map(p => ({ id: p.id, label: p.name, dot: p.color, group: clientOf(p)?.name || 'Without client', extra: p.archived ? '(archived)' : '' }))
    .sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label));
  pickFrom(anchor, items, current, onPick, { placeholder: 'Search project or client', emptyLabel, cls: 'wide' });
}

// ---------- Periodekiezer (zoals "This week" met vorige/volgende) ----------
const RANGES = [['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'This week'], ['lastweek', 'Last week'], ['month', 'This month'], ['lastmonth', 'Last month'], ['year', 'This year'], ['lastyear', 'Last year']];
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
    : `${fmtDate(a, { day: 'numeric', month: 'short' })} - ${fmtDate(last, { day: 'numeric', month: 'short', year: 'numeric' })}`;
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
const rangeHtml = (a, b) => `<div class="range"><button class="btn rlbl" data-r="pick">${icon('cal')}<span>${esc(rangeLabel(a, b))}</span></button><button class="btn icon" data-r="-1" aria-label="Previous period">${icon('left')}</button><button class="btn icon" data-r="1" aria-label="Next period">${icon('right')}</button></div>`;
function bindRange(root, a, b, set) {
  $$('.range [data-r]', root).forEach(btn => btn.onclick = () => {
    if (btn.dataset.r !== 'pick') return set(...shiftRange(a, b, Number(btn.dataset.r)));
    openMenu(btn, `${RANGES.map(([k, l]) => `<button class="mi" data-k="${k}">${l}</button>`).join('')}
      <div class="mh">Custom</div>
      <div class="row" style="padding:2px 8px;flex-wrap:nowrap"><input type="date" id="rg-a" value="${ymd(a)}" aria-label="From"><input type="date" id="rg-b" value="${ymd(addDays(b, -1))}" aria-label="To"></div>
      <div style="padding:6px 8px"><button class="btn primary" id="rg-ok" style="width:100%">Apply</button></div>`, m => {
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
  pop.innerHTML = '<input placeholder="Add/Search tags" aria-label="Search tags"><div class="list"></div>';
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
      + (q && !S.tags.some(t => t.name.toLowerCase() === q) ? `<button type="button" class="btn ghost" data-new>${icon('plus')}Create tag "${esc(inp.value.trim())}"</button>` : '')
      + (!tags.length && !q ? '<div class="muted small">No tags yet. Type to create one.</div>' : '');
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
    <div class="modal-head"><h2>${esc(title)}</h2><button class="btn icon ghost" data-close aria-label="Close">${icon('x')}</button></div>
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
  const m = openModal(entry ? 'Edit time entry' : 'Add time entry', `
    <label class="field">Description<input id="m-desc" value="${esc(e.description)}" placeholder="What have you worked on?"></label>
    <div class="field">Project<button type="button" class="btn projbtn mproj" id="m-proj">${projBtnHtml(e.project_id)}</button></div>
    ${S.tagsReady ? `<div class="field">Tags<button type="button" class="btn tagbtn" id="m-tags" style="justify-content:flex-start">${tagBtnHtml(tagIds)}</button></div>` : ''}
    ${canEditUser ? `<label class="field">Team member<select id="m-user">${S.profiles.filter(p => p.active).map(p => `<option value="${p.id}" ${p.id === e.user_id ? 'selected' : ''}>${esc(p.full_name || p.email)}</option>`).join('')}</select></label>` : ''}
    <div class="grid2">
      <label class="field">Date<input type="date" id="m-date" value="${ymd(st)}" required></label>
      <div class="grid2" style="gap:8px">
        <label class="field">Start<input class="num" id="m-start" value="${hm(st)}" inputmode="numeric" required></label>
        <label class="field">End${running ? '<input disabled value="running">' : `<input class="num" id="m-end" value="${en ? hm(en) : ''}" inputmode="numeric" required>`}</label>
      </div>
    </div>
    <div class="row" style="justify-content:space-between">
      <label class="check"><input type="checkbox" id="m-bill" ${e.billable ? 'checked' : ''}> Billable</label>
      <span class="muted">Duration: <b class="num" id="m-dur">–</b></span>
    </div>`,
    `<div>${entry ? `<button class="btn danger" id="m-del">${icon('trash')}Delete</button>` : ''}</div>
     <div class="row"><button class="btn" data-close>Cancel</button><button class="btn primary" id="m-save">Save</button></div>`);

  const times = () => {
    const day = parseYmd($('#m-date').value || ymd(st));
    const [sh, sm] = parseHM($('#m-start').value) || [0, 0];
    const s = new Date(day); s.setHours(sh, sm, 0, 0);
    if (running) return { s, en: null };
    const [eh, em] = parseHM($('#m-end').value) || [0, 0];
    let en2 = new Date(day); en2.setHours(eh, em, 0, 0);
    if (en2 <= s) en2 = addDays(en2, 1); // eindigt na middernacht
    return { s, en: en2 };
  };
  const upd = () => { const { s, en: x } = times(); $('#m-dur').textContent = fmtHM(((x || new Date()) - s) / 1000); };
  $$('#m-date,#m-start,#m-end', m).forEach(i => i.addEventListener('input', upd)); upd();
  // Project kiezen met zoekfunctie (zelfde lijst als in de Time Tracker)
  let projId = e.project_id || null;
  $('#m-proj').onclick = () => pickProject($('#m-proj'), projId, pid => {
    projId = pid; $('#m-proj').innerHTML = projBtnHtml(pid);
    const p = byId(S.projects, pid); if (p) $('#m-bill').checked = p.billable;
  });
  if (S.tagsReady) bindTagPicker($('#m-tags'), () => tagIds, ids => { tagIds = ids; });

  $('#m-save').onclick = async () => {
    const { s, en: x } = times();
    if (x && x - s > 24 * 3600000) return toast('A time entry can be at most 24 hours long.', true);
    const row = {
      description: $('#m-desc').value.trim(), project_id: projId,
      billable: $('#m-bill').checked, start_at: s.toISOString(), ...tagField(tagIds)
    };
    if (!running) row.end_at = x.toISOString();
    if (canEditUser) row.user_id = $('#m-user').value; else if (!entry) row.user_id = S.me.id;
    const q = entry ? sb.from('time_entries').update(row).eq('id', entry.id) : sb.from('time_entries').insert(row);
    const { error } = await q;
    if (error) return fail(error);
    closeModal(); toast(entry ? 'Time entry updated' : 'Time entry added');
    if (running) { S.running = { ...S.running, ...row }; renderTimer(); }
    refreshPage();
  };
  if (entry) $('#m-del').onclick = () => deleteEntry(entry);
}

async function deleteEntry(entry) {
  if (!confirm('Delete this time entry?')) return;
  const { error } = await sb.from('time_entries').delete().eq('id', entry.id);
  if (error) return fail(error);
  if (S.running?.id === entry.id) { S.running = null; renderTimer(); }
  closeModal(); toast('Time entry deleted'); refreshPage();
}

function openProfileModal() {
  const theme = applyTheme();
  const m = openModal('Profile settings', `
    <div class="row">${avatar(S.me)}<div><div style="font-weight:600">${esc(S.me.email)}</div><div class="muted small">${isAdmin() ? 'Admin' : 'Member'}</div></div></div>
    <label class="field">Name<input id="p-name" value="${esc(S.me.full_name)}"></label>
    <label class="field">New password <span class="muted">(leave empty to keep the current one)</span><input id="p-pw" type="password" minlength="6" autocomplete="new-password"></label>
    <div class="field">Theme<div class="seg" id="p-theme">${[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']].map(([k, l]) => `<button type="button" data-t="${k}" class="${theme === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>`,
    `<button class="btn" id="p-out">${icon('logout')}Log out</button><div class="row"><button class="btn" data-close>Cancel</button><button class="btn primary" id="p-save">Save</button></div>`);
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
      closeModal(); toast('Profile saved'); renderShell(); route();
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
function barChart(el, data, { height = 220, showValues = true, color = 'var(--bar)' } = {}) {
  const draw = () => {
    const W = el.clientWidth || 600, H = height;
    const padL = 36, padR = 8, padT = 18, padB = 26;
    const iw = W - padL - padR, ih = H - padT - padB;
    const max = niceMax(Math.max(...data.map(d => d.value)));
    const ticks = 4, band = iw / data.length;
    const bw = Math.max(4, Math.min(44, band * 0.62));
    const labelEvery = Math.ceil(data.length / Math.max(1, Math.floor(iw / 44)));
    let s = `<svg width="${W}" height="${H}" role="img" aria-label="Bar chart of tracked time">`;
    for (let i = 0; i <= ticks; i++) {
      const y = padT + ih - (ih * i) / ticks;
      s += `<line class="${i === 0 ? 'baseline' : 'gridline'}" x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}"/>`;
      s += `<g class="axis"><text x="${padL - 6}" y="${y + 4}" text-anchor="end">${(max * i / ticks).toLocaleString('en-US')}h</text></g>`;
    }
    data.forEach((d, i) => {
      const cx = padL + band * i + band / 2;
      const h = max ? (d.value / max) * ih : 0;
      const x = cx - bw / 2, y = padT + ih - h, r = Math.min(4, h, bw / 2);
      if (d.segs && h > 0.5) {
        // Gestapeld: segmenten van onder naar boven, met een dun wit randje ertussen
        let yb = padT + ih;
        for (const g of d.segs) { const sh = max ? g.value / max * ih : 0; if (sh < 0.3) continue; s += `<rect x="${x}" y="${yb - sh}" width="${bw}" height="${sh}" fill="${esc(g.color)}" stroke="var(--surface)" stroke-width="1"/>`; yb -= sh; }
      } else if (h > 0.5) s += `<path class="bar" fill="${color}" d="M${x},${padT + ih} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${padT + ih} Z"/>`;
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
  return `<svg class="donut" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="Distribution">
    <circle r="${R}" cx="${size / 2}" cy="${size / 2}" fill="none" stroke="var(--grid)" stroke-width="${w}"/>${segs}
    <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" class="donut-t">${fmtHMS(total)}</text></svg>`;
}

// Kleur per groep: projecten hun eigen kleur, andere groepen uit de vaste lijst
const groupColor = (group, k, i) => group === 'project' ? (byId(S.projects, k)?.color || NO_PROJECT_COLOR) : k ? PROJECT_COLORS[i % PROJECT_COLORS.length] : NO_PROJECT_COLOR;

// Emmers voor grafieken: per dag (≤ 31 dagen), per week (≤ 120) of per maand
function buckets(from, to) {
  const days = Math.round((to - from) / DAY_MS), out = [];
  if (days <= 31) for (let i = 0; i < days; i++) { const d = addDays(from, i); out.push({ a: d, b: addDays(d, 1), label: days <= 7 ? fmtDate(d, { weekday: 'short', month: 'short', day: 'numeric' }) : String(d.getDate()), tip: fmtDate(d, { weekday: 'long', month: 'long', day: 'numeric' }) }); }
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
  const wk0 = startOfWeek(new Date());
  // Zoals Clockify: altijd de meest recente registraties (hoe oud ook), per 50 bijladen
  const { data, error } = await sb.from('time_entries').select('*').eq('user_id', S.me.id).order('start_at', { ascending: false }).limit(S.trk.limit + 1);
  if (error) throw error;
  if (S.view !== 'tracker') return;
  const more = data.length > S.trk.limit, entries = data.slice(0, S.trk.limit);
  // Gelijke registraties op dezelfde dag worden gegroepeerd (zoals Clockify)
  const gkey = e => [ymd(entryStart(e)), e.description.trim().toLowerCase(), e.project_id || '', [...(e.tag_ids || [])].sort().join(','), e.billable].join('|');
  const groups = new Map();
  for (const e of [...entries].sort((x, y) => entryStart(y) - entryStart(x))) {
    const k = gkey(e); if (!groups.has(k)) groups.set(k, { key: k, items: [] }); groups.get(k).items.push(e);
  }
  const blocks = [];
  const weekStarts = [...new Set(entries.map(e => +startOfWeek(entryStart(e))))].sort((x, y) => y - x).map(t => new Date(t));
  for (const a of weekStarts) {
    const b = addDays(a, 7), i = Math.round((wk0 - a) / (7 * DAY_MS));
    const wkEntries = entries.filter(e => entryStart(e) >= a && entryStart(e) < b);
    const label = i === 0 ? 'This week' : i === 1 ? 'Last week' : `${fmtDate(a, { month: 'short', day: 'numeric' })} - ${fmtDate(addDays(a, 6), { month: 'short', day: 'numeric' })}`;
    let html = `<div class="wk-head"><span>${esc(label)}</span><span class="muted small">Week total: <b class="wk-tot num">${fmtHMS(wkEntries.reduce((t, e) => t + entrySec(e), 0))}</b></span></div>`;
    for (let d = 6; d >= 0; d--) {
      const day = addDays(a, d), dayGroups = [...groups.values()].filter(g => sameDay(entryStart(g.items[0]), day));
      if (!dayGroups.length) continue;
      const dayTot = dayGroups.reduce((t, g) => t + g.items.reduce((u, e) => u + entrySec(e), 0), 0);
      html += `<div class="card tday"><div class="tday-head"><span>${esc(fmtDayLong(day))}</span><span class="muted small">Total: <b class="num">${fmtHMS(dayTot)}</b></span></div>
        ${dayGroups.map(g => trackRow(g) + (g.items.length > 1 && S.trk.open.has(g.key) ? g.items.map(e => trackRow({ key: g.key, items: [e] }, true)).join('') : '')).join('')}</div>`;
    }
    blocks.push(html);
  }
  page.innerHTML = `
    <div class="timerbar card" id="timerbar"></div>
    ${blocks.join('') || '<div class="card empty">No time entries yet. Start the timer or add time manually.</div>'}
    ${more ? '<div class="row" style="justify-content:center"><button class="btn" id="trk-more">Load more</button></div>' : ''}`;
  renderTimer();
  bindTrackRows(page, groups, entries);
  if ($('#trk-more')) $('#trk-more').onclick = () => { S.trk.limit += 50; refreshPage(); };
}

function trackRow(g, child = false) {
  const e = g.items[0], multi = g.items.length > 1 && !child, running = !e.end_at;
  const sec = g.items.reduce((t, x) => t + entrySec(x), 0);
  const first = new Date(Math.min(...g.items.map(entryStart))), last = new Date(Math.max(...g.items.map(entryEnd)));
  const tags = tagNames(e.tag_ids);
  return `<div class="te ${child ? 'child' : ''}" data-g="${esc(g.key)}" ${multi ? '' : `data-id="${e.id}"`}>
    <span class="te-cnt">${multi ? `<button class="cnt ${S.trk.open.has(g.key) ? 'on' : ''}" data-act="toggle" title="${g.items.length} time entries">${g.items.length}</button>` : ''}</span>
    <input class="te-desc" data-act="desc" value="${esc(e.description)}" placeholder="Add description" aria-label="Description">
    <button class="te-proj" data-act="proj">${projBtnHtml(e.project_id)}</button>
    ${S.tagsReady ? `<button class="te-tags ${tags.length ? 'on' : ''}" data-act="tags" title="Tags">${tags.length ? tags.map(t => `<span class="tag t-blue">${esc(t)}</span>`).join('') : icon('tag')}</button>` : ''}
    <button class="te-bill ${e.billable ? 'on' : ''}" data-act="bill" title="Billable">€</button>
    <span class="te-times num">${multi ? `<span class="muted">${hm(first)} – ${e.end_at ? hm(last) : 'now'}</span>`
      : `<input class="num" data-act="start" value="${hm(entryStart(e))}" aria-label="Start" inputmode="numeric"><span class="muted">–</span>${running ? '<span class="muted">now</span>' : `<input class="num" data-act="end" value="${hm(entryEnd(e))}" aria-label="End" inputmode="numeric">`}`}</span>
    ${multi ? '<span class="te-ico"></span>' : `<button class="btn icon ghost te-ico" data-act="date" title="Change date" aria-label="Change date">${icon('cal')}</button>`}
    <span class="te-dur num">${running && !multi ? '<span class="tag live">running</span>' : fmtHMS(sec)}</span>
    <button class="btn icon ghost" data-act="play" title="Continue timer for this activity" aria-label="Continue">${icon('play')}</button>
    <button class="btn icon ghost" data-act="more" title="More" aria-label="More">${icon('dots')}</button>
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
        const t = parseHM(el.value); if (!t) { toast('Enter a time like 9:30 or 0930.', true); return refreshPage(); }
        const [h, m] = t;
        const base = startOfDay(entryStart(e)), s = act === 'start' ? new Date(base.setHours(h, m)) : entryStart(e);
        let en = act === 'end' ? new Date(new Date(startOfDay(entryStart(e))).setHours(h, m)) : e.end_at ? entryEnd(e) : null;
        if (en && en <= s) en = addDays(en, 1);
        if (en && en - s > 24 * 3600000) { toast('A time entry can be at most 24 hours long.', true); return refreshPage(); }
        save({ start_at: s.toISOString(), ...(en ? { end_at: en.toISOString() } : {}) });
      };
      if (act === 'date') el.onclick = () => openMenu(el, `<div style="padding:6px 8px"><input type="date" value="${ymd(entryStart(e))}" aria-label="Date"></div>`, m => {
        $('input', m).onchange = ev => {
          const d = parseYmd(ev.target.value), shift = startOfDay(d) - startOfDay(entryStart(e));
          closeMenu(); save({ start_at: new Date(entryStart(e).getTime() + shift).toISOString(), ...(e.end_at ? { end_at: new Date(entryEnd(e).getTime() + shift).toISOString() } : {}) });
        };
      });
      if (act === 'play') el.onclick = () => startTimer(e);
      if (act === 'more') el.onclick = () => openMenu(el, items.length > 1
        ? `<button class="mi" data-m="open">${S.trk.open.has(g.key) ? 'Collapse' : 'Expand'}</button><button class="mi danger" data-m="del">Delete all ${items.length}</button>`
        : `<button class="mi" data-m="edit">Edit</button><button class="mi" data-m="dup">Duplicate</button><button class="mi danger" data-m="del">Delete</button>`, m => {
        $$('[data-m]', m).forEach(x => x.onclick = async () => {
          closeMenu();
          if (x.dataset.m === 'open') { S.trk.open.has(g.key) ? S.trk.open.delete(g.key) : S.trk.open.add(g.key); return refreshPage(); }
          if (x.dataset.m === 'edit') return openEntryModal(e);
          if (x.dataset.m === 'dup') {
            if (!e.end_at) return toast('A running timer cannot be duplicated.', true);
            const { error } = await sb.from('time_entries').insert({ user_id: e.user_id, description: e.description, project_id: e.project_id, billable: e.billable, start_at: e.start_at, end_at: e.end_at, ...tagField(e.tag_ids) });
            if (error) return fail(error);
            toast('Time entry duplicated'); return refreshPage();
          }
          if (!confirm(items.length > 1 ? `Delete these ${items.length} time entries?` : 'Delete this time entry?')) return;
          const { error } = await sb.from('time_entries').delete().in('id', ids);
          if (error) return fail(error);
          if (S.running && ids.includes(S.running.id)) { S.running = null; renderTimer(); }
          toast('Deleted'); refreshPage();
        });
      });
    });
  });
}

// =====================================================================
// Dashboard (zoals Clockify: totaal, topproject/-klant, staven per dag, ring, top-activiteiten)
// =====================================================================
const DASH_GROUPS = [['project', 'Project'], ['client', 'Client'], ['tag', 'Tag'], ['user', 'User']];
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
        <select id="d-group" aria-label="Group by">${DASH_GROUPS.filter(g => team || g[0] !== 'user').map(([k, l]) => `<option value="${k}" ${D.group === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        ${isAdmin() ? `<select id="d-who" aria-label="Who"><option value="me">Only me</option><option value="team" ${team ? 'selected' : ''}>Team</option></select>` : ''}
        ${rangeHtml(D.from, D.to)}
      </div>
    </div>
    <div class="dash">
      <div class="card">
        <div class="kpis">
          <div><div class="label">Total time</div><div class="v num">${fmtHMS(total)}</div></div>
          <div><div class="label">Top project</div><div class="v sm">${topP ? esc(groupText(topP, 'project')) : '–'}</div></div>
          <div><div class="label">Top client</div><div class="v sm">${topC ? esc(groupText(topC, 'client')) : '–'}</div></div>
        </div>
        <div class="card-body"><div class="chart" id="d-chart"></div></div>
        <div class="dash-split">
          <div class="donut-wrap">${donut(rows, total)}</div>
          <div class="dlist">${rows.length ? rows.slice(0, 12).map(r => `
            <div class="drow" data-tip="<b>${esc(r.name)}</b><br>${fmtHMS(r.sec)}">
              <span class="dn">${esc(r.name)}</span><span class="num">${fmtHMS(r.sec)}</span>
              <span class="track"><span style="width:${total ? r.sec / rows[0].sec * 100 : 0}%;background:${esc(r.color)}"></span></span>
              <span class="num muted">${total ? (r.sec / total * 100).toFixed(2) : 0}%</span>
            </div>`).join('') : '<div class="empty">No time tracked in this period.</div>'}</div>
        </div>
      </div>
      <div class="card side-list">
        <div class="card-head"><h2>Most tracked activities</h2><span class="muted small">Top 10</span></div>
        ${top.length ? top.map(a => `<div class="act"><div class="desc"><div>${a.e.description ? esc(a.e.description) : '<span class="muted">(no description)</span>'}</div><div class="small">${projLabel(projectOf(a.e))}</div></div><span class="num">${fmtHMS(a.sec)}</span></div>`).join('') : '<div class="empty">Nothing yet.</div>'}
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
      <div class="row"><h1>Calendar</h1><div class="seg" id="c-mode"><button data-m="week" class="${nd === 7 ? 'on' : ''}">Week</button><button data-m="day" class="${nd === 1 ? 'on' : ''}">Day</button></div></div>
      <div class="row">
        <div class="seg" id="c-zoom"><button data-z="-12" aria-label="Zoom out" ${HP <= 24 ? 'disabled' : ''}>−</button><button data-z="12" aria-label="Zoom in" ${HP >= 96 ? 'disabled' : ''}>+</button></div>
        ${isAdmin() ? `<button class="btn" id="c-user">${avatar(who)}<span>${esc(uid === S.me.id ? 'Me' : who?.full_name || who?.email || '')}</span>${icon('down')}</button>` : ''}
        ${rangeHtml(from, to)}
      </div>
    </div>
    <div class="card cal" style="--cols:${nd}">
      <div class="cal-dayhead" style="border-left:0"></div>
      ${daily.map((sec, i) => { const d = addDays(from, i); return `<div class="cal-dayhead ${sameDay(d, today) ? 'today' : ''}"><div class="dn">${esc(fmtDate(d, { weekday: 'short', month: 'short', day: 'numeric' }))}</div><div class="tot num">${fmtHMS(sec)}</div></div>`; }).join('')}
      <div class="cal-scroll" id="cal-scroll">
        <div class="cal-hours">${Array.from({ length: 24 }, (_, h) => `<div style="height:${HP}px">${h ? pad(h) + ':00' : ''}</div>`).join('')}</div>
        ${daily.map((_, i) => `<div class="cal-col ${sameDay(addDays(from, i), today) ? 'today' : ''}" data-day="${i}" style="height:${24 * HP}px;--hp:${HP}px"></div>`).join('')}
      </div>
    </div>
    <div class="muted small">Click or drag in an empty slot to add time, drag a block to move it, drag its bottom edge to make it longer or shorter, click a block to edit it.</div>`;

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
      const drag = g.e.end_at && +g.s === +entryStart(g.e) && +g.t === +entryEnd(g.e) && (isAdmin() || g.e.user_id === S.me.id);
      return `<div class="cal-ev ${g.e.end_at ? '' : 'running'}" data-id="${g.e.id}" ${drag ? 'data-drag="1"' : ''} style="top:${top}px;height:${h}px;left:calc(${g.col * w}% + 2px);width:calc(${w}% - 4px);background:color-mix(in srgb, ${color} 18%, var(--surface));border-left:3px solid ${color}"
        data-tip="<b>${esc(g.e.description || '(no description)')}</b><br>${esc(p?.name || 'No project')}${tagNames(g.e.tag_ids).length ? '<br>' + esc(tagNames(g.e.tag_ids).join(', ')) : ''}<br>${hm(entryStart(g.e))} – ${g.e.end_at ? hm(entryEnd(g.e)) : 'now'} · ${fmtHMS(entrySec(g.e))}">
        <div class="t">${esc(g.e.description || p?.name || '(no description)')}</div>
        ${h > 34 ? `<div class="s">${esc(g.e.description ? p?.name || 'No project' : clientOf(p)?.name || '')} · ${fmtHM((g.t - g.s) / 1000)}</div>` : ''}
        ${drag ? '<div class="rz" title="Drag to change the end time"></div>' : ''}
      </div>`;
    }).join('');
    if (sameDay(d0, today)) {
      const now = new Date();
      col.insertAdjacentHTML('beforeend', `<div class="now-line" style="top:${(now - d0) / 3600000 * HP}px"></div>`);
    }
  });

  const sc = $('#cal-scroll');
  bindCalendarDrag(sc, entries, from, HP, uid);
  const firstHour = entries.length ? Math.min(...entries.map(e => new Date(Math.max(from, entryStart(e))).getHours())) : 8;
  sc.scrollTop = Math.max(0, Math.min(8, firstHour) * HP - 8);

  $$('#c-mode button').forEach(b => b.onclick = () => {
    C.mode = b.dataset.m;
    C.from = C.mode === 'day' ? (today >= from && today < to ? today : from) : startOfWeek(from);
    refreshPage();
  });
  $$('#c-zoom button').forEach(b => b.onclick = () => { C.zoom = Math.min(96, Math.max(24, HP + Number(b.dataset.z))); refreshPage(); });
  bindRange(page, from, to, a => { C.from = C.mode === 'day' ? a : startOfWeek(a); refreshPage(); });
  if ($('#c-user')) $('#c-user').onclick = () => pickFrom($('#c-user'), S.profiles.filter(p => p.active).map(p => ({ id: p.id, label: p.full_name || p.email, extra: p.id === S.me.id ? '(you)' : '' })), uid,
    v => { C.user = v || S.me.id; refreshPage(); }, { placeholder: 'Search teammates' });
}

// Slepen in de Calendar (zoals Clockify), per kwartier:
// - leeg vak: klik = blok van 1 uur, klik + sleep = blok van die tijd
// - blok: klik = bewerken, slepen = verplaatsen (ook naar een andere dag), onderrand slepen = langer/korter
function bindCalendarDrag(sc, entries, from, HP, uid) {
  const Q = 15, cols = $$('.cal-col', sc);
  const snap = min => Math.round(min / Q) * Q;
  const colIndexAt = x => cols.findIndex(c => { const r = c.getBoundingClientRect(); return x >= r.left && x < r.right; });
  const minAt = (col, y) => Math.max(0, Math.min(24 * 60, (y - col.getBoundingClientRect().top) / HP * 60));
  const atMin = (day, min) => { const d = addDays(from, day); d.setHours(0, min, 0, 0); return d; };
  const save = async (e, start, end) => {
    if (end - start > 24 * 3600000) { toast('A time entry can be at most 24 hours long.', true); return refreshPage(); }
    const { error } = await sb.from('time_entries').update({ start_at: start.toISOString(), end_at: end.toISOString() }).eq('id', e.id);
    if (error) fail(error); else toast('Time entry updated');
    refreshPage();
  };

  sc.addEventListener('pointerdown', ev => {
    if (ev.button !== 0) return;
    const col = ev.target.closest('.cal-col'); if (!col) return;
    const evEl = ev.target.closest('.cal-ev'), day0 = cols.indexOf(col);
    const entry = evEl && entries.find(x => x.id === evEl.dataset.id);
    const touch = ev.pointerType === 'touch';  // op gsm: tikken = klikken, slepen = scrollen
    const mode = evEl ? (!touch && evEl.dataset.drag ? (ev.target.classList.contains('rz') ? 'resize' : 'move') : 'click') : (touch ? 'click' : 'create');
    const m0 = minAt(col, ev.clientY);
    const orig = evEl && { top: evEl.offsetTop, h: evEl.offsetHeight, parent: evEl.parentElement, left: evEl.style.left, width: evEl.style.width };
    let moved = false, ghost = null, dMin = 0, dDay = 0, c0 = snap(m0), c1 = c0;
    if (!touch) ev.preventDefault();

    const onMove = mv => {
      if (!moved && Math.hypot(mv.clientX - ev.clientX, mv.clientY - ev.clientY) < 5) return;
      moved = true;
      if (mode === 'click') return;
      if (mode === 'create') {
        const m1 = minAt(col, mv.clientY);
        c0 = snap(Math.min(m0, m1)); c1 = Math.max(c0 + Q, snap(Math.max(m0, m1)));
        if (!ghost) { ghost = document.createElement('div'); ghost.className = 'cal-ev ghost'; col.appendChild(ghost); }
        ghost.style.top = c0 / 60 * HP + 'px'; ghost.style.height = (c1 - c0) / 60 * HP + 'px';
        ghost.textContent = `${pad(Math.floor(c0 / 60))}:${pad(c0 % 60)} – ${pad(Math.floor(c1 / 60) % 24)}:${pad(c1 % 60)}`;
        return;
      }
      dMin = snap((mv.clientY - ev.clientY) / HP * 60);
      if (mode === 'resize') {
        const minLen = Q / 60 * HP;
        evEl.style.height = Math.max(minLen, orig.h + dMin / 60 * HP) + 'px';
        return;
      }
      const ci = colIndexAt(mv.clientX); dDay = ci < 0 ? dDay : ci - day0;
      const target = cols[day0 + dDay] || orig.parent;
      if (evEl.parentElement !== target) { target.appendChild(evEl); evEl.style.left = '2px'; evEl.style.width = 'calc(100% - 4px)'; }
      evEl.style.top = orig.top + dMin / 60 * HP + 'px';
      evEl.classList.add('dragging');
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
      if (!moved || mode === 'click') {
        if (moved) return;  // bv. scrollen op gsm
        if (entry) return openEntryModal(entry);
        const st = atMin(day0, Math.floor(m0 / Q) * Q);
        return openEntryModal(null, { start: st.getTime(), end: st.getTime() + 3600000, user_id: uid });
      }
      if (mode === 'create') {
        ghost?.remove();
        return openEntryModal(null, { start: atMin(day0, c0).getTime(), end: atMin(day0, c1).getTime(), user_id: uid });
      }
      const s0 = entryStart(entry), e0 = entryEnd(entry);
      if (mode === 'resize') return save(entry, s0, new Date(Math.max(s0.getTime() + Q * 60000, e0.getTime() + dMin * 60000)));
      if (!dMin && !dDay) return refreshPage();
      const ns = addDays(s0, dDay); ns.setMinutes(ns.getMinutes() + dMin);
      save(entry, ns, new Date(ns.getTime() + (e0 - s0)));
    };
    const onCancel = () => { document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp); document.removeEventListener('pointercancel', onCancel); ghost?.remove(); if (moved && orig) refreshPage(); };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
  });
}

// =====================================================================
// Reports (Samenvatting / Gedetailleerd / Wekelijks, zoals Clockify)
// =====================================================================
const GROUPS = [['project', 'Project'], ['client', 'Client'], ['user', 'User'], ['tag', 'Tag'], ['day', 'Date'], ['description', 'Description']];
const TABS = [['summary', 'Summary'], ['detailed', 'Detailed'], ['weekly', 'Weekly']];

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
  const groups = GROUPS.filter(g => isAdmin() || g[0] !== 'user').filter(g => S.tagsReady || g[0] !== 'tag');
  const fbtn = (k, label, val) => `<button class="fbtn ${val ? 'on' : ''}" data-f="${k}">${label}${val ? `: <b>${esc(val)}</b>` : ''}${icon('down')}</button>`;
  const nameOfFilter = {
    user: R.user && (profileOf(R.user)?.full_name || ''), client: R.client && (R.client === '__none' ? 'without client' : byId(S.clients, R.client)?.name || ''),
    project: R.project && (byId(S.projects, R.project)?.name || ''), tag: R.tag && (R.tag === '__none' ? 'without tag' : byId(S.tags, R.tag)?.name || '')
  };

  page.innerHTML = `
    <div class="page-head">
      <div class="seg" id="r-tab">${TABS.map(([k, l]) => `<button data-t="${k}" class="${R.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="row">${rangeHtml(from, to)}<button class="btn" id="r-exp">${icon('dl')}Export${icon('down')}</button></div>
    </div>
    <div class="card filterbar">
      <span class="flabel">Filter</span>
      ${isAdmin() ? fbtn('user', 'Team', nameOfFilter.user) : ''}
      ${fbtn('client', 'Client', nameOfFilter.client)}
      ${fbtn('project', 'Project', nameOfFilter.project)}
      ${S.tagsReady ? fbtn('tag', 'Tag', nameOfFilter.tag) : ''}
      <input id="r-desc" placeholder="Description" value="${esc(R.desc)}" aria-label="Description">
      ${R.user || R.client || R.project || R.tag || R.desc ? '<button class="linkbtn" id="r-clear">Clear filters</button>' : ''}
    </div>
    <div class="card">
      <div class="sumband">
        <span>Total: <b class="num">${fmtHMS(total)}</b></span>
        <span class="muted small">${entries.length} time entries</span>
      </div>
      <div class="card-body"><div class="chart" id="r-chart"></div></div>
    </div>
    <div class="card" id="r-body"></div>`;

  // Grafiek: één kleur, waarde boven de staaf (zoals Clockify)
  const bk = buckets(from, to);
  barChart($('#r-chart'), bk.map(k => {
    const sec = entries.reduce((t, e) => t + clipSec(e, k.a, k.b), 0);
    return { label: k.label, value: sec / 3600, valueLabel: fmtHMS(sec), tip: `<b>${esc(k.tip)}</b><br>${fmtHMS(sec)}` };
  }), { showValues: bk.length <= 14, color: 'var(--bar-rep)' });

  const body = $('#r-body');
  if (R.tab === 'summary') {
    const rows = groupRows(entries, R.g1, secOf).map((r, i) => ({ ...r, color: groupColor(R.g1, r.k, i) }));
    const sub = r => R.g2 ? groupRows(entries.filter(e => groupKeys(e, R.g1).includes(r.k)), R.g2, secOf) : [];
    const name = (r, g) => g === 'project' ? projLabel(byId(S.projects, r.k)) : g === 'user' && profileOf(r.k) ? `<span class="row" style="flex-wrap:nowrap">${avatar(profileOf(r.k))}${esc(profileOf(r.k).full_name)}</span>` : esc(groupText(r, g));
    body.innerHTML = `
      <div class="card-head"><div class="row small"><span class="muted">Group by</span>
        <select id="r-g1" aria-label="Group by">${groups.map(([k, l]) => `<option value="${k}" ${R.g1 === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select id="r-g2" aria-label="Then by"><option value="">(none)</option>${groups.filter(g => g[0] !== R.g1).map(([k, l]) => `<option value="${k}" ${R.g2 === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
      ${rows.length ? `<div class="sum-split"><div class="table-wrap"><table class="tree"><thead><tr><th>Title</th><th class="r">Duration</th><th class="r" style="width:70px">%</th></tr></thead><tbody>
        ${rows.map(r => {
          const kids = sub(r), open = R.open.has(r.k);
          return `<tr class="g1"><td>${kids.length ? `<button class="cnt ${open ? 'on' : ''}" data-open="${esc(r.k)}">${kids.length}</button>` : ''}${name(r, R.g1)}</td><td class="r num"><b>${fmtHMS(r.sec)}</b></td><td class="r num muted">${total ? Math.round(r.sec / total * 100) : 0}%</td></tr>`
            + (open ? kids.map(c => `<tr class="g2"><td>${name(c, R.g2)}</td><td class="r num">${fmtHMS(c.sec)}</td><td></td></tr>`).join('') : '');
        }).join('')}</tbody></table>
        ${R.g1 === 'tag' || R.g2 === 'tag' ? '<div class="muted small" style="padding:10px 16px">Time entries with multiple tags count towards each tag.</div>' : ''}</div>
        <div class="donut-wrap">${donut(rows.map(r => ({ name: groupText(r, R.g1), sec: r.sec, color: r.color })), total)}</div></div>`
      : '<div class="empty">No time entries for these filters.</div>'}`;
    $('#r-g1').onchange = e => set({ g1: e.target.value, g2: R.g2 === e.target.value ? '' : R.g2, open: new Set() });
    $('#r-g2').onchange = e => set({ g2: e.target.value });
    $$('[data-open]', body).forEach(b => b.onclick = () => { const k = b.dataset.open; R.open.has(k) ? R.open.delete(k) : R.open.add(k); refreshPage(); });
  } else if (R.tab === 'detailed') {
    const sorted = [...entries].sort((a, b) => entryStart(b) - entryStart(a));
    body.innerHTML = sorted.length ? `<div class="table-wrap"><table><thead><tr><th>Time entry</th>${isAdmin() ? '<th>User</th>' : ''}<th>Date</th><th>Time</th><th class="r">Duration</th><th></th></tr></thead><tbody>
      ${sorted.map(e => `<tr data-id="${e.id}"><td>${e.description ? esc(e.description) : '<span class="muted">(no description)</span>'}${tagChips(e.tag_ids)}<div class="small">${projLabel(projectOf(e))}</div></td>
        ${isAdmin() ? `<td>${esc(entryUserName(e))}</td>` : ''}
        <td class="num">${esc(fmtDate(entryStart(e), { day: '2-digit', month: '2-digit', year: 'numeric' }))}</td>
        <td class="num muted">${hm(entryStart(e))} – ${e.end_at ? hm(entryEnd(e)) : 'now'}</td><td class="r num"><b>${fmtHMS(entrySec(e))}</b></td>
        <td class="r"><button class="btn icon ghost" data-edit aria-label="Edit">${icon('edit')}</button></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No time entries for these filters.</div>';
    $$('[data-edit]', body).forEach(b => b.onclick = () => openEntryModal(entries.find(x => x.id === b.closest('tr').dataset.id)));
  } else {
    // Wekelijks: rijen per groep, kolommen per dag/week/maand (zelfde indeling als de grafiek)
    const cols = bk;
    const rows = groupRows(entries, R.g1, secOf);
    const cell = (r, c) => entries.filter(e => groupKeys(e, R.g1).includes(r.k)).reduce((t, e) => t + clipSec(e, c.a, c.b), 0);
    body.innerHTML = `
      <div class="card-head"><div class="row small"><span class="muted">Rows by</span><select id="r-g1" aria-label="Rows by">${groups.filter(g => g[0] !== 'day').map(([k, l]) => `<option value="${k}" ${R.g1 === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
      ${rows.length ? `<div class="table-wrap"><table class="weekly"><thead><tr><th>${GROUPS.find(g => g[0] === R.g1)[1]}</th>${cols.map(c => `<th class="r">${esc(c.label)}</th>`).join('')}<th class="r">Total</th></tr></thead><tbody>
        ${rows.map(r => `<tr><td>${R.g1 === 'project' ? projLabel(byId(S.projects, r.k)) : esc(groupText(r, R.g1))}</td>${cols.map(c => { const v = cell(r, c); return `<td class="r num ${v ? '' : 'muted'}">${v ? fmtHM(v) : '–'}</td>`; }).join('')}<td class="r num"><b>${fmtHM(r.sec)}</b></td></tr>`).join('')}
      </tbody><tfoot><tr><th>Total</th>${cols.map(c => `<th class="r num">${fmtHM(entries.reduce((t, e) => t + clipSec(e, c.a, c.b), 0))}</th>`).join('')}<th class="r num">${fmtHM(total)}</th></tr></tfoot></table></div>`
      : '<div class="empty">No time entries for these filters.</div>'}`;
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
    if (f === 'project') return pickProject(b, R.project, pick, { emptyLabel: 'All projects', includeArchived: true });
    const items = f === 'user' ? S.profiles.map(p => ({ id: p.id, label: p.full_name || p.email }))
      : f === 'client' ? [{ id: '__none', label: 'Without client' }, ...S.clients.map(c => ({ id: c.id, label: c.name }))]
      : [{ id: '__none', label: 'Without tag' }, ...S.tags.map(t => ({ id: t.id, label: t.name }))];
    pickFrom(b, items, R[f], pick, { emptyLabel: f === 'user' ? 'Everyone' : f === 'client' ? 'All clients' : 'All tags' });
  });
  $('#r-exp').onclick = () => openMenu($('#r-exp'), `<button class="mi" data-x="pdf">${icon('pdf')}Save as PDF</button><button class="mi" data-x="csv">${icon('dl')}Save as CSV (Excel)</button>`, m => {
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
    const row = g.get(k) || { k, sample: e, sec: 0, bill: 0, n: 0 };
    const s = secOf(e);
    row.sec += s; row.bill += e.billable ? s : 0; row.n++;
    g.set(k, row);
  }
  return [...g.values()].sort((a, b) => group === 'day' ? a.k.localeCompare(b.k) : b.sec - a.sec);
}
// Naam van een groep als platte tekst (voor PDF)
function groupText(r, group) {
  if (group === 'project') { const p = byId(S.projects, r.k); return p ? p.name : 'No project'; }
  if (group === 'user') return profileOf(r.k)?.full_name || entryUserName(r.sample) || 'Unknown';
  if (group === 'client') return byId(S.clients, r.k)?.name || 'Without client';
  if (group === 'tag') return r.k ? byId(S.tags, r.k)?.name || 'Unknown tag' : 'Without tag';
  if (group === 'day') return fmtDate(parseYmd(r.k), { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  return r.sample.description || '(no description)';
}

const loadScript = src => new Promise((res, rej) => {
  if ([...document.scripts].some(x => x.src === src)) return res();
  const el = document.createElement('script');
  el.src = src; el.onload = res; el.onerror = () => rej(new Error('Could not load the PDF module. Check your internet connection.'));
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
    R.desc && `Description: ${R.desc}`,
    R.user && `User: ${profileOf(R.user)?.full_name || ''}`, R.client && `Client: ${byId(S.clients, R.client)?.name || ''}`,
    R.project && `Project: ${byId(S.projects, R.project)?.name || ''}`,
    R.tag && `Tag: ${R.tag === '__none' ? 'without tag' : byId(S.tags, R.tag)?.name || ''}`
  ].filter(Boolean);
  const d = x => fmtDate(x, { month: 'short', day: 'numeric', year: 'numeric' });
  const style = { fontSize: 9, cellPadding: 1.6 }, head = { fillColor: [3, 169, 244] };

  doc.setFontSize(16); doc.text('Polyfy - Time report', 14, 16);
  doc.setFontSize(10); doc.setTextColor(90);
  doc.text(`${d(from)} - ${d(addDays(to, -1))}${filters.length ? '   |   ' + filters.join('   |   ') : ''}`, 14, 23);
  doc.text(`Total ${fmtHMS(total)} (${fmtDec(total)} h)   |   ${entries.length} time entries   |   created ${d(new Date())}`, 14, 29);
  doc.setTextColor(0);

  // Grafiek zoals op de Reports-pagina: groene staven per dag/week/maand
  const bk = buckets(from, to).map(k => ({ ...k, sec: entries.reduce((t, e) => t + clipSec(e, k.a, k.b), 0) }));
  const cx = 24, cy = 36, cw = 259, ch = 52, maxH = niceMax(Math.max(...bk.map(k => k.sec / 3600)));
  doc.setFontSize(7); doc.setDrawColor(225); doc.setTextColor(140);
  for (let i = 0; i <= 4; i++) {
    const y = cy + ch - ch * i / 4;
    doc.line(cx, y, cx + cw, y);
    doc.text(`${(maxH * i / 4).toLocaleString('en-US')}h`, cx - 2, y + 1, { align: 'right' });
  }
  const band = cw / bk.length, bw = Math.min(16, band * 0.62), every = Math.ceil(bk.length / 31);
  bk.forEach((k, i) => {
    const bh = maxH ? k.sec / 3600 / maxH * ch : 0, mid = cx + band * i + band / 2;
    if (bh > 0.2) { doc.setFillColor(139, 195, 74); doc.rect(mid - bw / 2, cy + ch - bh, bw, bh, 'F'); }
    if (k.sec && bk.length <= 14) { doc.setTextColor(80); doc.text(fmtHMS(k.sec), mid, cy + ch - bh - 1.5, { align: 'center' }); }
    if (i % every === 0) { doc.setTextColor(140); doc.text(k.label, mid, cy + ch + 4, { align: 'center' }); }
  });
  doc.setTextColor(0);

  doc.autoTable({
    startY: cy + ch + 10, head: [[groupLabel, 'Duration', 'Share']], styles: style, headStyles: head,
    columnStyles: { 1: { halign: 'right', cellWidth: 25 }, 2: { halign: 'right', cellWidth: 22 } },
    body: [...groupRows(entries, R.g1, secOf).map(r => [groupText(r, R.g1), fmtHMS(r.sec), `${total ? Math.round(r.sec / total * 100) : 0}%`]), ['Total', fmtHMS(total), '']],
    didParseCell: c => {
      if (c.section === 'head' && c.column.index > 0) c.cell.styles.halign = 'right';
      if (c.section === 'body' && c.row.index === c.table.body.length - 1) c.cell.styles.fontStyle = 'bold';
    }
  });
  doc.autoTable({
    startY: doc.lastAutoTable.finalY + 8, styles: style, headStyles: head,
    head: [['Date', 'Time', 'Duration', 'User', 'Client', 'Project', 'Description', 'Tags']],
    columnStyles: { 0: { cellWidth: 22 }, 1: { cellWidth: 22 }, 2: { halign: 'right', cellWidth: 18 } },
    didParseCell: c => { if (c.section === 'head' && c.column.index === 2) c.cell.styles.halign = 'right'; },
    body: [...entries].sort((a, b) => entryStart(a) - entryStart(b)).map(e => {
      const p = projectOf(e);
      return [fmtDate(entryStart(e), { day: '2-digit', month: '2-digit', year: 'numeric' }), `${hm(entryStart(e))}-${e.end_at ? hm(entryEnd(e)) : 'now'}`, fmtHMS(entrySec(e)),
        entryUserName(e), clientOf(p)?.name || '', p?.name || '', e.description, tagNames(e.tag_ids).join(', ')];
    })
  });
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) { doc.setPage(i); doc.setFontSize(8); doc.setTextColor(140); doc.text(`Page ${i} of ${pages}`, 283, 203, { align: 'right' }); }
  doc.save(`polyfy-report-${ymd(from)}-to-${ymd(addDays(to, -1))}.pdf`);
}

function exportCsv(entries, from, to) {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Date', 'Start time', 'End time', 'Duration (h:mm)', 'Duration (decimal)', 'User', 'Email', 'Client', 'Project', 'Description', 'Tags', 'Billable'];
  const rows = [...entries].sort((a, b) => entryStart(a) - entryStart(b)).map(e => {
    const p = projectOf(e), u = profileOf(e.user_id), sec = entrySec(e);
    return [ymd(entryStart(e)), hm(entryStart(e)), e.end_at ? hm(entryEnd(e)) : '', fmtHM(sec), (sec / 3600).toFixed(2).replace('.', ','),
      u?.full_name || e.import_name, u?.email || e.import_email, clientOf(p)?.name, p?.name, e.description, tagNames(e.tag_ids).join(', '), e.billable ? 'Yes' : 'No'];
  });
  const csv = '﻿' + [head, ...rows].map(r => r.map(q).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `polyfy-report-${ymd(from)}-to-${ymd(addDays(to, -1))}.csv`;
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
  // Sorteren: naam (standaard A-Z), klant of geregistreerde tijd; klik nogmaals = omkeren
  const secs = p => Number(tot.get(p.id)?.total_seconds || 0);
  const cmp = { name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
    client: (a, b) => (clientOf(a)?.name || '~').localeCompare(clientOf(b)?.name || '~', undefined, { sensitivity: 'base' }) || a.name.localeCompare(b.name),
    tracked: (a, b) => secs(a) - secs(b) }[P.sort];
  list.sort((a, b) => cmp(a, b) * P.dir);
  const sortTh = (k, label, cls = '') => `<th class="${cls}"><button class="sortbtn ${P.sort === k ? 'on' : ''}" data-sort="${k}">${label}<span class="arr">${P.sort === k ? (P.dir > 0 ? '▲' : '▼') : '▲▼'}</span></button></th>`;

  page.innerHTML = `
    <div class="page-head"><div><h1>Projects</h1><div class="muted">${list.length} of ${S.projects.length} projects</div></div>${isAdmin() ? `<button class="btn primary" id="p-new">Create new project</button>` : ''}</div>
    <div class="row">
      <input id="p-search" placeholder="Search by name" value="${esc(P.search)}" style="min-width:240px">
      <select id="p-client" aria-label="Client"><option value="">All clients</option><option value="__none" ${P.client === '__none' ? 'selected' : ''}>Without client</option>${S.clients.map(c => `<option value="${c.id}" ${c.id === P.client ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <div class="seg" id="p-status">${[['active', 'Active'], ['archived', 'Archived'], ['all', 'All']].map(([k, l]) => `<button data-s="${k}" class="${P.status === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="seg" id="p-sort" title="Sort by name"><button data-az="1" class="${P.sort === 'name' && P.dir > 0 ? 'on' : ''}">A-Z</button><button data-az="-1" class="${P.sort === 'name' && P.dir < 0 ? 'on' : ''}">Z-A</button></div>
    </div>
    <div class="card table-wrap">
      ${list.length ? `<table><thead><tr>${sortTh('name', 'Name')}${sortTh('client', 'Client')}${sortTh('tracked', 'Tracked', 'r')}${isAdmin() ? '<th></th>' : ''}</tr></thead><tbody>
      ${list.map(p => `<tr data-id="${p.id}">
          <td><a href="#reports" data-rep class="proj" style="color:var(--text);text-decoration:none"><span class="dot" style="background:${esc(p.color)}"></span>${esc(p.name)}</a>${p.archived ? ' <span class="tag">archived</span>' : ''}</td>
          <td>${esc(clientOf(p)?.name || '–')}</td>
          <td class="r num"><b>${fmtHM(Number(tot.get(p.id)?.total_seconds || 0))}</b></td>
          ${isAdmin() ? `<td class="r"><button class="btn icon ghost" data-edit aria-label="Edit">${icon('edit')}</button></td>` : ''}
        </tr>`).join('')}</tbody></table>` : `<div class="empty">${S.projects.length ? 'No projects found.' : isAdmin() ? 'No projects yet. Create your first project.' : 'There are no projects yet. Ask an admin to create them.'}</div>`}
    </div>`;

  const search = $('#p-search');
  search.oninput = debounce(() => { P.search = search.value; refreshPage(); setTimeout(() => { const s = $('#p-search'); s?.focus(); s?.setSelectionRange(s.value.length, s.value.length); }); }, 250);
  $('#p-client').onchange = e => { P.client = e.target.value; refreshPage(); };
  $$('#p-status button').forEach(b => b.onclick = () => { P.status = b.dataset.s; refreshPage(); });
  $$('#p-sort [data-az]').forEach(b => b.onclick = () => { P.sort = 'name'; P.dir = Number(b.dataset.az); refreshPage(); });
  $$('[data-sort]').forEach(b => b.onclick = () => { const k = b.dataset.sort; P.dir = P.sort === k ? -P.dir : (k === 'tracked' ? -1 : 1); P.sort = k; refreshPage(); });
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
    <div class="page-head"><h1>Clients</h1>${isAdmin() ? `<button class="btn primary" id="c-new">Create new client</button>` : ''}</div>
    <div class="card table-wrap">
      ${S.clients.length ? `<table><thead><tr><th>Name</th><th>Projects</th><th class="r">Tracked</th>${isAdmin() ? '<th></th>' : ''}</tr></thead><tbody>${S.clients.map(c => {
        const ps = S.projects.filter(p => p.client_id === c.id);
        return `<tr data-cid="${c.id}"><td><b>${esc(c.name)}</b>${c.archived ? ' <span class="tag">archived</span>' : ''}</td>
          <td><a href="#projects" data-cproj>${ps.length} project${ps.length === 1 ? '' : 's'}</a></td>
          <td class="r num">${fmtHM(ps.reduce((a, p) => a + (tot.get(p.id) || 0), 0))}</td>
          ${isAdmin() ? `<td class="r"><button class="btn icon ghost" data-cedit aria-label="Edit">${icon('edit')}</button></td>` : ''}</tr>`;
      }).join('')}</tbody></table>` : '<div class="empty">No clients yet.</div>'}
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
    <div class="page-head"><h1>Tags</h1>${isAdmin() && S.tagsReady ? `<button class="btn primary" id="tg-new">Create new tag</button>` : ''}</div>
    ${!S.tagsReady ? '<div class="card card-body notice">Tags are not active yet: run <code>supabase/schema-v2-tags-import.sql</code> in Supabase.</div>'
      : `<div class="card table-wrap">${S.tags.length ? `<table><thead><tr><th>Name</th><th>Status</th>${isAdmin() ? '<th></th>' : ''}</tr></thead><tbody>${S.tags.map(t => `<tr data-tid="${t.id}">
          <td><span class="tag">${esc(t.name)}</span></td><td class="muted">${t.archived ? 'archived' : 'active'}</td>
          ${isAdmin() ? `<td class="r"><button class="btn icon ghost" data-tedit aria-label="Edit">${icon('edit')}</button></td>` : ''}</tr>`).join('')}</tbody></table>`
        : '<div class="empty">No tags yet. You can also create them right from the Time Tracker.</div>'}</div>`}`;
  if (isAdmin() && S.tagsReady) {
    $('#tg-new').onclick = () => openTagModal(null);
    $$('[data-tedit]').forEach(b => b.onclick = () => openTagModal(byId(S.tags, b.closest('tr').dataset.tid)));
  }
}

function openTagModal(t) {
  openModal(t ? 'Edit tag' : 'Create new tag', `
    <label class="field">Name<input id="tm-name" value="${esc(t?.name || '')}" required></label>
    ${t ? `<label class="check"><input type="checkbox" id="tm-arch" ${t.archived ? 'checked' : ''}> Archived (no longer selectable)</label>` : ''}`,
    `<div>${t ? `<button class="btn danger" id="tm-del">${icon('trash')}Delete</button>` : ''}</div><div class="row"><button class="btn" data-close>Cancel</button><button class="btn primary" id="tm-save">Save</button></div>`);
  $('#tm-save').onclick = async () => {
    const name = $('#tm-name').value.trim();
    if (!name) return toast('Enter a tag name.', true);
    const row = { name }; if (t) row.archived = $('#tm-arch').checked;
    const { data, error } = t ? await sb.from('tags').update(row).eq('id', t.id).select().single() : await sb.from('tags').insert(row).select().single();
    if (error) return fail(error.code === '23505' ? new Error('A tag with that name already exists.') : error);
    if (t) Object.assign(t, data); else S.tags.push(data);
    S.tags.sort(byName);
    closeModal(); toast('Tag saved'); renderTimer(); refreshPage();
  };
  if (t) $('#tm-del').onclick = async () => {
    if (!confirm(`Delete tag "${t.name}"? It will also be removed from all time entries. Archiving is usually better.`)) return;
    const { error } = await sb.from('tags').delete().eq('id', t.id);
    if (error) return fail(error);
    S.tags = S.tags.filter(x => x.id !== t.id);
    closeModal(); toast('Tag deleted'); renderTimer(); refreshPage();
  };
}

function openProjectModal(p) {
  const used = new Set(S.projects.map(x => x.color));
  const cur = p || { name: '', client_id: null, color: PROJECT_COLORS.find(c => !used.has(c)) || PROJECT_COLORS[S.projects.length % PROJECT_COLORS.length], billable: true, hourly_rate: null, budget_hours: null, archived: false };
  let color = cur.color;
  const m = openModal(p ? 'Edit project' : 'Create new project', `
    <label class="field">Name<input id="pm-name" value="${esc(cur.name)}" required></label>
    <label class="field">Client<select id="pm-client"><option value="">Without client</option>${S.clients.filter(c => !c.archived || c.id === cur.client_id).map(c => `<option value="${c.id}" ${c.id === cur.client_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}<option value="__new">+ Create new client…</option></select></label>
    <div class="field">Color<div class="swatches">${PROJECT_COLORS.map(c => `<button type="button" class="swatch ${c === color ? 'on' : ''}" data-c="${c}" style="background:${c}" aria-label="Color ${c}"></button>`).join('')}</div></div>
    ${p ? `<label class="check"><input type="checkbox" id="pm-arch" ${cur.archived ? 'checked' : ''}> Archived (no longer selectable)</label>` : ''}`,
    `<div>${p ? `<button class="btn danger" id="pm-del">${icon('trash')}Delete</button>` : ''}</div><div class="row"><button class="btn" data-close>Cancel</button><button class="btn primary" id="pm-save">Save</button></div>`);
  $$('.swatch', m).forEach(s => s.onclick = () => { color = s.dataset.c; $$('.swatch', m).forEach(x => x.classList.toggle('on', x === s)); });
  $('#pm-client').onchange = async e => {
    if (e.target.value !== '__new') return;
    const name = prompt('Name of the new client');
    if (!name?.trim()) { e.target.value = cur.client_id || ''; return; }
    const { data, error } = await sb.from('clients').insert({ name: name.trim() }).select().single();
    if (error) { e.target.value = ''; return fail(error); }
    S.clients.push(data); S.clients.sort((a, b) => a.name.localeCompare(b.name));
    const opt = new Option(data.name, data.id, true, true);
    e.target.insertBefore(opt, e.target.querySelector('option[value="__new"]'));
  };
  $('#pm-save').onclick = async () => {
    const name = $('#pm-name').value.trim();
    if (!name) return toast('Enter a project name.', true);
    const row = { name, client_id: $('#pm-client').value || null, color };
    if (p) row.archived = $('#pm-arch').checked;
    const { data, error } = p ? await sb.from('projects').update(row).eq('id', p.id).select().single() : await sb.from('projects').insert(row).select().single();
    if (error) return fail(error);
    if (p) Object.assign(p, data); else S.projects.push(data);
    S.projects.sort((a, b) => a.name.localeCompare(b.name));
    closeModal(); toast('Project saved'); renderTimer(); refreshPage();
  };
  if (p) $('#pm-del').onclick = async () => {
    if (!confirm(`Delete project "${p.name}"? Existing time entries are kept without a project. Archiving is usually better.`)) return;
    const { error } = await sb.from('projects').delete().eq('id', p.id);
    if (error) return fail(error);
    S.projects = S.projects.filter(x => x.id !== p.id);
    closeModal(); toast('Project deleted'); renderTimer(); refreshPage();
  };
}

function openClientModal(c) {
  openModal(c ? 'Edit client' : 'Create new client', `
    <label class="field">Name<input id="cm-name" value="${esc(c?.name || '')}" required></label>
    ${c ? `<label class="check"><input type="checkbox" id="cm-arch" ${c.archived ? 'checked' : ''}> Archived</label>` : ''}`,
    `<div>${c ? `<button class="btn danger" id="cm-del">${icon('trash')}Delete</button>` : ''}</div><div class="row"><button class="btn" data-close>Cancel</button><button class="btn primary" id="cm-save">Save</button></div>`);
  $('#cm-save').onclick = async () => {
    const name = $('#cm-name').value.trim();
    if (!name) return toast('Enter a client name.', true);
    const row = { name }; if (c) row.archived = $('#cm-arch').checked;
    const { data, error } = c ? await sb.from('clients').update(row).eq('id', c.id).select().single() : await sb.from('clients').insert(row).select().single();
    if (error) return fail(error);
    if (c) Object.assign(c, data); else S.clients.push(data);
    S.clients.sort((a, b) => a.name.localeCompare(b.name));
    closeModal(); toast('Client saved'); renderTimer(); refreshPage();
  };
  if (c) $('#cm-del').onclick = async () => {
    if (!confirm(`Delete client "${c.name}"? Its projects are kept, without a client.`)) return;
    const { error } = await sb.from('clients').delete().eq('id', c.id);
    if (error) return fail(error);
    S.clients = S.clients.filter(x => x.id !== c.id);
    S.projects.forEach(p => { if (p.client_id === c.id) p.client_id = null; });
    closeModal(); toast('Client deleted'); renderTimer(); refreshPage();
  };
}

// =====================================================================
// Team
// =====================================================================
async function renderTeam(page) {
  const T = S.team;
  const [sum, un, inv] = await Promise.all([
    sb.rpc('team_summary', { week_start: startOfWeek(new Date()).toISOString() }),
    isAdmin() && S.tagsReady ? sb.rpc('unclaimed_imports') : Promise.resolve({ data: [] }),
    isAdmin() ? sb.from('invites').select('*').order('email') : Promise.resolve({ data: [] })
  ]);
  if (sum.error) throw sum.error;
  if (S.view !== 'team') return;
  S.invitesReady = isAdmin() && !inv.error;
  const live = new Map(sum.data.filter(r => r.running_since).map(r => [r.user_id, r]));
  const q = T.q.toLowerCase();
  const match = (name, email) => !q || `${name} ${email}`.toLowerCase().includes(q);
  const members = [...S.profiles]
    .filter(p => T.status === 'all' || (T.status === 'active') === p.active)
    .filter(p => !T.role || p.role === T.role)
    .filter(p => match(p.full_name, p.email))
    .sort((a, b) => (a.full_name || a.email).localeCompare(b.full_name || b.email));
  // Nog geen account: uitgenodigd (invites) en/of uren uit Clockify (unclaimed_imports), samengevoegd per e-mail
  const waiting = new Map();
  for (const i of inv.error ? [] : inv.data || []) waiting.set(lc(i.email), { email: lc(i.email), name: i.full_name, role: i.role, invited: true, entries: 0 });
  for (const r of un.error ? [] : (un.data || []).filter(r => !/^deleteduser/i.test(r.import_email))) {
    const w = waiting.get(r.import_email) || { email: r.import_email, name: r.import_name, role: 'member', invited: false, entries: 0 };
    w.entries = r.entries; w.name = w.name || r.import_name; waiting.set(r.import_email, w);
  }
  const pending = [...waiting.values()].filter(w => !S.profiles.some(p => lc(p.email) === w.email))
    .filter(w => T.status !== 'inactive' && (!T.role || w.role === T.role) && match(w.name || '', w.email))
    .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
  const roleTag = role => `<span class="tag ${role === 'admin' ? 'admin' : ''}">${role === 'admin' ? 'Admin' : 'Member'}</span>`;

  page.innerHTML = `
    <div class="page-head"><h1>Team</h1>${isAdmin() ? `<button class="btn primary" id="tm-add">Add new member</button>` : ''}</div>
    <div class="card filterbar">
      <span class="flabel">Filter</span>
      <select id="tm-status" aria-label="Status"><option value="active">Active</option><option value="inactive" ${T.status === 'inactive' ? 'selected' : ''}>Inactive</option><option value="all" ${T.status === 'all' ? 'selected' : ''}>All</option></select>
      <select id="tm-role" aria-label="Role"><option value="">All roles</option><option value="admin" ${T.role === 'admin' ? 'selected' : ''}>Admin</option><option value="member" ${T.role === 'member' ? 'selected' : ''}>Member</option></select>
      <input id="tm-q" placeholder="Search by name or email" value="${esc(T.q)}" style="margin-left:auto;min-width:220px" aria-label="Search">
    </div>
    <div class="card table-wrap">
      <div class="card-head"><span class="muted small">Members</span><span class="muted small">${members.length + pending.length}</span></div>
      ${members.length || pending.length ? `<table><thead><tr><th>Name</th><th>Email</th><th>Role</th>${isAdmin() ? '<th></th>' : ''}</tr></thead><tbody>
      ${members.map(p => {
        const l = live.get(p.id), pj = l && byId(S.projects, l.running_project);
        return `<tr data-id="${p.id}">
          <td><span class="row" style="flex-wrap:nowrap">${avatar(p)}<span>${esc(p.full_name || p.email)}${p.id === S.me.id ? ' <span class="muted">(you)</span>' : ''}
            ${l ? `<br><span class="tag live" title="Since ${hm(new Date(l.running_since))}">● working${pj ? ' · ' + esc(pj.name) : ''}</span>` : ''}${p.active ? '' : ' <span class="tag off">inactive</span>'}</span></span></td>
          <td>${esc(p.email)}</td>
          <td>${isAdmin() && p.id !== S.me.id ? `<button class="rolebtn" data-role>${roleTag(p.role)}</button>` : roleTag(p.role)}</td>
          ${isAdmin() ? `<td class="r"><button class="btn icon ghost" data-more aria-label="More">${icon('dots')}</button></td>` : ''}
        </tr>`;
      }).join('')}
      ${pending.map(w => `<tr data-pend="${esc(w.email)}"><td><span class="row" style="flex-wrap:nowrap">${avatar({ id: w.email, full_name: w.name || w.email })}<span>${esc(w.name || w.email)}<br><span class="muted small">${w.invited ? 'Invited, no account yet' : 'No account yet'}${w.entries ? ` · ${w.entries} imported time entries` : ''}</span></span></span></td>
        <td>${esc(w.email)}</td><td>${roleTag(w.role)}</td>${isAdmin() ? `<td class="r">${w.invited ? `<button class="btn icon ghost" data-pmore aria-label="More">${icon('dots')}</button>` : ''}</td>` : ''}</tr>`).join('')}
      </tbody></table>` : '<div class="empty">No members found.</div>'}
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
    const ro = $('[data-role]', tr);
    if (ro) ro.onclick = () => openMenu(ro, `<button class="mi ${p.role === 'admin' ? 'on' : ''}" data-v="admin">Admin</button><button class="mi ${p.role === 'member' ? 'on' : ''}" data-v="member">Member</button>`, m => {
      $$('[data-v]', m).forEach(x => x.onclick = () => { closeMenu(); if (x.dataset.v !== p.role) saveProfile(p, { role: x.dataset.v }); });
    });
    const mo = $('[data-more]', tr);
    mo.onclick = () => openMenu(mo, `<button class="mi" data-m="edit">Edit</button><button class="mi" data-m="rep">View report</button>${p.id !== S.me.id ? `<button class="mi ${p.active ? 'danger' : ''}" data-m="act">${p.active ? 'Deactivate' : 'Activate'}</button>` : ''}`, m => {
      $$('[data-m]', m).forEach(x => x.onclick = () => {
        closeMenu();
        if (x.dataset.m === 'edit') return openMemberModal(p);
        if (x.dataset.m === 'rep') { Object.assign(S.rep, { user: p.id, project: '', client: '', tag: '', desc: '', g1: 'project', tab: 'summary' }); location.hash = 'reports'; return; }
        if (p.active && !confirm(`Deactivate ${p.full_name || p.email}? They will no longer be able to log in and track time.`)) return;
        saveProfile(p, { active: !p.active });
      });
    });
  });
  $$('tr[data-pend] [data-pmore]', page).forEach(b => b.onclick = () => openMenu(b, '<button class="mi danger" data-m="del">Revoke invite</button>', m => {
    $('[data-m]', m).onclick = async () => {
      closeMenu();
      const { error } = await sb.from('invites').delete().eq('email', b.closest('tr').dataset.pend);
      if (error) return fail(error);
      toast('Invite revoked'); refreshPage();
    };
  }));
}

function openInviteModal() {
  const link = location.origin + location.pathname, dom = (CFG.ALLOWED_EMAIL_DOMAIN || '').trim();
  openModal('Add new member', `
    ${S.invitesReady ? `
      <label class="field">Email<input id="inv-email" type="email" placeholder="name@${esc(dom || 'company.com')}" required></label>
      <div class="grid2">
        <label class="field">Name<input id="inv-name" placeholder="First and last name"></label>
        <label class="field">Role<select id="inv-role"><option value="member">Member</option><option value="admin">Admin</option></select></label>
      </div>
      <p class="muted small" style="margin:0">Whoever signs up with this email address gets this name and role right away.</p>`
      : '<p class="muted small" style="margin:0">Run <code>supabase/schema-v4-uitnodigingen.sql</code> to add teammates with a role in advance.</p>'}
    <div class="field">Invite link<div class="row"><input readonly value="${esc(link)}" style="flex:1;min-width:200px" id="inv-link"><button class="btn" id="inv-copy">Copy</button></div></div>
    <p class="muted small" style="margin:0">Your teammate signs up through this link${dom ? ` with a <b>@${esc(dom)}</b> address` : ''}. Time imported from Clockify is linked automatically when they use the same email address as in Clockify.</p>`,
    `<div></div><div class="row"><button class="btn" data-close>Close</button>${S.invitesReady ? '<button class="btn primary" id="inv-save">Add</button>' : ''}</div>`);
  $('#inv-copy').onclick = async () => { try { await navigator.clipboard.writeText(link); toast('Link copied'); } catch (_) { $('#inv-link').select(); } };
  if (!S.invitesReady) return;
  $('#inv-save').onclick = async () => {
    const email = lc($('#inv-email').value);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast('Enter a valid email address.', true);
    if (dom && !email.endsWith('@' + dom.toLowerCase())) return toast(`Only @${dom} addresses can sign up.`, true);
    if (S.profiles.some(p => lc(p.email) === email)) return toast('An account with this email address already exists.', true);
    const { error } = await sb.from('invites').upsert({ email, full_name: $('#inv-name').value.trim(), role: $('#inv-role').value });
    if (error) return fail(error);
    closeModal(); toast('Added. Share the invite link so they can sign up.'); refreshPage();
  };
}

function openMemberModal(p) {
  const self = p.id === S.me.id;
  openModal('Edit member', `
    <div class="row">${avatar(p)}<div><b>${esc(p.full_name || p.email)}</b><div class="muted small">${esc(p.email)}</div></div></div>
    <label class="field">Name<input id="mm-name" value="${esc(p.full_name)}"></label>
    <div class="grid2">
      <label class="field">Role<select id="mm-role" ${self ? 'disabled' : ''}><option value="member" ${p.role === 'member' ? 'selected' : ''}>Member</option><option value="admin" ${p.role === 'admin' ? 'selected' : ''}>Admin</option></select></label>
      <label class="field">Weekly target (hours)<input id="mm-target" type="number" min="0" max="168" step="0.5" value="${p.weekly_target}"></label>
    </div>
    ${self ? '<div class="muted small">You cannot change your own role or deactivate your own account.</div>' : `<label class="check"><input type="checkbox" id="mm-active" ${p.active ? 'checked' : ''}> Active (inactive members cannot track time)</label>`}`,
    `<div></div><div class="row"><button class="btn" data-close>Cancel</button><button class="btn primary" id="mm-save">Save</button></div>`);
  $('#mm-save').onclick = async () => {
    const row = { full_name: $('#mm-name').value.trim(), weekly_target: Number($('#mm-target').value || 0) };
    if (!self) { row.role = $('#mm-role').value; row.active = $('#mm-active').checked; }
    const { data, error } = await sb.from('profiles').update(row).eq('id', p.id).select().single();
    if (error) return fail(error);
    Object.assign(p, data);
    closeModal(); toast('Member saved'); refreshPage();
  };
}

init().catch(fail);
