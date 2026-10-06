# Polyfy

Interne urenregistratie (alternatief voor Clockify) — statische website + Supabase.

**Functies**
- **Timer** bovenaan elke pagina: omschrijving, project, factureerbaar (€), start/stop. Of registreer manueel.
- **Dashboard**: uren vandaag / deze week (t.o.v. weekdoel) / deze maand, % factureerbaar, grafiek per dag, verdeling per project, recente registraties (opnieuw starten, bewerken, verwijderen). Beheerders zien wie er nu aan het werk is.
- **Kalender**: weekweergave; klik op een leeg vak om uren toe te voegen, klik op een blok om te bewerken. Beheerders kunnen de kalender van elke collega bekijken.
- **Rapporten**: periode (deze week, vorige maand, aangepast…), filters op medewerker, klant, project en factureerbaar. Samenvatting gegroepeerd op project / medewerker / klant / dag / omschrijving, gedetailleerde lijst, bedragen, en **CSV-export** (opent in Excel).
- **Projecten**: klanten, kleur, uurtarief, budget in uren met voortgangsbalk, archiveren.
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
| `app.js` | alle logica: login, timer, dashboard, kalender, rapporten, projecten, team |
| `config.js` | Supabase-URL en anon key |
| `supabase/schema.sql` | tabellen, beveiliging (RLS) en functies |
