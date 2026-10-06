# Polyfy — projectcontext voor Claude

Polyfy is een **interne urenregistratie-website** (vervanger voor Clockify, dat betalend werd) voor het team van Seppe.
Taal van de UI, commits en communicatie: **Nederlands (Vlaams)**.

## Stack
- Statische site zonder build-stap: `index.html` (alle CSS), `app.js` (alle logica, vanilla JS), `config.js` (Supabase-URL + anon key).
- Backend: **Supabase** (auth met e-mail/wachtwoord + Postgres). supabase-js v2 via CDN (jsdelivr).
- Database: `supabase/schema.sql` (idempotent, uit te voeren in de Supabase SQL Editor).
- Hosting: GitHub Pages vanaf de root van `main` → `https://polygon-tools.github.io/Polyfy/`.

## Functies (allemaal aanwezig)
- Indeling en paginanamen volgen Clockify (Seppe gaf screenshots als voorbeeld): Time Tracker, Calendar · *Analyze*: Dashboard, Reports · *Manage*: Projects, Team, Clients, Tags, Import (admin). Geen Timesheet (op vraag verwijderd). De rest van de UI blijft Nederlands. Startpagina = Time Tracker. Duren als `hh:mm:ss` (`fmtHMS`).
- Gedeelde UI-bouwstenen in `app.js`: `openMenu` (uitklapmenu), `pickFrom`/`pickProject` (keuzelijst met zoeken, projecten per klant), periodekiezer `rangeHtml`/`bindRange` (`RANGES`, `rangeOf`, `shiftRange`), grafieken `barChart` (ook gestapeld via `segs`) en `donut`, `buckets` (dag/week/maand), `groupKeys`/`groupRows`/`groupText`.
- Time Tracker: balk met modus timer (start/stop) of manueel (start–einde als 24-uurs tekstvelden via `parseHM`, datum, duur via `parseDur`). Daaronder per week (weektotaal) en per dag (dagtotaal) de eigen registraties; gelijke registraties op een dag gegroepeerd met teller (uitklappen). Inline bewerken: omschrijving, project, tags, €, start/einde, datum; ⋮ = bewerken/dupliceren/verwijderen.
- Calendar: Week/Dag, zoom (−/+), collega kiezen (admin), periodekiezer; klik leeg vak = toevoegen, klik blok = bewerken.
- Dashboard: groeperen op project/klant/tag/(medewerker), Enkel ik/Team (admin), periode; totale tijd, topproject, topklant, gestapelde staven per dag, ring + lijst met %, top 10 activiteiten.
- Reports: tabbladen Samenvatting (groeperen op 2 niveaus, uitklapbaar, ring), Gedetailleerd, Wekelijks; filterbalk Team/Klant/Project/Tag/Omschrijving; periodekiezer; Exporteren → PDF (jsPDF + autotable via jsdelivr, pas geladen bij eerste export) of CSV (`;`, BOM). Bedrag enkel getoond als er tarieven zijn.
- Projects: zoeken, filter per klant en status, kleur, archiveren. Op vraag van Seppe géén tarief, budget of type (factureerbaar) meer in de UI (kolommen bestaan nog in de database). Clients en Tags hebben elk een eigen pagina (iedereen mag tags maken, admins wijzigen/verwijderen).
- Importeren (admin): Clockify-CSV (gedetailleerd rapport en/of projectlijst) → klanten, projecten, tags, registraties. Projectexport levert ook budget (Estimated), tarief en factureerbaar, en het Clockify-totaal (Tracked) waarmee de importpagina controleert of alle registraties mee zijn. Samenvattend rapport = enkel projecten. Medewerkers koppelen op e-mail/naam; dubbels vermeden via `time_entries.source_ref` (unieke index, upsert met ignoreDuplicates).
- Team: filter status/rol/zoeken, tabel naam/e-mail/uurtarief (Wijzig)/rol (klikbaar voor admin)/⋮ (bewerken, rapport, (de)activeren), "aan het werk"-label, collega's zonder account (uit `unclaimed_imports`) als "Nog geen account". "Nieuw lid toevoegen" = uitnodigingslink.

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
