# Polyfy — projectcontext voor Claude

Polyfy is een **interne urenregistratie-website** (vervanger voor Clockify, dat betalend werd) voor het team van Seppe.
Taal van de UI, commits en communicatie: **Nederlands (Vlaams)**.

## Stack
- Statische site zonder build-stap: `index.html` (alle CSS), `app.js` (alle logica, vanilla JS), `config.js` (Supabase-URL + anon key).
- Backend: **Supabase** (auth met e-mail/wachtwoord + Postgres). supabase-js v2 via CDN (jsdelivr).
- Database: `supabase/schema.sql` (idempotent, uit te voeren in de Supabase SQL Editor).
- Hosting: GitHub Pages vanaf de root van `main` → `https://polygon-tools.github.io/Polyfy/`.

## Functies (allemaal aanwezig)
- Timerbalk bovenaan elke pagina (omschrijving, project, factureerbaar €, start/stop) + manuele registratie.
- Dashboard: KPI's vandaag/week (vs weekdoel)/maand/% factureerbaar, staafgrafiek per dag, verdeling per project, recente registraties; admins zien "nu aan het werk".
- Kalender: weekweergave, klik leeg vak = toevoegen, klik blok = bewerken; admin kan collega kiezen.
- Rapporten: periodes + filters (medewerker, klant, project, factureerbaar), samenvatting per project/medewerker/klant/dag/omschrijving, gedetailleerde lijst, bedragen, CSV-export (`;`-gescheiden, BOM, voor Excel).
- Projecten & klanten: kleur, uurtarief, budget-uren met voortgang, archiveren.
- Team: weekuren vs doel, live status, rollen, tarieven, deactiveren, uitnodigingslink.

## Datamodel & rechten
- Tabellen: `profiles` (role admin|member, hourly_rate, weekly_target, active), `clients`, `projects`, `time_entries` (end_at null = lopende timer; max 1 per gebruiker).
- Eerste geregistreerde gebruiker wordt automatisch admin (trigger `handle_new_user`).
- RLS: leden zien/beheren enkel eigen uren; admins alles. Projecten/klanten: iedereen leest, admins schrijven.
- RPC's (security definer): `team_summary(week_start)` en `project_totals()`.
- Tarief = `projects.hourly_rate`, anders `profiles.hourly_rate`. Bedrag enkel voor factureerbare uren.

## Conventies
- Code-stijl: compacte vanilla JS, helpers bovenaan `app.js` (`esc`, `fmtHM`, `clipSec`, `fetchEntries`…). Altijd user-tekst door `esc()`.
- Projectkleuren: vaste, kleurenblind-gevalideerde lijst `PROJECT_COLORS` (niet zomaar uitbreiden).
- Licht/donker thema via CSS-variabelen op `:root`; mobielvriendelijk.
- Nieuwe databasewijzigingen: toevoegen als apart bestand `supabase/schema-vN-<naam>.sql` (idempotent) en vermelden in de README.

## Status / openstaand
- Repo staat in de organisatie: `polygon-tools/Polyfy`. Gebruik in links/tekst nooit een persoonlijke GitHub-naam.
- Supabase: `schema.sql` is uitgevoerd; Site URL en Redirect URL staan op `https://polygon-tools.github.io/Polyfy/`.
- `config.js` is ingevuld (project-URL + anon key van het echte Supabase-project).
- GitHub Pages staat aan (branch `main`, map `/ (root)`) → `https://polygon-tools.github.io/Polyfy/`.
- Code is getest met een nep-Supabase in een headless browser; eerste test tegen het echte project (account aanmaken → admin) moet nog gebeuren.
- Mogelijke uitbreidingen die ooit gevraagd kunnen worden: tags, taken binnen projecten, goedkeuren van timesheets, PDF-export, verlof/afwezigheden.
