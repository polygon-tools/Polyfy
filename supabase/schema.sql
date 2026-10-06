-- =====================================================================
-- Polyfy - urenregistratie
-- Voer dit volledige script één keer uit in Supabase > SQL Editor.
-- Het script is idempotent: opnieuw uitvoeren mag.
-- =====================================================================

-- ---------- Profielen (1 per gebruiker) ----------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null default '',
  email       text not null default '',
  role        text not null default 'member' check (role in ('admin','member')),
  hourly_rate numeric(10,2) not null default 0,
  weekly_target numeric(5,2) not null default 38,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ---------- Klanten ----------
create table if not exists public.clients (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  archived   boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------- Projecten ----------
create table if not exists public.projects (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  client_id    uuid references public.clients(id) on delete set null,
  color        text not null default '#2a78d6',
  billable     boolean not null default true,
  hourly_rate  numeric(10,2),             -- leeg = tarief van de medewerker
  budget_hours numeric(10,2),             -- leeg = geen budget
  archived     boolean not null default false,
  created_at   timestamptz not null default now()
);

-- ---------- Tijdregistraties ----------
create table if not exists public.time_entries (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  project_id  uuid references public.projects(id) on delete set null,
  description text not null default '',
  start_at    timestamptz not null,
  end_at      timestamptz,                -- null = timer loopt nog
  billable    boolean not null default true,
  created_at  timestamptz not null default now(),
  constraint end_after_start check (end_at is null or end_at >= start_at)
);

create index if not exists time_entries_user_start on public.time_entries (user_id, start_at desc);
create index if not exists time_entries_project on public.time_entries (project_id);
-- Maximaal één lopende timer per gebruiker
create unique index if not exists one_running_timer on public.time_entries (user_id) where end_at is null;

-- ---------- Hulpfuncties ----------
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin' and active);
$$;

-- Nieuw account -> profiel. De allereerste gebruiker wordt automatisch admin.
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
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Gewone leden mogen hun rol, tarief of status niet zelf aanpassen.
create or replace function public.protect_profile_fields()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    new.role := old.role;
    new.hourly_rate := old.hourly_rate;
    new.active := old.active;
    new.weekly_target := old.weekly_target;
  end if;
  new.email := old.email;
  return new;
end $$;

drop trigger if exists protect_profile_fields on public.profiles;
create trigger protect_profile_fields before update on public.profiles
  for each row execute function public.protect_profile_fields();

-- Leden mogen geen uren meer registreren als hun account gedeactiveerd is,
-- en kunnen geen uren op naam van iemand anders zetten.
create or replace function public.check_entry_owner()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    if new.user_id <> auth.uid() then
      raise exception 'Je kan enkel je eigen uren registreren';
    end if;
    if not exists (select 1 from public.profiles where id = auth.uid() and active) then
      raise exception 'Je account is gedeactiveerd';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists check_entry_owner on public.time_entries;
create trigger check_entry_owner before insert or update on public.time_entries
  for each row execute function public.check_entry_owner();

-- ---------- Row Level Security ----------
alter table public.profiles     enable row level security;
alter table public.clients      enable row level security;
alter table public.projects     enable row level security;
alter table public.time_entries enable row level security;

-- Profielen: iedereen in het team ziet het team; je past je eigen profiel aan, admins alles.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated using (true);
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_admin()) with check (id = auth.uid() or public.is_admin());

-- Klanten & projecten: iedereen leest, admins beheren.
drop policy if exists clients_select on public.clients;
create policy clients_select on public.clients for select to authenticated using (true);
drop policy if exists clients_write on public.clients;
create policy clients_write on public.clients for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists projects_select on public.projects;
create policy projects_select on public.projects for select to authenticated using (true);
drop policy if exists projects_write on public.projects;
create policy projects_write on public.projects for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Tijdregistraties: je ziet en beheert je eigen uren; admins zien en beheren alles.
drop policy if exists entries_select on public.time_entries;
create policy entries_select on public.time_entries for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
drop policy if exists entries_insert on public.time_entries;
create policy entries_insert on public.time_entries for insert to authenticated
  with check (user_id = auth.uid() or public.is_admin());
drop policy if exists entries_update on public.time_entries;
create policy entries_update on public.time_entries for update to authenticated
  using (user_id = auth.uid() or public.is_admin()) with check (user_id = auth.uid() or public.is_admin());
drop policy if exists entries_delete on public.time_entries;
create policy entries_delete on public.time_entries for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- ---------- Teamoverzicht voor iedereen ----------
-- Leden zien enkel hun eigen registraties, maar het teamoverzicht toont wel
-- per collega de totalen van deze week en wie er nu aan iets werkt.
create or replace function public.team_summary(week_start timestamptz)
returns table (user_id uuid, week_seconds bigint, running_since timestamptz, running_project uuid, last_activity timestamptz)
language sql stable security definer set search_path = public as $$
  select p.id,
    coalesce((select sum(extract(epoch from (coalesce(e.end_at, now()) - greatest(e.start_at, week_start))))::bigint
              from time_entries e
              where e.user_id = p.id and coalesce(e.end_at, now()) > week_start
                and e.start_at < week_start + interval '7 days'), 0),
    (select e.start_at from time_entries e where e.user_id = p.id and e.end_at is null limit 1),
    (select e.project_id from time_entries e where e.user_id = p.id and e.end_at is null limit 1),
    (select max(coalesce(e.end_at, now())) from time_entries e where e.user_id = p.id)
  from profiles p
  where auth.uid() is not null;
$$;

-- Totaal geregistreerde uren per project (voor budgetbalken in het projectenoverzicht).
create or replace function public.project_totals()
returns table (project_id uuid, total_seconds bigint, billable_seconds bigint)
language sql stable security definer set search_path = public as $$
  select e.project_id,
    sum(extract(epoch from (coalesce(e.end_at, now()) - e.start_at)))::bigint,
    sum(case when e.billable then extract(epoch from (coalesce(e.end_at, now()) - e.start_at)) else 0 end)::bigint
  from time_entries e
  where e.project_id is not null and auth.uid() is not null
  group by e.project_id;
$$;

grant execute on function public.team_summary(timestamptz) to authenticated;
grant execute on function public.project_totals() to authenticated;
