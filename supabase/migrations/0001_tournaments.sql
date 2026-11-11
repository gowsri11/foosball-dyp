-- Foosball DYP: shared tournaments with live results.
-- No auth yet: anyone with the publishable key can read, create tournaments,
-- save scores and redraw. Deletes are not allowed. Tighten once auth lands.

create table if not exists public.tournaments (
  id text primary key check (id ~ '^[A-Za-z0-9]{8,24}$'),
  name text not null check (char_length(name) between 1 and 48),
  target_score integer not null check (target_score in (7, 10)),
  games_per_player integer not null check (games_per_player between 1 and 20),
  players jsonb not null check (
    jsonb_typeof(players) = 'array'
    and jsonb_array_length(players) between 4 and 40
    and not jsonb_path_exists(
      players,
      '$[*] ? (!(@.id like_regex "^p[0-9]{1,3}$") || @.name.type() != "string")'
    )
  ),
  rounds jsonb not null check (
    jsonb_typeof(rounds) = 'array' and pg_column_size(rounds) < 500000
  ),
  draw_version integer not null default 1 check (draw_version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.game_results (
  tournament_id text not null references public.tournaments (id) on delete cascade,
  draw_version integer not null,
  game_id text not null check (char_length(game_id) <= 16),
  score_a integer not null check (score_a between 0 and 10),
  score_b integer not null check (score_b between 0 and 10),
  updated_at timestamptz not null default now(),
  primary key (tournament_id, draw_version, game_id)
);

create index if not exists tournaments_created_at_idx
  on public.tournaments (created_at desc);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists tournaments_touch on public.tournaments;
create trigger tournaments_touch
  before update on public.tournaments
  for each row execute function public.touch_updated_at();

drop trigger if exists game_results_touch on public.game_results;
create trigger game_results_touch
  before update on public.game_results
  for each row execute function public.touch_updated_at();

alter table public.tournaments enable row level security;
alter table public.game_results enable row level security;

-- Supabase grants everything to anon by default. Narrow it down.
revoke all on public.tournaments from anon, authenticated;
revoke all on public.game_results from anon, authenticated;

grant select on public.tournaments to anon, authenticated;
grant insert (id, name, target_score, games_per_player, players, rounds)
  on public.tournaments to anon, authenticated;
-- Only the draw can change after creation (Regenerate draw).
grant update (rounds, draw_version) on public.tournaments to anon, authenticated;

grant select, insert on public.game_results to anon, authenticated;
-- Upserts rewrite the key columns with the same values, so they need update too.
grant update (tournament_id, draw_version, game_id, score_a, score_b)
  on public.game_results to anon, authenticated;

drop policy if exists "tournaments readable" on public.tournaments;
create policy "tournaments readable" on public.tournaments
  for select to anon, authenticated using (true);

drop policy if exists "tournaments creatable" on public.tournaments;
create policy "tournaments creatable" on public.tournaments
  for insert to anon, authenticated with check (true);

drop policy if exists "tournaments redrawable" on public.tournaments;
create policy "tournaments redrawable" on public.tournaments
  for update to anon, authenticated using (true) with check (true);

drop policy if exists "results readable" on public.game_results;
create policy "results readable" on public.game_results
  for select to anon, authenticated using (true);

drop policy if exists "results writable" on public.game_results;
create policy "results writable" on public.game_results
  for insert to anon, authenticated with check (true);

drop policy if exists "results editable" on public.game_results;
create policy "results editable" on public.game_results
  for update to anon, authenticated using (true) with check (true);
