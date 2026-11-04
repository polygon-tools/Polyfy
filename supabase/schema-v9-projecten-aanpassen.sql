-- =====================================================================
-- Polyfy - v9: projecten achteraf aanpassen (naam, klant, kleur)
-- Voer dit uit in Supabase > SQL Editor, NA schema.sql en v2 t.e.m. v8.
-- Het script is idempotent: opnieuw uitvoeren mag.
--
-- Beheerders konden al alle projecten aanpassen. Nu kan ook wie een project zelf gemaakt heeft
-- (bv. vanuit de projectlijst in de Calendar) achteraf de naam, de klant en de kleur aanpassen.
-- Archiveren en verwijderen blijft enkel voor beheerders.
-- =====================================================================

-- Wie heeft het project gemaakt (bestaande/geïmporteerde projecten: leeg = enkel beheerders)
alter table public.projects add column if not exists created_by uuid default auth.uid()
  references public.profiles(id) on delete set null;

drop policy if exists projects_update_own on public.projects;
create policy projects_update_own on public.projects for update to authenticated
  using (created_by = auth.uid()) with check (created_by = auth.uid());

-- Niet-beheerders mogen enkel naam, klant en kleur wijzigen
create or replace function public.protect_project_fields()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    new.archived := old.archived;
    new.created_by := old.created_by;
    new.billable := old.billable;
    new.hourly_rate := old.hourly_rate;
    new.budget_hours := old.budget_hours;
  end if;
  return new;
end $$;

drop trigger if exists protect_project_fields on public.projects;
create trigger protect_project_fields before update on public.projects
  for each row execute function public.protect_project_fields();
