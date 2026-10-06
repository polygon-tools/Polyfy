# Polyfy — projectcontext voor Claude

Polyfy is een **interne urenregistratie-website** (vervanger voor Clockify, dat betalend werd) voor het team van Seppe.
Taal van de UI, commits en communicatie: **Nederlands (Vlaams)**.

## Stack
- Statische site zonder build-stap: `index.html` (alle CSS), `app.js` (alle logica, vanilla JS), `config.js` (Supabase-URL + anon key).
- Backend: **Supabase** (auth met e-mail/wachtwoord + Postgres). supabase-js v2 via CDN (jsdelivr).
- Database: `supabase/schema.sql` (idempotent, uit te voeren in de Supabase SQL Editor).
- Hosting: GitHub Pages vanaf de root van `main` → `https://polygon-tools.github.io/Polyfy/`.

## Functies (allemaal aanwezig)
- Menu en paginanamen in het Engels zoals Clockify: Timesheet, Time Tracker, Calendar · *Analyze*: Dashboard, Reports · *Manage*: Projects, Team, Clients, Tags, Import (admin). De rest van de UI blijft Nederlands. Startpagina = Time Tracker.
- Time Tracker: timer (omschrijving, project, tags, €, start/stop) + manuele registratie + eigen registraties per week. Lopende timer zichtbaar in het menu en de paginatitel.
- Timesheet: week, rij per project, uren per dag rechtstreeks invullen (meer = registratie erbij na de laatste van die dag of vanaf 9:00; minder = laatste registraties van die dag inkorten/verwijderen). Admin kan collega kiezen.
- Dashboard: KPI's vandaag/week (vs weekdoel)/maand/% factureerbaar, staafgrafiek per dag, verdeling per project, recente registraties; admins zien "nu aan het werk".
- Kalender: weekweergave, klik leeg vak = toevoegen, klik blok = bewerken; admin kan collega kiezen.
- Reports: periodes + filters (medewerker, klant, project, tag), samenvatting per project/medewerker/klant/tag/dag/omschrijving, gedetailleerde lijst, bedragen, CSV-export (`;`-gescheiden, BOM, voor Excel) en PDF-export (jsPDF + autotable, pas geladen bij eerste export via jsdelivr).
- Projects: zoeken, filter per klant en status, kleur, archiveren. Op vraag van Seppe géén tarief, budget of type (factureerbaar) meer in de UI (kolommen bestaan nog in de database). Clients en Tags hebben elk een eigen pagina (iedereen mag tags maken, admins wijzigen/verwijderen).
- Importeren (admin): Clockify-CSV (gedetailleerd rapport en/of projectlijst) → klanten, projecten, tags, registraties. Projectexport levert ook budget (Estimated), tarief en factureerbaar, en het Clockify-totaal (Tracked) waarmee de importpagina controleert of alle registraties mee zijn. Samenvattend rapport = enkel projecten. Medewerkers koppelen op e-mail/naam; dubbels vermeden via `time_entries.source_ref` (unieke index, upsert met ignoreDuplicates).
- Team: weekuren vs doel, live status, rollen, tarieven, deactiveren, uitnodigingslink.

## Datamodel & rechten
- Tabellen: `profiles` (role admin|member, hourly_rate, weekly_target, active), `clients`, `projects`, `time_entries` (end_at null = lopende timer; max 1 per gebruiker; `tag_ids uuid[]`, `source_ref`), `tags` (v2).
- `schema-v3-import-zonder-account.sql`: `time_entries.user_id` mag null zijn (geïmporteerd, nog geen account) met `import_email`/`import_name`; trigger op `auth.users` koppelt bij bevestigde e-mail via `claim_entries` (flag `polyfy.claiming` laat `check_entry_owner` door). RPC's `unclaimed_imports()` en `assign_imported(email, user)` (admin). App detecteert v3 via `S.pendingReady`.
- `schema-v2-tags-import.sql`: tags + import. De app werkt ook zonder (`S.tagsReady` = false → geen tags/import, `tagField()` laat `tag_ids` weg).
- Eerste geregistreerde gebruiker wordt automatisch admin (trigger `handle_new_user`).
- RLS: leden zien/beheren enkel eigen uren; admins alles. Projecten/klanten: iedereen leest, admins schrijven.
- RPC's (security definer): `team_summary(week_start)` en `project_totals()`.
- Tarief = `profiles.hourly_rate` (per medewerker, in Team). Bedrag enkel voor factureerbare uren.

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
- `config.js`: `ALLOWED_EMAIL_DOMAIN = 'polygon3d.be'`.
- `tools/clockify_naar_sql.py`: zet Clockify-CSV's om naar één SQL-bestand (v2 + v3 + data, idempotent) dat Seppe in de SQL Editor plakt, zodat hij niet zelf via de site moet importeren. Uitvoer bevat persoonsgegevens → nooit committen. Eerste bestand (jul–okt 2026 + 744 projecten) aan Seppe bezorgd; de volledige historiek (Clockify-totaal 58.425 u) moet hij nog exporteren (Reports → Detailed, eventueel per jaar).
- Tags en Clockify-import gebouwd en getest met een nep-Supabase en een echte Clockify-export (938 registraties). `schema-v2` en `schema-v3` moeten nog uitgevoerd worden in Supabase, daarna importeren (kan vóór collega's een account hebben). Alle SQL-scripts getest op lokale Postgres 16 met nagebootste auth.
- Mogelijke uitbreidingen die ooit gevraagd kunnen worden: taken binnen projecten, goedkeuren van timesheets, PDF-export, verlof/afwezigheden.
