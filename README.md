# Polyfy

Interne urenregistratie (alternatief voor Clockify) — statische website + Supabase.

**Functies** (paginanamen zoals in Clockify)
- **Time Tracker**: timer met omschrijving, project, tags, factureerbaar (€), start/stop, of registreer manueel. Daaronder je registraties per week.
- **Timesheet**: weekoverzicht per project; vul de uren per dag rechtstreeks in.
- **Dashboard**: uren vandaag / deze week (t.o.v. weekdoel) / deze maand, % factureerbaar, grafiek per dag, verdeling per project, recente registraties (opnieuw starten, bewerken, verwijderen). Beheerders zien wie er nu aan het werk is.
- **Calendar**: weekweergave; klik op een leeg vak om uren toe te voegen, klik op een blok om te bewerken. Beheerders kunnen de kalender van elke collega bekijken.
- **Reports**: periode (deze week, vorige maand, aangepast…), filters op medewerker, klant, project en tag. Samenvatting gegroepeerd op project / medewerker / klant / tag / dag / omschrijving, gedetailleerde lijst, bedragen, en export als **PDF** of **CSV** (opent in Excel).
- **Projects**: zoeken, filteren per klant, kleur, archiveren. **Clients** en **Tags** hebben elk een eigen pagina.
- **Import** (beheerders): registraties, projecten, klanten en tags overzetten uit een Clockify-export (CSV).
- **Team**: uren deze week t.o.v. weekdoel, wie nu werkt, rollen, uurtarieven, accounts deactiveren, uitnodigingslink.

**Rechten**
- De eerste persoon die een account maakt wordt automatisch **beheerder**; alle volgende zijn **medewerker**.
- Medewerkers zien en beheren enkel hun eigen registraties (het teamoverzicht toont wel ieders weektotaal).
- Beheerders beheren projecten, klanten, teamleden en kunnen alle uren zien en aanpassen.
- Dit wordt afgedwongen in de database (Row Level Security), niet enkel in de website.

## Installatie

1. **Supabase-project** — maak een nieuw (gratis) project op [supabase.com](https://supabase.com).
   Gebruik best een *apart* project, los van andere apps.
2. **Database** — open *SQL Editor*, plak de inhoud van [`supabase/schema.sql`](supabase/schema.sql) en klik *Run*.
3. **Sleutels** — kopieer onder *Project Settings → API* de *Project URL* en de *anon public* key naar [`config.js`](config.js).
   Zet eventueel `ALLOWED_EMAIL_DOMAIN` op het domein van je bedrijf.
4. **Auth-instellingen** — onder *Authentication → URL Configuration*: zet *Site URL* op het adres van je site
   (bv. `https://polygon-tools.github.io/Polyfy/`) zodat bevestigings- en resetmails juist terugverwijzen.
   Wil je geen bevestigingsmail? Zet dan *Authentication → Providers → Email → Confirm email* uit.
5. **Online zetten** — via GitHub Pages (Settings → Pages → *Deploy from a branch*, map `/ (root)`):
   de app staat dan op `https://polygon-tools.github.io/Polyfy/`. Elke push naar die branch zet de nieuwe versie online.
6. Maak als eerste je eigen account aan (→ beheerder) en deel daarna de link uit de pagina *Team* met je collega's.

> Tip: wil je inschrijven volledig afsluiten voor buitenstaanders, zet dan in Supabase
> *Authentication → Providers → Email → Allow new users to sign up* uit en nodig collega's uit
> via *Authentication → Users → Invite user*.

## Updates van de database

Nieuwe functies die de database wijzigen komen als apart script in `supabase/`. Voer ze **één keer** uit in de SQL Editor, na `schema.sql` (opnieuw uitvoeren mag):

| Script | Voor |
|---|---|
| [`supabase/schema-v2-tags-import.sql`](supabase/schema-v2-tags-import.sql) | tags en importeren uit Clockify |
| [`supabase/schema-v3-import-zonder-account.sql`](supabase/schema-v3-import-zonder-account.sql) | uren importeren voor collega's die nog geen account hebben |

## Overzetten vanuit Clockify

1. Voer `schema-v2-tags-import.sql` en `schema-v3-import-zonder-account.sql` uit (zie hierboven).
2. Collega's hoeven nog geen account te hebben: hun uren worden geïmporteerd en automatisch gekoppeld zodra ze zich
   registreren (en hun e-mail bevestigen) met **hetzelfde e-mailadres als in Clockify**. Tot dan ziet enkel een beheerder ze.
   Ander e-mailadres gebruikt? Koppel ze dan manueel onder *Importeren → Wachten op een account*.
3. In Clockify: *Reports → Detailed*, kies de volledige periode, *Export → Save as CSV*. Optioneel ook de projectlijst
   (*Projects*, actief én gearchiveerd) als CSV, zodat ook oude projecten zonder uren in de export meekomen.
4. In Polyfy (als beheerder): *Importeren*, kies de bestanden, controleer de koppeling van medewerkers en klik *Importeren*.
   Klanten, projecten en tags die nog niet bestaan worden aangemaakt; alle projecten komen als *actief* binnen.
5. Opnieuw importeren is veilig: registraties die al geïmporteerd zijn worden overgeslagen.

Niet in de export, dus achteraf zelf instellen: uurtarieven, budgetten en weekdoelen.

## Lokaal testen

Het is pure HTML/JS zonder build-stap:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Bestanden

| Bestand | Inhoud |
|---|---|
| `index.html` | opmaak (licht/donker thema, mobielvriendelijk) |
| `app.js` | alle logica: login, timer, dashboard, kalender, rapporten, projecten, team, import |
| `config.js` | Supabase-URL en anon key |
| `supabase/schema.sql` | tabellen, beveiliging (RLS) en functies |
| `supabase/schema-v2-tags-import.sql` | update: tags en import |
| `supabase/schema-v3-import-zonder-account.sql` | update: import voor collega's zonder account |
