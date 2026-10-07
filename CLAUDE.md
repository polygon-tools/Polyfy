# Polyfy — projectcontext voor Claude

Polyfy is een **interne urenregistratie-website** (vervanger voor Clockify, dat betalend werd) voor het team van Polygon (Seppe). Hoofddoel: elke collega vult zijn/haar uren in per project; periodiek (bv. eind van de maand) worden de gegevens opgevraagd en geëxporteerd (Reports → PDF/CSV). Geen facturatie/uurtarieven.
Taal: de **UI is Engels** (zoals Clockify, op vraag van Seppe); commits, documentatie en communicatie met Seppe in het **Nederlands (Vlaams)**. Datums Engels zoals Clockify ("Tue, Sep 29", `fmtDate` met en-US; numerieke datums en-GB dd/mm/jjjj), tijden altijd 24-uurs.

## Stack
- Statische site zonder build-stap: `index.html` (alle CSS), `app.js` (alle logica, vanilla JS), `config.js` (Supabase-URL + anon key).
- Backend: **Supabase** (auth met e-mail/wachtwoord + Postgres). supabase-js v2 via CDN (jsdelivr).
- Database: `supabase/schema.sql` (idempotent, uit te voeren in de Supabase SQL Editor).
- Hosting: GitHub Pages vanaf de root van `main` → `https://polygon-tools.github.io/Polyfy/`.

## Functies (allemaal aanwezig)
- Uitzicht en indeling volgen Clockify zo dicht mogelijk (Seppe: "mag bijna een kopie zijn"): witte bovenbalk (logo, POLYGON, avatar = profiel), wit zijmenu met hoofdletters en secties ANALYZE/MANAGE, Clockify-blauw `#03a9f4`, Roboto, rechte hoeken (2px), grijze dagkoppen (`--head`), knoppen in hoofdletters, groene staven in Reports. Eigen naam/logo Polyfy behouden. Alle UI-teksten Engels met Clockify-termen (What have you worked on?, Week total, Summary/Detailed/Weekly, Group by, Add new member, Admin/Member…). Geen Timesheet. Startpagina = Time Tracker. Duren als `hh:mm:ss` (`fmtHMS`).
- Gedeelde UI-bouwstenen in `app.js`: `openMenu` (uitklapmenu), `pickFrom`/`pickProject` (keuzelijst met zoeken, projecten per klant; gebruikt in de timerbalk, de registraties én het venster Add/Edit time entry), periodekiezer `rangeHtml`/`bindRange` (`RANGES`, `rangeOf`, `shiftRange`), grafieken `barChart` (ook gestapeld via `segs`) en `donut`, `buckets` (dag/week/maand), `groupKeys`/`groupRows`/`groupText`.
- Time Tracker: toont altijd de meest recente eigen registraties (per 50, "Load more"), niet enkel de laatste weken. Balk met modus timer (start/stop) of manueel (start–einde als 24-uurs tekstvelden via `parseHM`, datum, duur via `parseDur`). Daaronder per week (weektotaal) en per dag (dagtotaal) de eigen registraties; gelijke registraties op een dag gegroepeerd met teller (uitklappen). Inline bewerken: omschrijving, project, tags, €, start/einde, datum; ⋮ = bewerken/dupliceren/verwijderen.
- Venster Add/Edit time entry (`openEntryModal`) zoals Clockify: "Time and date" (duur | start - einde | datum; duur typen verschuift het einde), daaronder Description (textarea), Project * (verplicht, `pickProject` met zoeken), Tags (`openTagPop`), User (admin, enkel bij nieuw), Billable-schakelaar; Cancel/ADD (SAVE bij bewerken).
- Calendar: Week/Dag, zoom (−/+), collega kiezen (admin), periodekiezer. Slepen per kwartier (`bindCalendarDrag`, pointer events): klik leeg vak = 1 u toevoegen, klik+sleep = blok van die tijd, blok slepen = verplaatsen (ook naar andere dag), onderrand (`.rz`) slepen = langer/korter, klik blok = bewerken. Enkel volledige, afgeronde blokken van jezelf (of admin) zijn sleepbaar; op touch: tikken = klikken, slepen = scrollen.
- Dashboard: groeperen op project/klant/tag/(medewerker), Enkel ik/Team (admin), periode; totale tijd, topproject, topklant, gestapelde staven per dag, ring + lijst met %, top 10 activiteiten.
- Reports: tabbladen Samenvatting (groeperen op 2 niveaus, uitklapbaar, ring), Gedetailleerd, Wekelijks; filterbalk Team/Klant/Project/Tag/Omschrijving; periodekiezer; Exporteren → PDF zoals het Clockify "Summary report" (staand A4, jsPDF + autotable via jsdelivr, pas geladen bij eerste export): titel/periode/totaal + Polyfy-logo, groene staafgrafiek met schuine datums, per groepering (g1, g2) een ring + top 10-lijst met %, daarna tabel groep/subgroep (bij Detailed: lijst registraties), voettekst "POLYGON · Created with Polyfy · pagina" of CSV (`;`, BOM).
- Projects: zoeken, filter per klant en status, sorteren (knop A-Z/Z-A en klikbare kolomkoppen Name/Client/Tracked), kleur, archiveren. Géén tarief, budget of type (factureerbaar) in de UI (kolommen bestaan nog in de database). Clients en Tags hebben elk een eigen pagina (iedereen mag tags maken, admins wijzigen/verwijderen).
- Geen Import-pagina meer (op vraag verwijderd). Importeren gebeurt met `tools/clockify_naar_sql.py` (SQL-bestand voor de SQL Editor). Bij elke login roept de app `claim_my_entries()` (v5) aan: geïmporteerde uren met het bevestigde e-mailadres van de gebruiker komen automatisch bij die gebruiker, zonder manueel koppelen.
- Team: filter status/rol/zoeken, tabel naam/e-mail/rol (klikbaar voor admin)/⋮ (bewerken, rapport, (de)activeren, Delete via RPC `remove_member` (v6): account/uitnodiging weg, uren blijven als vroegere medewerker onder de naam), "aan het werk"-label. Ook wie nog geen account heeft: uitnodigingen (`invites`) en collega's met geïmporteerde uren (`unclaimed_imports`). "Nieuw lid toevoegen" = e-mail + naam + rol klaarzetten (v4) en de link delen.

