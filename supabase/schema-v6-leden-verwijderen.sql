-- =====================================================================
-- Polyfy - v6: leden verwijderen (enkel beheerders) + Jeroen toevoegen
-- Voer dit uit in Supabase > SQL Editor, NA schema.sql en v2 t.e.m. v5.
-- Het script is idempotent: opnieuw uitvoeren mag.
--
-- remove_member(email): het account (of de uitnodiging) verdwijnt, maar de uren blijven
-- bewaard onder de naam van die persoon, zodat de projecttotalen blijven kloppen.
-- Ze worden gemarkeerd als vroegere medewerker (import_email 'deleteduser:<email>'):
-- niet meer zichtbaar in Team en nooit meer automatisch te koppelen.
-- =====================================================================

create or replace function public.remove_member(p_email text)
returns integer language plpgsql security definer set search_path = public as $$
declare
  em text := lower(trim(p_email));
  pr public.profiles;
  n integer;
begin
  if not public.is_admin() then raise exception 'Only admins can remove members'; end if;
  select * into pr from public.profiles where lower(email) = em;
  if pr.id = auth.uid() then raise exception 'You cannot remove yourself'; end if;

  -- Uren bewaren als vroegere medewerker (lopende timer wordt gestopt)
  perform set_config('polyfy.claiming', '1', true);
  update public.time_entries set
      end_at = coalesce(end_at, now()),
      import_name = coalesce(nullif(pr.full_name, ''), import_name, em),
      import_email = 'deleteduser:' || em,
      user_id = null
    where (pr.id is not null and user_id = pr.id) or (user_id is null and lower(import_email) = em);
  get diagnostics n = row_count;
  perform set_config('polyfy.claiming', '', true);

  delete from public.invites where email = em;
  if pr.id is not null then
    delete from auth.users where id = pr.id;   -- profiel verdwijnt mee (on delete cascade)
  end if;
  return n;
end $$;
revoke execute on function public.remove_member(text) from public, anon;
grant execute on function public.remove_member(text) to authenticated;

-- Jeroen (gegevens gewist in Clockify): gewoon lid, zonder uren
insert into public.invites (email, full_name, role)
  select 'jeroen@polygon3d.be', 'Jeroen', 'member'
  where not exists (select 1 from public.profiles where lower(email) = 'jeroen@polygon3d.be')
on conflict (email) do nothing;
