-- Browsers no longer touch the tables directly. Every read and write goes
-- through the functions below, which enforce the rules themselves:
--   * a tournament can only be read when its exact id is supplied
--     (no scanning the table for every tournament or owner name)
--   * "my tournaments" only returns the signed-in user's own rows
--   * owner user ids never leave the database; clients get is_owner
-- Guest / owner / edit_mode rules are unchanged from 0002.

-- A redraw may produce the same draw (tiny rosters), so only require that a
-- changed draw or version moves on by exactly one.
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
  if (new.rounds is distinct from old.rounds or new.draw_version <> old.draw_version)
     and new.draw_version <> old.draw_version + 1 then
    raise exception 'A redraw must advance draw_version by one' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on public.tournaments from anon, authenticated;
revoke all on public.game_results from anon, authenticated;
drop policy if exists "tournaments readable" on public.tournaments;
drop policy if exists "tournaments creatable" on public.tournaments;
drop policy if exists "tournaments updatable" on public.tournaments;
drop policy if exists "results readable" on public.game_results;
drop policy if exists "results writable" on public.game_results;
drop policy if exists "results editable" on public.game_results;
-- RLS stays enabled with no policies: direct table access is denied.

revoke execute on function public.can_score(public.tournaments) from public, anon, authenticated;

create or replace function public.tournament_json(t public.tournaments)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', t.id,
    'name', t.name,
    'target_score', t.target_score,
    'games_per_player', t.games_per_player,
    'players', t.players,
    'rounds', t.rounds,
    'draw_version', t.draw_version,
    'owned', t.owner_id is not null,
    'is_owner', coalesce(t.owner_id = (select auth.uid()), false),
    'owner_name', t.owner_name,
    'edit_mode', t.edit_mode,
    'created_at', t.created_at,
    'updated_at', t.updated_at,
    'game_results', coalesce((
      select jsonb_agg(jsonb_build_object(
        'draw_version', r.draw_version,
        'game_id', r.game_id,
        'score_a', r.score_a,
        'score_b', r.score_b
      ))
      from public.game_results r
      where r.tournament_id = t.id and r.draw_version = t.draw_version
    ), '[]'::jsonb)
  );
$$;
revoke execute on function public.tournament_json(public.tournaments) from public, anon, authenticated;

create or replace function public.get_tournament(p_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.tournament_json(t) from public.tournaments t where t.id = p_id;
$$;

create or replace function public.list_tournaments(p_ids text[])
returns table (id text, name text, created_at timestamptz, games_per_player integer, player_count integer)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id, t.name, t.created_at, t.games_per_player, jsonb_array_length(t.players)
  from public.tournaments t
  where t.id = any (p_ids[1:20]);
$$;

create or replace function public.my_tournaments(p_limit integer default 12)
returns table (id text, name text, created_at timestamptz, games_per_player integer, player_count integer)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id, t.name, t.created_at, t.games_per_player, jsonb_array_length(t.players)
  from public.tournaments t
  where (select auth.uid()) is not null and t.owner_id = (select auth.uid())
  order by t.created_at desc
  limit least(greatest(coalesce(p_limit, 12), 1), 50);
$$;

create or replace function public.create_tournament(
  p_id text,
  p_name text,
  p_target_score integer,
  p_games_per_player integer,
  p_players jsonb,
  p_rounds jsonb,
  p_edit_mode text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tournaments;
begin
  -- The insert trigger sets owner, owner name, draw version and, for
  -- guests, edit_mode = 'anyone'.
  insert into public.tournaments (id, name, target_score, games_per_player, players, rounds, edit_mode)
  values (
    p_id, p_name, p_target_score, p_games_per_player, p_players, p_rounds,
    case when p_edit_mode in ('owner', 'anyone') then p_edit_mode else 'owner' end
  )
  returning * into t;
  return public.tournament_json(t);
end;
$$;

create or replace function public.save_result(
  p_tournament_id text,
  p_draw_version integer,
  p_game_id text,
  p_score_a integer,
  p_score_b integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tournaments;
begin
  select * into t from public.tournaments where id = p_tournament_id for share;
  if not found then
    raise exception 'Tournament not found' using errcode = 'P0002';
  end if;
  -- coalesce: for guests auth.uid() is null, and null must mean "not owner".
  if not (t.owner_id is null or t.edit_mode = 'anyone' or coalesce(t.owner_id = (select auth.uid()), false)) then
    raise exception 'Only the owner can enter scores' using errcode = '42501';
  end if;
  if p_draw_version is distinct from t.draw_version then
    raise exception 'The draw has changed' using errcode = '40001';
  end if;
  if not jsonb_path_exists(t.rounds, '$[*].games[*] ? (@.id == $g)', jsonb_build_object('g', p_game_id)) then
    raise exception 'Unknown game' using errcode = '22023';
  end if;

  insert into public.game_results (tournament_id, draw_version, game_id, score_a, score_b)
  values (p_tournament_id, p_draw_version, p_game_id, p_score_a, p_score_b)
  on conflict (tournament_id, draw_version, game_id)
  do update set score_a = excluded.score_a, score_b = excluded.score_b;
end;
$$;

create or replace function public.redraw_tournament(p_id text, p_expected_version integer, p_rounds jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tournaments;
begin
  select * into t from public.tournaments where id = p_id for update;
  if not found then
    return false;
  end if;
  if not (t.owner_id is null or coalesce(t.owner_id = (select auth.uid()), false)) then
    raise exception 'Only the owner can regenerate the draw' using errcode = '42501';
  end if;
  if t.draw_version <> p_expected_version then
    return false;
  end if;
  update public.tournaments
  set rounds = p_rounds, draw_version = t.draw_version + 1
  where id = p_id;
  return true;
end;
$$;

create or replace function public.set_edit_mode(p_id text, p_mode text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_mode not in ('owner', 'anyone') then
    raise exception 'Invalid mode' using errcode = '22023';
  end if;
  update public.tournaments
  set edit_mode = p_mode
  where id = p_id
    and owner_id is not null
    and owner_id = (select auth.uid());
  return found;
end;
$$;

revoke execute on function public.get_tournament(text) from public;
revoke execute on function public.list_tournaments(text[]) from public;
revoke execute on function public.my_tournaments(integer) from public;
revoke execute on function public.create_tournament(text, text, integer, integer, jsonb, jsonb, text) from public;
revoke execute on function public.save_result(text, integer, text, integer, integer) from public;
revoke execute on function public.redraw_tournament(text, integer, jsonb) from public;
revoke execute on function public.set_edit_mode(text, text) from public;

grant execute on function public.get_tournament(text) to anon, authenticated;
grant execute on function public.list_tournaments(text[]) to anon, authenticated;
grant execute on function public.my_tournaments(integer) to anon, authenticated;
grant execute on function public.create_tournament(text, text, integer, integer, jsonb, jsonb, text) to anon, authenticated;
grant execute on function public.save_result(text, integer, text, integer, integer) to anon, authenticated;
grant execute on function public.redraw_tournament(text, integer, jsonb) to anon, authenticated;
grant execute on function public.set_edit_mode(text, text) to anon, authenticated;