## Datamodel & rechten
- Tabellen: `profiles` (role admin|member, hourly_rate, weekly_target, active), `clients`, `projects`, `time_entries` (end_at null = lopende timer; max 1 per gebruiker; `tag_ids uuid[]`, `source_ref`), `tags` (v2).
- `schema-v6-leden-verwijderen.sql`: RPC `remove_member(email)` (enkel admin, niet jezelf): uren → `user_id` null, `import_email` 'deleteduser:<email>', `import_name` = naam (lopende timer gestopt); uitnodiging en `auth.users` verwijderd. Zet ook jeroen@polygon3d.be (gegevens gewist in Clockify, geen uren) als member-uitnodiging klaar.
- `schema-v5-automatisch-koppelen.sql`: RPC `claim_my_entries()` (koppelt bij login), koppelt meteen alles wat al kan (enkel bevestigde accounts) en zet info@polygon3d.be (zaakvoerder) **géén beheerder** (uitnodiging weg, bestaand account → member). De zaakvoerder is een gewone Member met dezelfde rechten als de rest (hij bekijkt enkel, registreert niets); geen aparte rol nodig.
- `schema-v4-uitnodigingen.sql`: tabel `invites` (email lowercase, full_name, role; enkel admins). `handle_new_user` neemt rol/naam over uit de uitnodiging en verwijdert ze. `protect_profile_fields` laat wijzigingen toe met vlag `polyfy.sql_admin` (enkel voor SQL-scripts). (Zaakvoerder-als-beheerder is uit v4 gehaald; zie v5.)
- `schema-v3-import-zonder-account.sql`: `time_entries.user_id` mag null zijn (geïmporteerd, nog geen account) met `import_email`/`import_name`; trigger op `auth.users` koppelt bij bevestigde e-mail via `claim_entries` (flag `polyfy.claiming` laat `check_entry_owner` door). RPC's `unclaimed_imports()` en `assign_imported(email, user)` (admin). App detecteert v3 via `S.pendingReady`.
- `schema-v2-tags-import.sql`: tags + import. De app werkt ook zonder (`S.tagsReady` = false → geen tags/import, `tagField()` laat `tag_ids` weg).
- Eerste geregistreerde gebruiker wordt automatisch admin (trigger `handle_new_user`).
- RLS: leden zien/beheren enkel eigen uren; admins alles. Projecten/klanten: iedereen leest, admins schrijven.
- RPC's (security definer): `team_summary(week_start)` en `project_totals()`.
- Uurtarieven zijn op vraag van Seppe volledig uit de UI en exports gehaald (kolommen `hourly_rate`/`budget_hours` bestaan nog in de database, ongebruikt).

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
- **Live in gebruik**: Seppe heeft een account (seppe@polygon3d.be, admin). In Supabase zijn `schema.sql` en v2 t.e.m. v5 uitgevoerd (v2–v5 zaten in deel 1 van de import).
- Supabase: *Confirm email* staat aan; de link is met het team gedeeld (okt 2026).
- **Clockify-import voltooid** (okt 2026): 23.003 registraties (nov 2022 – okt 2026) staan in Supabase. Collega's krijgen hun uren automatisch bij het inloggen met hun Clockify-adres (bevestigd e-mailadres vereist).
- `config.js`: `ALLOWED_EMAIL_DOMAIN = 'polygon3d.be'`.
- `tools/clockify_naar_sql.py`: zet Clockify-CSV's om naar één SQL-bestand (v2 + v3 + data, idempotent) dat Seppe in de SQL Editor plakt, zodat hij niet zelf via de site moet importeren. Uitvoer bevat persoonsgegevens → nooit committen. Eerste bestand (jul–okt 2026 + 744 projecten) aan Seppe bezorgd. Volledige historiek (Detailed per jaar 2022–2026, 23.003 registraties, 58.699 u, nov 2022 – okt 2026) omgezet naar SQL-delen van 1500 registraties (~0,5 MB; delen van 1 MB werden bij het plakken in de SQL Editor afgekapt) en aan Seppe bezorgd; getest op Postgres (geen dubbels met de eerste import, idempotent). Verwijderde Clockify-gebruikers (12) worden geïmporteerd als "Former employee N" (import_email deleteduser…@clockify-test.com, nooit koppelbaar); de app toont ze zonder "(no account yet)" en verbergt ze in Team. Het script voegt alle opgegeven `schema-v*.sql` in volgorde vooraan toe en koppelt enkel aan bevestigde accounts.
- Mogelijke uitbreidingen die ooit gevraagd kunnen worden: taken binnen projecten, goedkeuren van timesheets, PDF-export, verlof/afwezigheden.
