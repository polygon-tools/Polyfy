-- =====================================================================
-- Polyfy - v8: favoriete projecten (ster in de projectlijst)
-- Voer dit uit in Supabase > SQL Editor, NA schema.sql en v2 t.e.m. v7.
-- Het script is idempotent: opnieuw uitvoeren mag.
--
-- Elke gebruiker duidt met een ster zijn favoriete projecten aan; die staan bovenaan
-- in de projectlijst (Calendar, Time Tracker). Bewaard per account, dus op elk toestel hetzelfde.
-- Iedereen mag zijn eigen profiel aanpassen (policy profiles_update), dus geen extra rechten nodig.
-- =====================================================================

alter table public.profiles add column if not exists favorite_projects uuid[] not null default '{}';
