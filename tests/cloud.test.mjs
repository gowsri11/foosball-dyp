import test from "node:test";
import assert from "node:assert/strict";
import {
  createCloudClient,
  createShareId,
  fromTournamentRow,
  stripScores,
  toTournamentRow,
  tournamentSignature
} from "../js/cloud.js";

const sampleTournament = {
  version: 1,
  id: "AbCdEf1234",
  cloud: true,
  drawVersion: 2,
  name: "Friday",
  targetScore: 7,
  gamesPerPlayer: 4,
  players: [{ id: "p1", name: "A" }],
  rounds: [
    {
      number: 1,
      byes: ["p5"],
      games: [
        { id: "r1g1", teamA: ["p1", "p2"], teamB: ["p3", "p4"], scoreA: 7, scoreB: 3 }
      ]
    }
  ]
};

test("share ids match the database id rule", () => {
  for (let index = 0; index < 50; index += 1) {
    assert.match(createShareId(), /^[A-Za-z0-9]{10}$/);
  }
});

test("rows store the draw without scores", () => {
  const row = toTournamentRow(sampleTournament);
  assert.equal(row.target_score, 7);
  assert.equal(row.games_per_player, 4);
  assert.deepEqual(row.rounds[0].games[0], {
    id: "r1g1",
    teamA: ["p1", "p2"],
    teamB: ["p3", "p4"]
  });
  assert.equal("draw_version" in row, false);
});

test("only results for the current draw are merged back in", () => {
  const tournament = fromTournamentRow({
    id: "AbCdEf1234",
    name: "Friday",
    target_score: 7,
    games_per_player: 4,
    players: ["A", "B", "C", "D", "E"].map((name, index) => ({ id: `p${index + 1}`, name })),
    rounds: stripScores(sampleTournament.rounds),
    draw_version: 2,
    created_at: "2026-11-11T10:00:00Z",
    updated_at: "2026-11-11T10:00:00Z",
    game_results: [
      { draw_version: 1, game_id: "r1g1", score_a: 1, score_b: 7 },
      { draw_version: 2, game_id: "r1g1", score_a: 7, score_b: 5 }
    ]
  });
  assert.equal(tournament.cloud, true);
  assert.equal(tournament.drawVersion, 2);
  assert.equal(tournament.rounds[0].games[0].scoreA, 7);
  assert.equal(tournament.rounds[0].games[0].scoreB, 5);
});

test("signature changes when a score changes", () => {
  const copy = structuredClone(sampleTournament);
  const before = tournamentSignature(copy);
  copy.rounds[0].games[0].scoreB = 4;
  assert.notEqual(tournamentSignature(copy), before);
});

function mockFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift() || { status: 200, body: [] };
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status
    });
  };
  return { calls, fetchImpl };
}

test("publishable keys go only in the apikey header", async () => {
  const { calls, fetchImpl } = mockFetch([{ status: 200, body: [] }]);
  const client = createCloudClient(
    { url: "https://x.supabase.co", key: "sb_publishable_abc" },
    fetchImpl
  );
  await client.fetchTournament("AbCdEf1234");
  assert.equal(calls[0].init.headers.apikey, "sb_publishable_abc");
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.match(calls[0].url, /\/rest\/v1\/tournaments\?id=eq\.AbCdEf1234&select=\*,game_results/);
});

test("legacy anon JWT keys are also sent as a bearer token", async () => {
  const { calls, fetchImpl } = mockFetch([{ status: 200, body: [] }]);
  const client = createCloudClient({ url: "https://x.supabase.co", key: "eyJhbGciOi" }, fetchImpl);
  await client.listTournaments();
  assert.equal(calls[0].init.headers.Authorization, "Bearer eyJhbGciOi");
});

test("scores are upserted per game", async () => {
  const { calls, fetchImpl } = mockFetch([{ status: 201 }]);
  const client = createCloudClient({ url: "https://x.supabase.co", key: "k" }, fetchImpl);
  await client.saveResult("AbCdEf1234", 2, "r1g1", 7, 4);
  assert.equal(calls[0].init.method, "POST");
  assert.match(calls[0].init.headers.Prefer, /resolution=merge-duplicates/);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    tournament_id: "AbCdEf1234",
    draw_version: 2,
    game_id: "r1g1",
    score_a: 7,
    score_b: 4
  });
});

