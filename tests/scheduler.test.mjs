import test from "node:test";
import assert from "node:assert/strict";
import {
  computeStandings,
  generateSchedule,
  getProgress,
  getSchedulePlan,
  validateScore
} from "../js/scheduler.js";

function seededRandom(seed) {
  let state = seed >>> 0;

  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function players(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `p${index + 1}`,
    name: `Player ${index + 1}`
  }));
}

test("plan uses the minimum number of rounds and accounts for byes", () => {
  const plan = getSchedulePlan(10, 4);

  assert.equal(plan.totalGames, 10);
  assert.equal(plan.rounds, 5);
  assert.equal(plan.exact, true);
  assert.deepEqual(plan.byesPerRound, [2, 2, 2, 2, 2]);
});

test("adds only the appearances needed when player slots are not divisible by four", () => {
  const plan = getSchedulePlan(10, 3);

  assert.equal(plan.totalGames, 8);
  assert.equal(plan.rounds, 4);
  assert.equal(plan.extraAppearances, 2);
  assert.equal(plan.exact, false);
});

for (const [count, games] of [
  [4, 1],
  [4, 6],
  [5, 3],
  [6, 4],
  [7, 3],
  [8, 3],
  [9, 4],
  [10, 4],
  [11, 5],
  [12, 4],
  [13, 3],
  [16, 6]
]) {
  test(`builds a valid ${count}-player, ${games}-game schedule`, () => {
    const roster = players(count);
    const result = generateSchedule(roster, games, {
      rng: seededRandom(count * 100 + games),
      attempts: 4
    });
    const { plan, rounds } = result;
    const appearances = new Map(roster.map((player) => [player.id, 0]));
    let gameCount = 0;

    assert.equal(rounds.length, plan.rounds);

    for (const round of rounds) {
      const roundPlayers = new Set();
      assert.equal(round.games.length, plan.gamesPerRound[round.number - 1]);
      assert.equal(
        round.byes.length,
        plan.byesPerRound[round.number - 1]
      );

      for (const game of round.games) {
        gameCount += 1;
        const all = [...game.teamA, ...game.teamB];
        assert.equal(all.length, 4);
        assert.equal(new Set(all).size, 4);

        for (const id of all) {
          assert.ok(!roundPlayers.has(id), "player appears twice in one round");
          roundPlayers.add(id);
          appearances.set(id, appearances.get(id) + 1);
        }
      }

      for (const bye of round.byes) {
        assert.ok(!roundPlayers.has(bye), "bye player is also playing");
      }
    }

    assert.equal(gameCount, plan.totalGames);

    const counts = [...appearances.values()].sort((a, b) => a - b);
    const extra = counts.filter((value) => value === games + 1).length;

    assert.equal(extra, plan.extraAppearances);
    assert.ok(counts.every((value) => value === games || value === games + 1));
  });
}

test("reduces repeated teammates where the field allows fresh pairings", () => {
  const result = generateSchedule(players(8), 3, {
    rng: seededRandom(42),
    attempts: 14
  });

  assert.equal(result.quality.partner.extra, 0);
});

test("validates race-to-target scores", () => {
  assert.equal(validateScore(7, 4, 7).valid, true);
  assert.equal(validateScore(4, 7, 7).valid, true);
  assert.equal(validateScore(7, 7, 7).valid, false);
  assert.equal(validateScore(6, 5, 7).valid, false);
  assert.equal(validateScore(8, 2, 7).valid, false);
  assert.equal(validateScore(-1, 7, 7).valid, false);
});

test("calculates standings with goal difference as the first tiebreaker", () => {
  const roster = players(4);
  const rounds = [
    {
      number: 1,
      byes: [],
      games: [
        {
          id: "g1",
          teamA: ["p1", "p2"],
          teamB: ["p3", "p4"],
          scoreA: 7,
          scoreB: 3
        }
      ]
    },
    {
      number: 2,
      byes: [],
      games: [
        {
          id: "g2",
          teamA: ["p1", "p3"],
          teamB: ["p2", "p4"],
          scoreA: 7,
          scoreB: 5
        }
      ]
    }
  ];

  const table = computeStandings(roster, rounds);

  assert.equal(table[0].id, "p1");
  assert.equal(table[0].points, 2);
  assert.equal(table[0].goalDifference, 6);
  assert.equal(table[1].points, 1);
  assert.equal(getProgress(rounds).completed, 2);
});
