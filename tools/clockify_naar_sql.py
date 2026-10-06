# Zet Clockify-exports (gedetailleerd rapport + projectexport) om naar één SQL-bestand voor de Supabase SQL Editor.
# Gebruik: python3 tools/clockify_naar_sql.py uit.sql supabase/schema-v2-*.sql … supabase/schema-v5-*.sql export1.csv [export2.csv …]
# Alle opgegeven .sql-bestanden (database-updates) komen in volgorde vooraan, zodat de eindtoestand klopt.
# Zelfde regels als renderImport in app.js (kolommen, "(Without …)", datumvolgorde, source_ref), dus geen dubbels met de importpagina.
# Het resultaat bevat persoonsgegevens: NIET in de repo zetten.
import csv, re, sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

out_path, *rest = sys.argv[1:]
schemas = [f for f in rest if f.endswith('.sql')]
files = [f for f in rest if not f.endswith('.sql')]
TZ = ZoneInfo('Europe/Brussels')
COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948']
COLS = {
  'project': ['project', 'projectnaam', 'name', 'naam'], 'client': ['client', 'klant'],
  'description': ['description', 'beschrijving', 'omschrijving'], 'user': ['user', 'gebruiker', 'medewerker'],
  'email': ['email'], 'tags': ['tags', 'tag'], 'billable': ['billable', 'billability', 'factureerbaar'],
  'sdate': ['startdate', 'startdatum'], 'stime': ['starttime', 'starttijd'], 'edate': ['enddate', 'einddatum'], 'etime': ['endtime', 'eindtijd'],
  'dur': ['durationdecimal', 'duurdecimaal'], 'tracked': ['trackedh', 'geregistreerdu'], 'estimate': ['estimatedh', 'geschatu'],
  'rate': ['billablerateeur', 'billablerate', 'uurtarief']}
lc = lambda v: (v or '').strip().lower()
imp = lambda v: '' if re.match(r'^\((without|zonder) [^)]*\)$', v, re.I) else v
yes = lambda v: bool(re.match(r'^(yes|ja|true|1|y|j)$', v.strip(), re.I))
num = lambda v: (float(v.replace(',', '.')) or None) if v else None
q = lambda v: 'null' if v is None else ("'" + str(v).replace("'", "''") + "'")

clients, projects, tags, raw = {}, {}, {}, []
tracked = 0
for f in files:
    rows = list(csv.reader(open(f, encoding='utf-8-sig')))
    norm = [re.sub('[^a-z]', '', h.lower()) for h in rows[0]]
    ix = {k: next((i for i, h in enumerate(norm) if h in names), -1) for k, names in COLS.items()}
    get = lambda r, k: imp(r[ix[k]].strip()) if ix[k] >= 0 and ix[k] < len(r) else ''
    is_report = ix['sdate'] >= 0 and ix['stime'] >= 0
    for r in rows[1:]:
        if not any(x.strip() for x in r): continue
        o = dict(project=get(r, 'project'), client=get(r, 'client'), billable=ix['billable'] < 0 or yes(get(r, 'billable')))
        if o['client']: clients.setdefault(lc(o['client']), o['client'])
        if o['project']:
            k = lc(o['project']) + '|' + lc(o['client'])
            p = projects.setdefault(k, dict(name=o['project'], client=o['client'], billable=o['billable'], budget=None, rate=None))
            if is_report:
                if o['billable']: p['billable'] = True
            elif ix['tracked'] >= 0:
                p.update(billable=o['billable'], budget=num(get(r, 'estimate')), rate=num(get(r, 'rate')))
                tracked += num(get(r, 'tracked')) or 0
        if not is_report: continue
        o.update({k: get(r, k) for k in ['description', 'user', 'email', 'sdate', 'stime', 'edate', 'etime', 'dur']})
        o['tags'] = [t.strip() for t in get(r, 'tags').split(',') if t.strip()]
        for t in o['tags']: tags.setdefault(lc(t), t)
        raw.append(o)

parts = [list(map(int, re.split(r'[./-]', d))) for o in raw for d in (o['sdate'], o['edate']) if d]
order = 'ymd' if any(len(str(p[0])) == 4 or p[0] > 31 for p in parts) else 'mdy' if any(p[1] > 12 for p in parts) else 'dmy'
def to_dt(d, t):
    p = list(map(int, re.split(r'[./-]', d)))
    m = re.match(r'^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$', t.strip(), re.I)
    h = int(m.group(1))
    if m.group(4):
        pm = m.group(4)[0].lower() == 'p'
        h = (12 if pm else 0) if h == 12 else h + 12 if pm else h
    y, mo, dd = p if order == 'ymd' else (p[2], p[0], p[1]) if order == 'mdy' else (p[2], p[1], p[0])
    return datetime(y + 2000 if y < 100 else y, mo, dd, h, int(m.group(2)), int(m.group(3) or 0), tzinfo=TZ)