test("redraw only succeeds against the expected draw version", async () => {
  const { calls, fetchImpl } = mockFetch([
    { status: 200, body: [{ id: "AbCdEf1234" }] },
    { status: 200, body: [] }
  ]);
  const client = createCloudClient({ url: "https://x.supabase.co", key: "k" }, fetchImpl);
  assert.equal(await client.replaceDraw("AbCdEf1234", 2, sampleTournament.rounds), true);
  assert.match(calls[0].url, /draw_version=eq\.2/);
  assert.equal(JSON.parse(calls[0].init.body).draw_version, 3);
  assert.equal(await client.replaceDraw("AbCdEf1234", 2, sampleTournament.rounds), false);
});

test("server errors surface status and message", async () => {
  const { fetchImpl } = mockFetch([{ status: 401, body: { message: "Invalid API key" } }]);
  const client = createCloudClient({ url: "https://x.supabase.co", key: "k" }, fetchImpl);
  await assert.rejects(client.listTournaments(), (error) => {
    assert.equal(error.status, 401);
    assert.equal(error.message, "Invalid API key");
    return true;
  });
});

function validRow() {
  return {
    id: "AbCdEf1234",
    name: "Friday",
    target_score: 7,
    games_per_player: 1,
    draw_version: 1,
    created_at: "2026-11-11T10:00:00Z",
    updated_at: "2026-11-11T10:00:00Z",
    players: ["A", "B", "C", "D"].map((name, index) => ({ id: `p${index + 1}`, name })),
    rounds: [
      { number: 1, byes: [], games: [{ id: "r1g1", teamA: ["p1", "p2"], teamB: ["p3", "p4"] }] }
    ],
    game_results: []
  };
}

test("a well-formed row passes validation", () => {
  assert.equal(fromTournamentRow(validRow()).rounds[0].games[0].id, "r1g1");
});

for (const [label, mutate] of [
  ["HTML in a game id", (row) => { row.rounds[0].games[0].id = '"><img src=x onerror=alert(1)>'; }],
  ["a non-numeric round number", (row) => { row.rounds[0].number = "<b>1</b>"; }],
  ["an unknown player in a team", (row) => { row.rounds[0].games[0].teamA = ["p1", "<script>"]; }],
  ["a bad player id", (row) => { row.players[0].id = 'p1" onclick="x'; }],
  ["a non-string player name", (row) => { row.players[0].name = { toString: () => "<x>" }; }],
  ["a target score outside 7 or 10", (row) => { row.target_score = "7<script>"; }],
  ["a duplicate player in one game", (row) => { row.rounds[0].games[0].teamB = ["p1", "p4"]; }]
]) {
  test(`rejects ${label}`, () => {
    const row = validRow();
    mutate(row);
    assert.throws(() => fromTournamentRow(row), /invalid/);
  });
}

test("drops results with out-of-range or non-numeric scores", () => {
  const row = validRow();
  row.game_results = [{ draw_version: 1, game_id: "r1g1", score_a: "<x>", score_b: 7 }];
  assert.equal(fromTournamentRow(row).rounds[0].games[0].scoreA, null);
});

test("recent list keeps only safe fields", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify([
        { id: "bad id<>", name: "x", games_per_player: 4, created_at: "2026-11-11T10:00:00Z", players: [] },
        { id: "AbCdEf1234", name: "Ok", games_per_player: 4, created_at: "2026-11-11T10:00:00Z", players: [1, 2, 3, 4], extra: "<x>" }
      ]),
      { status: 200 }
    );
  const client = createCloudClient({ url: "https://x.supabase.co", key: "k" }, fetchImpl);
  const rows = await client.listTournaments();
  assert.deepEqual(rows, [
    { id: "AbCdEf1234", name: "Ok", created_at: "2026-11-11T10:00:00Z", games_per_player: 4, playerCount: 4 }
  ]);
});
