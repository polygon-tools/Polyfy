-- =====================================================================
-- Polyfy - v3: uren importeren voor collega's die nog geen account hebben
-- Voer dit uit in Supabase > SQL Editor, NA schema.sql en schema-v2-tags-import.sql.
-- Het script is idempotent: opnieuw uitvoeren mag.
--
-- Geïmporteerde uren zonder account krijgen user_id = null en het e-mailadres
-- uit Clockify. Zodra iemand met dat (bevestigde) e-mailadres een account maakt,
-- worden die uren automatisch aan het nieuwe account gekoppeld.
-- Tot dan ziet enkel een admin ze (RLS: user_id = auth.uid() of admin).
-- =====================================================================

alter table public.time_entries alter column user_id drop not null;
alter table public.time_entries add column if not exists import_email text;
alter table public.time_entries add column if not exists import_name text;
create index if not exists time_entries_unclaimed on public.time_entries (lower(import_email)) where user_id is null;

-- Uren zonder account koppelen aan een gebruiker (op e-mailadres)
create or replace function public.claim_entries(p_user uuid, p_email text)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  perform set_config('polyfy.claiming', '1', true);
  update public.time_entries set user_id = p_user
    where user_id is null and lower(import_email) = lower(p_email);
  get diagnostics n = row_count;
  perform set_config('polyfy.claiming', '', true);
  return n;
end $$;
revoke execute on function public.claim_entries(uuid, text) from public, anon, authenticated;

-- Eigenaarscontrole: het automatisch koppelen gebeurt zonder ingelogde gebruiker
create or replace function public.check_entry_owner()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if current_setting('polyfy.claiming', true) = '1' then
    return new;
  end if;
  if not public.is_admin() then
    if new.user_id is distinct from auth.uid() then
      raise exception 'Je kan enkel je eigen uren registreren';
    end if;
    if not exists (select 1 from public.profiles where id = auth.uid() and active) then
      raise exception 'Je account is gedeactiveerd';
    end if;
  end if;
  return new;
end $$;

-- Nieuw account -> profiel (ongewijzigd) + uren koppelen als het e-mailadres al bevestigd is
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data->>'full_name', split_part(coalesce(new.email,''), '@', 1)),
    case when exists (select 1 from public.profiles) then 'member' else 'admin' end
  )
  on conflict (id) do nothing;
  if new.email_confirmed_at is not null and new.email is not null then
    perform public.claim_entries(new.id, new.email);
  end if;
  return new;
end $$;

-- E-mailadres later bevestigd (via de bevestigingsmail) -> dan pas koppelen
create or replace function public.handle_user_confirmed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.email_confirmed_at is not null and old.email_confirmed_at is null and new.email is not null then
    perform public.claim_entries(new.id, new.email);
  end if;
  return new;
end $$;

drop trigger if exists on_auth_user_confirmed on auth.users;
create trigger on_auth_user_confirmed after update of email_confirmed_at on auth.users
  for each row execute function public.handle_user_confirmed();

-- Admin: overzicht van geïmporteerde uren die nog op een account wachten
create or replace function public.unclaimed_imports()
returns table (import_email text, import_name text, entries bigint, seconds bigint)
language sql stable security definer set search_path = public as $$
  select lower(e.import_email), max(e.import_name), count(*),
    sum(extract(epoch from (e.end_at - e.start_at)))::bigint
  from time_entries e
  where e.user_id is null and public.is_admin()
  group by lower(e.import_email)
  order by 3 desc;
$$;

-- Admin: wachtende uren manueel aan een bestaand account koppelen (bv. ander e-mailadres)
create or replace function public.assign_imported(p_email text, p_user uuid)
returns integer language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Enkel voor beheerders'; end if;
  return public.claim_entries(p_user, p_email);
end $$;

grant execute on function public.unclaimed_imports() to authenticated;
grant execute on function public.assign_imported(text, uuid) to authenticated;
