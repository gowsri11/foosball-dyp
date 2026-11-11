-- Logged-in owners and guest tournaments.
--
-- Guest tournament (owner_id is null): anyone with the link can enter scores
-- and redraw, as before.
-- Owned tournament: created by a signed-in user, who becomes the owner.
--   edit_mode 'owner'  -> only the owner can enter scores
--   edit_mode 'anyone' -> anyone with the link can enter scores
--   Only the owner can redraw or change edit_mode, in either mode.

alter table public.tournaments
  add column if not exists owner_id uuid,
  add column if not exists owner_name text check (char_length(owner_name) <= 80),
  add column if not exists edit_mode text not null default 'anyone';

alter table public.tournaments drop constraint if exists tournaments_edit_mode_check;
alter table public.tournaments add constraint tournaments_edit_mode_check
  check (edit_mode in ('owner', 'anyone') and (owner_id is not null or edit_mode = 'anyone'));

create index if not exists tournaments_owner_idx
  on public.tournaments (owner_id, created_at desc) where owner_id is not null;

-- Who may enter scores in a tournament right now.
create or replace function public.can_score(t public.tournaments)
returns boolean
language sql
stable
set search_path = ''
as $$
  select t.owner_id is null
      or t.edit_mode = 'anyone'
      or t.owner_id = (select auth.uid());
$$;

-- Owner is always taken from the signed-in session, never from the request.
create or replace function public.tournaments_before_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  claims jsonb := coalesce(auth.jwt(), '{}'::jsonb);
begin
  new.owner_id := auth.uid();
  new.draw_version := 1;
  if new.owner_id is null then
    new.owner_name := null;
    new.edit_mode := 'anyone';
  else
    new.owner_name := left(coalesce(
      nullif(claims -> 'user_metadata' ->> 'full_name', ''),
      nullif(claims -> 'user_metadata' ->> 'name', ''),
      split_part(claims ->> 'email', '@', 1),
      'Owner'
    ), 80);
    new.edit_mode := coalesce(new.edit_mode, 'owner');
  end if;
  return new;
end;
$$;

drop trigger if exists tournaments_set_owner on public.tournaments;
create trigger tournaments_set_owner
  before insert on public.tournaments
  for each row execute function public.tournaments_before_insert();

-- Updates: a redraw must move the draw on by exactly one, and ownership is
-- fixed. RLS below already limits owned tournaments to their owner.
create or replace function public.tournaments_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.owner_id is distinct from old.owner_id
     or new.owner_name is distinct from old.owner_name then
    raise exception 'Ownership cannot be changed' using errcode = '42501';
  end if;
  if new.rounds is distinct from old.rounds
     and new.draw_version <> old.draw_version + 1 then
    raise exception 'A redraw must advance draw_version by one' using errcode = '23514';
  end if;
  if new.rounds is not distinct from old.rounds
     and new.draw_version <> old.draw_version then
    raise exception 'draw_version only changes with a redraw' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists tournaments_guard_update on public.tournaments;
create trigger tournaments_guard_update
  before update on public.tournaments
  for each row execute function public.tournaments_before_update();

-- Saved scores: the key columns never change, so an upsert cannot move a
-- score to another game, draw or tournament.
create or replace function public.game_results_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.tournament_id <> old.tournament_id
     or new.draw_version <> old.draw_version
     or new.game_id <> old.game_id then
    raise exception 'A saved result cannot be moved' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists game_results_guard_update on public.game_results;
create trigger game_results_guard_update
  before update on public.game_results
  for each row execute function public.game_results_before_update();

-- Privileges
revoke all on public.tournaments from anon, authenticated;
grant select on public.tournaments to anon, authenticated;
grant insert (id, name, target_score, games_per_player, players, rounds, edit_mode)
  on public.tournaments to anon, authenticated;
grant update (rounds, draw_version, edit_mode) on public.tournaments to anon, authenticated;

-- Policies
drop policy if exists "tournaments redrawable" on public.tournaments;
drop policy if exists "tournaments updatable" on public.tournaments;
create policy "tournaments updatable" on public.tournaments
  for update to anon, authenticated
  using (owner_id is null or owner_id = (select auth.uid()))
  with check (owner_id is null or owner_id = (select auth.uid()));

drop policy if exists "results writable" on public.game_results;
create policy "results writable" on public.game_results
  for insert to anon, authenticated
  with check (exists (
    select 1 from public.tournaments t
    where t.id = tournament_id
      and t.draw_version = game_results.draw_version
      and public.can_score(t)
  ));

drop policy if exists "results editable" on public.game_results;
create policy "results editable" on public.game_results
  for update to anon, authenticated
  using (exists (
    select 1 from public.tournaments t
    where t.id = tournament_id and public.can_score(t)
  ))
  with check (exists (
    select 1 from public.tournaments t
    where t.id = tournament_id
      and t.draw_version = game_results.draw_version
      and public.can_score(t)
  ));
