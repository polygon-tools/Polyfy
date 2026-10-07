-- =====================================================================
-- Polyfy - v7: iedereen mag nieuwe projecten aanmaken (zoals in Clockify)
-- Voer dit uit in Supabase > SQL Editor, NA schema.sql en v2 t.e.m. v6.
-- Het script is idempotent: opnieuw uitvoeren mag.
--
-- In het venster "Add time entry" (en de Time Tracker) kan je vanuit de projectlijst
-- meteen een nieuw project maken. Wijzigen, archiveren en verwijderen blijft enkel voor beheerders.
-- =====================================================================

drop policy if exists projects_insert on public.projects;
create policy projects_insert on public.projects for insert to authenticated with check (true);
