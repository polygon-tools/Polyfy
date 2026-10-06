-- =====================================================================
-- Polyfy - v5: geïmporteerde uren automatisch koppelen bij het inloggen
-- Voer dit uit in Supabase > SQL Editor, NA schema.sql en v2 t.e.m. v4.
-- Het script is idempotent: opnieuw uitvoeren mag.
--
-- Bij elke login roept de website claim_my_entries() aan: alle geïmporteerde
-- uren met hetzelfde (bevestigde) e-mailadres als de ingelogde gebruiker komen
-- bij die gebruiker te staan. Ook voor wie al een account had vóór de import.
-- =====================================================================

create or replace function public.claim_my_entries()
returns integer language plpgsql security definer set search_path = public as $$
declare em text;
begin
  select email into em from auth.users where id = auth.uid() and email_confirmed_at is not null;
  if em is null then return 0; end if;
  return public.claim_entries(auth.uid(), em);
end $$;
grant execute on function public.claim_my_entries() to authenticated;

-- Meteen alles koppelen wat al kan (bestaande accounts met hetzelfde, bevestigde e-mailadres)
begin;
select set_config('polyfy.claiming', '1', true);
update public.time_entries e set user_id = u.id
  from auth.users u
  where e.user_id is null and u.email_confirmed_at is not null and lower(e.import_email) = lower(u.email);
commit;

-- Zaakvoerder (info@polygon3d.be) voorlopig géén beheerder: uitnodiging als beheerder weg,
-- en had die al een account, dan terug gewone medewerker.
delete from public.invites where email = 'info@polygon3d.be';
begin;
select set_config('polyfy.sql_admin', '1', true);
update public.profiles set role = 'member' where lower(email) = 'info@polygon3d.be';
commit;
