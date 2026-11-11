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

test("legacy anon JWT keys are also sent as a bearer token", async () => {
  const { calls, fetchImpl } = mockFetch([{ status: 200, body: [] }]);
  const client = createCloudClient({ url: "https://x.supabase.co", key: "eyJhbGciOi" }, fetchImpl);
  await client.listTournamentsById(["AbCdEf1234"]);
  assert.equal(calls[0].init.headers.Authorization, "Bearer eyJhbGciOi");
});

test("server errors surface status and message", async () => {
  const { fetchImpl } = mockFetch([{ status: 401, body: { message: "Invalid API key" } }]);
  const client = createCloudClient({ url: "https://x.supabase.co", key: "k" }, fetchImpl);
  await assert.rejects(client.listTournamentsById(["AbCdEf1234"]), (error) => {
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

test("signature changes when the edit mode changes", () => {
  const copy = structuredClone(sampleTournament);
  const before = tournamentSignature(copy);
  copy.editMode = "owner";
  assert.notEqual(tournamentSignature(copy), before);
});

const rpcClient = (responses, token = null) => {
  const mock = mockFetch(responses);
  const client = createCloudClient(
    { url: "https://x.supabase.co", key: "sb_publishable_abc" },
    mock.fetchImpl,
    async () => token
  );
  return { ...mock, client };
};

test("reads go through get_tournament with only the apikey for guests", async () => {
  const { calls, client } = rpcClient([{ status: 200, body: null }]);
  assert.equal(await client.fetchTournament("AbCdEf1234"), null);
  assert.equal(calls[0].url, "https://x.supabase.co/rest/v1/rpc/get_tournament");
  assert.deepEqual(JSON.parse(calls[0].init.body), { p_id: "AbCdEf1234" });
  assert.equal(calls[0].init.headers.apikey, "sb_publishable_abc");
  assert.equal(calls[0].init.headers.Authorization, undefined);
});

test("malformed ids are never sent", async () => {
  const { calls, client } = rpcClient([]);
  assert.equal(await client.fetchTournament("x)or(1"), null);
  assert.equal(calls.length, 0);
});

test("signed-in requests carry the user's token", async () => {
  const { calls, client } = rpcClient([{ status: 200, body: [] }], "user-jwt");
  await client.listOwnedTournaments(5);
  assert.equal(calls[0].url, "https://x.supabase.co/rest/v1/rpc/my_tournaments");
  assert.equal(calls[0].init.headers.Authorization, "Bearer user-jwt");
  assert.deepEqual(JSON.parse(calls[0].init.body), { p_limit: 5 });
});

test("scores are saved through save_result", async () => {
  const { calls, client } = rpcClient([{ status: 204 }]);
  await client.saveResult("AbCdEf1234", 2, "r1g1", 7, 4);
  assert.match(calls[0].url, /\/rpc\/save_result$/);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    p_tournament_id: "AbCdEf1234",
    p_draw_version: 2,
    p_game_id: "r1g1",
    p_score_a: 7,
    p_score_b: 4
  });
});

test("redraw and edit mode report the server's answer", async () => {
  const { calls, client } = rpcClient([
    { status: 200, body: true },
    { status: 200, body: false },
    { status: 200, body: true }
  ]);
  assert.equal(await client.replaceDraw("AbCdEf1234", 2, sampleTournament.rounds), true);
  assert.equal(JSON.parse(calls[0].init.body).p_expected_version, 2);
  assert.equal(JSON.parse(calls[0].init.body).p_rounds[0].games[0].scoreA, undefined);
  assert.equal(await client.replaceDraw("AbCdEf1234", 2, sampleTournament.rounds), false);
  assert.equal(await client.setEditMode("AbCdEf1234", "anyone"), true);
  assert.deepEqual(JSON.parse(calls[2].init.body), { p_id: "AbCdEf1234", p_mode: "anyone" });
});

test("create sends the requested mode and returns ownership from the server", async () => {
  const stored = { ...validRow(), owned: true, is_owner: true, owner_name: "Alice", edit_mode: "owner" };
  const { calls, client } = rpcClient([{ status: 200, body: stored }], "t");
  const created = await client.createTournament({ ...sampleTournament, rounds: stored.rounds, editMode: "owner" });
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.p_edit_mode, "owner");
  assert.equal(Object.keys(sent).some((key) => key.includes("owner_id")), false);
  assert.equal(created.isOwner, true);
  assert.equal(created.ownerName, "Alice");
});

test("guest tournaments always read as editable by anyone", () => {
  const tournament = fromTournamentRow({ ...validRow(), owned: false, is_owner: true, owner_name: "spoof", edit_mode: "owner" });
  assert.equal(tournament.owned, false);
  assert.equal(tournament.isOwner, false);
  assert.equal(tournament.ownerName, null);
  assert.equal(tournament.editMode, "anyone");
});

test("rejects malformed owner fields", () => {
  for (const patch of [{ owned: "yes" }, { is_owner: 1 }, { edit_mode: "everyone" }, { owned: true, owner_name: 5 }]) {
    assert.throws(() => fromTournamentRow({ ...validRow(), ...patch }), /invalid/);
  }
});

test("recently opened list keeps only safe fields", async () => {
  const { calls, client } = rpcClient([{ status: 200, body: [
    { id: "bad id<>", name: "x", games_per_player: 4, created_at: "2026-11-11T10:00:00Z", player_count: 4 },
    { id: "AbCdEf1234", name: "Ok", games_per_player: 4, created_at: "2026-11-11T10:00:00Z", player_count: 4, extra: "<x>" }
  ] }]);
  const rows = await client.listTournamentsById(["AbCdEf1234", "../evil"]);
  assert.deepEqual(JSON.parse(calls[0].init.body), { p_ids: ["AbCdEf1234"] });
  assert.deepEqual(rows, [
    { id: "AbCdEf1234", name: "Ok", created_at: "2026-11-11T10:00:00Z", games_per_player: 4, playerCount: 4 }
  ]);
});
