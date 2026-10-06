-- =====================================================================
-- Polyfy - v2: tags + import uit Clockify
-- Voer dit uit in Supabase > SQL Editor, NA schema.sql.
-- Het script is idempotent: opnieuw uitvoeren mag.
-- =====================================================================

-- ---------- Tags ----------
create table if not exists public.tags (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  archived   boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists tags_name_unique on public.tags (lower(name));

-- Tags per registratie (lijst van tag-id's)
alter table public.time_entries add column if not exists tag_ids uuid[] not null default '{}';
-- Herkomst bij import (bv. 'clockify|…'), zodat opnieuw importeren geen dubbels maakt
alter table public.time_entries add column if not exists source_ref text;
create unique index if not exists time_entries_source_ref on public.time_entries (source_ref);

-- Tag verwijderd -> ook uit alle registraties halen
create or replace function public.remove_deleted_tag()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.time_entries set tag_ids = array_remove(tag_ids, old.id) where old.id = any(tag_ids);
  return old;
end $$;

drop trigger if exists remove_deleted_tag on public.tags;
create trigger remove_deleted_tag after delete on public.tags
  for each row execute function public.remove_deleted_tag();

-- Iedereen leest en mag een nieuwe tag maken; enkel admins wijzigen of verwijderen.
alter table public.tags enable row level security;
drop policy if exists tags_select on public.tags;
create policy tags_select on public.tags for select to authenticated using (true);
drop policy if exists tags_insert on public.tags;
create policy tags_insert on public.tags for insert to authenticated with check (true);
drop policy if exists tags_update on public.tags;
create policy tags_update on public.tags for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists tags_delete on public.tags;
create policy tags_delete on public.tags for delete to authenticated using (public.is_admin());
