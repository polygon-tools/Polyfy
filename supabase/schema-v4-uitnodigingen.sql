-- =====================================================================
-- Polyfy - v4: collega's vooraf uitnodigen met een rol (bv. de zaakvoerder als beheerder)
-- Voer dit uit in Supabase > SQL Editor, NA schema.sql, v2 en v3.
-- Het script is idempotent: opnieuw uitvoeren mag.
--
-- Een beheerder zet een e-mailadres + naam + rol klaar (pagina Team > Nieuw lid toevoegen).
-- Wie zich met dat e-mailadres registreert, krijgt meteen die rol; de uitnodiging verdwijnt dan.
-- =====================================================================

create table if not exists public.invites (
  email      text primary key check (email = lower(email)),
  full_name  text not null default '',
  role       text not null default 'member' check (role in ('admin','member')),
  created_at timestamptz not null default now()
);

alter table public.invites enable row level security;
drop policy if exists invites_admin on public.invites;
create policy invites_admin on public.invites for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Nieuw account -> profiel. Rol uit de uitnodiging (of admin voor de allereerste gebruiker),
-- en geïmporteerde uren koppelen als het e-mailadres al bevestigd is (zie v3).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare inv public.invites;
begin
  select * into inv from public.invites where email = lower(coalesce(new.email, ''));
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(nullif(new.raw_user_meta_data->>'full_name', ''), nullif(inv.full_name, ''), split_part(coalesce(new.email,''), '@', 1)),
    case when not exists (select 1 from public.profiles) then 'admin' else coalesce(inv.role, 'member') end
  )
  on conflict (id) do nothing;
  delete from public.invites where email = lower(coalesce(new.email, ''));
  if new.email_confirmed_at is not null and new.email is not null then
    perform public.claim_entries(new.id, new.email);
  end if;
  return new;
end $$;

-- Rol, tarief en status beschermen tegen niet-admins; uitzondering voor dit script (vlag polyfy.sql_admin)
create or replace function public.protect_profile_fields()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() and coalesce(current_setting('polyfy.sql_admin', true), '') <> '1' then
    new.role := old.role;
    new.hourly_rate := old.hourly_rate;
    new.active := old.active;
    new.weekly_target := old.weekly_target;
  end if;
  new.email := old.email;
  return new;
end $$;

-- Zaakvoerder: beheerder. Heeft die al een account, dan meteen beheerder maken; anders klaarzetten.
begin;
select set_config('polyfy.sql_admin', '1', true);
update public.profiles set role = 'admin' where lower(email) = 'info@polygon3d.be';
commit;
insert into public.invites (email, full_name, role)
  select 'info@polygon3d.be', '', 'admin'
  where not exists (select 1 from public.profiles where lower(email) = 'info@polygon3d.be')
on conflict (email) do update set role = 'admin';
