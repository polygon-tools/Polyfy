-- =====================================================================
-- Polyfy - v10: iedereen mag van elk project de naam, klant en kleur aanpassen
-- Voer dit uit in Supabase > SQL Editor (v9 hoeft niet eerst; dit script bevat alles).
-- Het script is idempotent: opnieuw uitvoeren mag.
--
-- Vervangt de beperking van v9 (enkel zelf gemaakte projecten).
-- Archiveren en verwijderen blijft enkel voor beheerders.
-- =====================================================================

drop policy if exists projects_update_own on public.projects;
drop policy if exists projects_update_all on public.projects;
create policy projects_update_all on public.projects for update to authenticated
  using (true) with check (true);

-- Niet-beheerders mogen enkel naam, klant en kleur wijzigen
create or replace function public.protect_project_fields()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    new.archived := old.archived;
    new.billable := old.billable;
    new.hourly_rate := old.hourly_rate;
    new.budget_hours := old.budget_hours;
  end if;
  return new;
end $$;

drop trigger if exists protect_project_fields on public.projects;
create trigger protect_project_fields before update on public.projects
  for each row execute function public.protect_project_fields();
