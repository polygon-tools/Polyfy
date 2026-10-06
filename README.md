# Polyfy

Interne urenregistratie (alternatief voor Clockify) — statische website + Supabase.

**Functies** (indeling, uitzicht en Engelse teksten zoals in Clockify)
- **Time Tracker**: timer met omschrijving, project, tags, factureerbaar (€), start/stop, of manueel met start- en eindtijd. Daaronder je registraties per week en per dag, rechtstreeks aan te passen.
- **Dashboard**: totale tijd, topproject en topklant, staafgrafiek per dag, verdeling (ring) per project/klant/tag/medewerker en de meest geregistreerde activiteiten, voor jezelf of (beheerders) het hele team.
- **Calendar**: week- of dagweergave met zoom; klik op een leeg vak om uren toe te voegen, klik op een blok om te bewerken. Beheerders kunnen de kalender van elke collega bekijken.
- **Reports**: Samenvatting, Gedetailleerd en Wekelijks, met filters op team, klant, project, tag en omschrijving. Exporteren als **PDF** of **CSV** (opent in Excel).
- **Projects**: zoeken, filteren per klant, kleur, archiveren. **Clients** en **Tags** hebben elk een eigen pagina.
- **Team**: leden met e-mail en rol; filteren en zoeken, rollen aanpassen, accounts deactiveren, nieuwe leden vooraf klaarzetten met een rol en uitnodigen.

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
| [`supabase/schema-v4-uitnodigingen.sql`](supabase/schema-v4-uitnodigingen.sql) | collega's vooraf klaarzetten met een rol |
| [`supabase/schema-v5-automatisch-koppelen.sql`](supabase/schema-v5-automatisch-koppelen.sql) | geïmporteerde uren automatisch koppelen bij het inloggen |

## Overzetten vanuit Clockify

1. In Clockify: *Reports → **Detailed*** (niet *Summary*), per jaar, *Export → Save as CSV*. Optioneel ook *Projects* als CSV.
2. Zet de bestanden om met `tools/clockify_naar_sql.py` (zie de uitleg bovenaan dat script) en voer het resultaat uit in de Supabase SQL Editor.
   Opnieuw uitvoeren is veilig: wat er al is, wordt overgeslagen.
3. Collega's maken zelf een account met hetzelfde e-mailadres als in Clockify. Bij het inloggen komen hun uren automatisch bij hen te staan.

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
| `supabase/schema-v4-uitnodigingen.sql` | update: uitnodigingen met rol |
| `supabase/schema-v5-automatisch-koppelen.sql` | update: uren automatisch koppelen bij login |