iso = lambda d: d.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.') + f'{d.microsecond // 1000:03d}Z'

entries, refs, skipped = [], set(), {}
for o in raw:
    start = to_dt(o['sdate'], o['stime'])
    end = to_dt(o['edate'] or o['sdate'], o['etime']) if o['etime'] else start + timedelta(hours=num(o['dur']) or 0)
    if end < start: end += timedelta(days=1)
    ukey = lc(o['email']) or lc(o['user'])
    ref = '|'.join(['clockify', ukey, iso(start), iso(end), lc(o['project']), lc(o['description'])])
    if ref in refs: continue
    refs.add(ref)
    if re.match(r'^deleteduser', o['user'], re.I):  # verwijderde Clockify-gebruiker: niet importeren (zoals op de importpagina)
        skipped[o['user']] = skipped.get(o['user'], 0) + 1; continue
    entries.append((lc(o['email']), o['user'].strip(), o['project'], o['client'], o['description'], o['tags'], o['billable'], iso(start), iso(end), ref))

def values(rows, fmt):
    return ',\n'.join(fmt(r) for r in rows)

sql = [f"""-- =====================================================================
-- Polyfy - volledige import uit Clockify (gegenereerd)
-- Plak dit volledige bestand in Supabase > SQL Editor en klik Run.
-- Bevat: de database-updates (v2 t.e.m. de laatste) en de data.
-- Opnieuw uitvoeren mag: wat er al is wordt overgeslagen.
-- Inhoud: {len(clients)} klanten, {len(projects)} projecten, {len(tags)} tags, {len(entries)} registraties.
-- =====================================================================
""", *[open(f).read() for f in schemas], f"""
-- =====================================================================
-- Data
-- =====================================================================
begin;
-- Laat de eigenaarscontrole toe dat de SQL Editor uren voor anderen invoegt
select set_config('polyfy.claiming', '1', true);

create temp table imp_clients (name text) on commit drop;
insert into imp_clients values
{values(clients.values(), lambda n: f'({q(n)})')};
insert into public.clients (name)
  select i.name from imp_clients i
  where not exists (select 1 from public.clients c where lower(c.name) = lower(i.name));

create temp table imp_projects (name text, client text, billable boolean, budget numeric, rate numeric, color text) on commit drop;
insert into imp_projects values
{values(enumerate(projects.values()), lambda e: f"({q(e[1]['name'])}, {q(e[1]['client'] or None)}, {str(e[1]['billable']).lower()}, {q(e[1]['budget'])}, {q(e[1]['rate'])}, {q(COLORS[e[0] % len(COLORS)])})")};
insert into public.projects (name, client_id, billable, budget_hours, hourly_rate, color)
  select i.name, (select c.id from public.clients c where lower(c.name) = lower(i.client) limit 1), i.billable, i.budget, i.rate, i.color
  from imp_projects i
  where not exists (select 1 from public.projects p left join public.clients pc on pc.id = p.client_id
                    where lower(p.name) = lower(i.name) and lower(coalesce(pc.name, '')) = lower(coalesce(i.client, '')));

insert into public.tags (name) values
{values(tags.values(), lambda n: f'({q(n)})')}
on conflict do nothing;

create temp table imp_entries (email text, name text, project text, client text, description text, tags text[], billable boolean, start_at timestamptz, end_at timestamptz, ref text) on commit drop;
insert into imp_entries values
{values(entries, lambda e: f"({q(e[0])}, {q(e[1])}, {q(e[2] or None)}, {q(e[3] or None)}, {q(e[4])}, {q('{' + ','.join(chr(34) + t.replace(chr(92), chr(92)*2).replace(chr(34), chr(92)+chr(34)) + chr(34) for t in e[5]) + '}')}, {str(e[6]).lower()}, {q(e[7])}, {q(e[8])}, {q(e[9])})")};

-- Wie al een account heeft krijgt de uren meteen; anders wachten ze op een account met dat e-mailadres
insert into public.time_entries (user_id, import_email, import_name, project_id, description, billable, start_at, end_at, tag_ids, source_ref)
  select pr.id, case when pr.id is null then i.email end, case when pr.id is null then i.name end,
    (select p.id from public.projects p left join public.clients pc on pc.id = p.client_id
       where lower(p.name) = lower(i.project) and lower(coalesce(pc.name, '')) = lower(coalesce(i.client, '')) limit 1),
    i.description, i.billable, i.start_at, i.end_at,
    array(select t.id from public.tags t where lower(t.name) in (select lower(x) from unnest(i.tags) x)),
    i.ref
  from imp_entries i
  left join auth.users pr on lower(pr.email) = i.email and pr.email_confirmed_at is not null
  on conflict (source_ref) do nothing;

select set_config('polyfy.claiming', '', true);
commit;

-- Controle
select (select count(*) from public.projects) as projecten, (select count(*) from public.clients) as klanten,
       (select count(*) from public.tags) as tags, (select count(*) from public.time_entries) as registraties,
       (select count(*) from public.time_entries where user_id is null) as wachten_op_account;
"""]
open(out_path, 'w').write('\n'.join(sql))
hours = sum((datetime.fromisoformat(e[8].replace('Z', '+00:00')) - datetime.fromisoformat(e[7].replace('Z', '+00:00'))).total_seconds() for e in entries) / 3600
print(f'{len(clients)} klanten, {len(projects)} projecten, {len(tags)} tags, {len(entries)} registraties ({hours:.1f} u), overgeslagen: {skipped}, clockify-totaal {tracked:.1f} u')
