const MIN_PLAYERS = 4;

export function getSchedulePlan(playerCount, gamesPerPlayer) {
  const n = Number(playerCount);
  const games = Math.max(1, Math.floor(Number(gamesPerPlayer) || 1));

  if (!Number.isInteger(n) || n < MIN_PLAYERS) {
    return {
      valid: false,
      playerCount: n || 0,
      gamesPerPlayer: games,
      reason: "At least four players are needed to make a 2v2 match."
    };
  }

  const totalAppearances = n * games;
  const totalGames = Math.ceil(totalAppearances / 4);
  const maxGamesPerRound = Math.floor(n / 4);
  const rounds = Math.ceil(totalGames / maxGamesPerRound);
  const baseGames = Math.floor(totalGames / rounds);
  const extraRounds = totalGames % rounds;
  const gamesPerRound = Array.from(
    { length: rounds },
    (_, index) => baseGames + (index < extraRounds ? 1 : 0)
  );
  const extraAppearances = totalGames * 4 - totalAppearances;
  const byesPerRound = gamesPerRound.map((count) => n - count * 4);

  return {
    valid: true,
    playerCount: n,
    gamesPerPlayer: games,
    totalGames,
    totalAppearances: totalGames * 4,
    rounds,
    maxGamesPerRound,
    gamesPerRound,
    byesPerRound,
    byesTotal: rounds * n - totalGames * 4,
    extraAppearances,
    exact: extraAppearances === 0
  };
}

export function generateSchedule(players, gamesPerPlayer, options = {}) {
  if (!Array.isArray(players) || players.length < MIN_PLAYERS) {
    throw new Error("A tournament needs at least four players.");
  }

  const plan = getSchedulePlan(players.length, gamesPerPlayer);
  const rng = options.rng || Math.random;
  const attempts = Math.max(1, options.attempts || 14);
  let best = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const targets = buildAppearanceTargets(plan, rng);
    const activeRounds = assignActivePlayers(plan, targets, rng);

    if (!activeRounds) {
      continue;
    }

    const rounds = buildRounds(plan, activeRounds, players, rng);
    const quality = evaluateSchedule(rounds);

    if (!best || quality.score < best.quality.score) {
      best = { plan, rounds, quality };
    }
  }

  if (!best) {
    throw new Error("Could not build a valid schedule. Please try again.");
  }

  return best;
}

export function computeStandings(players, rounds) {
  const stats = new Map(
    players.map((player) => [
      player.id,
      {
        id: player.id,
        name: player.name,
        played: 0,
        wins: 0,
        losses: 0,
        goalsFor: 0,
        goalsAgainst: 0,
        goalDifference: 0,
        points: 0
      }
    ])
  );

  for (const round of rounds) {
    for (const game of round.games) {
      if (!isRecordedScore(game)) {
        continue;
      }

      const scoreA = Number(game.scoreA);
      const scoreB = Number(game.scoreB);

      for (const playerId of game.teamA) {
        applyResult(stats.get(playerId), scoreA, scoreB);
      }

      for (const playerId of game.teamB) {
        applyResult(stats.get(playerId), scoreB, scoreA);
      }
    }
  }

  const collator = new Intl.Collator(undefined, { sensitivity: "base" });
  const table = [...stats.values()]
    .map((row) => ({
      ...row,
      goalDifference: row.goalsFor - row.goalsAgainst
    }))
    .sort(
      (a, b) =>
        b.points - a.points ||
        b.goalDifference - a.goalDifference ||
        b.goalsFor - a.goalsFor ||
        collator.compare(a.name, b.name)
    )
    .map((row, index) => ({ ...row, rank: index + 1 }));

  return table;
}

export function getProgress(rounds) {
  let total = 0;
  let completed = 0;

  for (const round of rounds) {
    for (const game of round.games) {
      total += 1;
      if (isRecordedScore(game)) {
        completed += 1;
      }
    }
  }

  return {
    total,
    completed,
    remaining: total - completed,
    percent: total === 0 ? 0 : Math.round((completed / total) * 100),
    complete: total > 0 && completed === total
  };
}

export function isRoundComplete(round) {
  return round.games.every((game) => isRecordedScore(game));
}

export function isRecordedScore(game) {
  return (
    Number.isInteger(game.scoreA) &&
    Number.isInteger(game.scoreB) &&
    game.scoreA >= 0 &&
    game.scoreB >= 0
  );
}

export function validateScore(scoreA, scoreB, targetScore) {
  const a = Number(scoreA);
  const b = Number(scoreB);

  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) {
    return { valid: false, message: "Enter a whole-number score for both teams." };
  }

  if (a > targetScore || b > targetScore) {
    return { valid: false, message: `A team cannot score more than ${targetScore}.` };
  }

  if (a === targetScore && b < targetScore) {
    return { valid: true, winner: "A" };
  }

  if (b === targetScore && a < targetScore) {
    return { valid: true, winner: "B" };
  }

  return {
    valid: false,
    message: `One team must reach exactly ${targetScore} points to win.`
  };
}

function buildAppearanceTargets(plan, rng) {
  const targets = Array(plan.playerCount).fill(plan.gamesPerPlayer);
  const order = shuffleIndices(plan.playerCount, rng);

  for (let index = 0; index < plan.extraAppearances; index += 1) {
    targets[order[index]] += 1;
  }

  return targets;
}

function assignActivePlayers(plan, targets, rng) {
  const roundCount = plan.rounds;
  const playerCount = plan.playerCount;
  const source = 0;
  const roundOffset = 1;
  const playerOffset = roundOffset + roundCount;
  const sink = playerOffset + playerCount;
  const graph = Array.from({ length: sink + 1 }, () => []);
  const roundPlayerEdges = Array.from({ length: roundCount }, () =>
    Array(playerCount).fill(null)
  );
  let requiredFlow = 0;

  for (let round = 0; round < roundCount; round += 1) {
    const slots = plan.gamesPerRound[round] * 4;
    requiredFlow += slots;
    addEdge(graph, source, roundOffset + round, slots);

    const order = shuffleIndices(playerCount, rng);
    for (const player of order) {
      roundPlayerEdges[round][player] = addEdge(
        graph,
        roundOffset + round,
        playerOffset + player,
        1
      );
    }
  }

  for (let player = 0; player < playerCount; player += 1) {
    addEdge(graph, playerOffset + player, sink, targets[player]);
  }

  const flow = maxFlow(graph, source, sink);

  if (flow !== requiredFlow) {
    return null;
  }

  const activeRounds = [];

  for (let round = 0; round < roundCount; round += 1) {
    const active = [];
    for (let player = 0; player < playerCount; player += 1) {
      if (roundPlayerEdges[round][player].cap === 0) {
        active.push(player);
      }
    }

    if (active.length !== plan.gamesPerRound[round] * 4) {
      return null;
    }

    activeRounds.push(shuffle(active, rng));
  }

  return activeRounds;
}

function buildRounds(plan, activeRounds, players, rng) {
  const partnerCounts = new Map();
  const opponentCounts = new Map();
  const rounds = [];
  const playerIds = players.map((player) => player.id);

  for (let roundIndex = 0; roundIndex < activeRounds.length; roundIndex += 1) {
    const active = activeRounds[roundIndex].map((index) => playerIds[index]);
    const arranged = chooseRoundArrangement(
      active,
      partnerCounts,
      opponentCounts,
      rng
    );

    for (const game of arranged) {
      recordGamePairs(game, partnerCounts, opponentCounts);
    }

    const activeSet = new Set(active);
    const byes = playerIds.filter((id) => !activeSet.has(id));
    const games = arranged.map((game, gameIndex) => ({
      id: `r${roundIndex + 1}g${gameIndex + 1}`,
      teamA: game.teamA,
      teamB: game.teamB,
      scoreA: null,
      scoreB: null
    }));

    rounds.push({
      number: roundIndex + 1,
      games,
      byes
    });
  }

  return rounds;
}

function chooseRoundArrangement(active, partnerCounts, opponentCounts, rng) {
  const gameCount = active.length / 4;
  const attempts = Math.min(1400, Math.max(360, gameCount * 220));
  let best = null;
  let bestScore = Infinity;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const order = shuffle([...active], rng);
    const games = [];

    for (let index = 0; index < order.length; index += 4) {
      const group = order.slice(index, index + 4);
      const split = Math.floor(rng() * 3);
      const teamA = [group[0], group[split === 0 ? 1 : split === 1 ? 2 : 3]];
      const teamB = group.filter((id) => !teamA.includes(id));
      games.push({ teamA, teamB });
    }

    const score =
      arrangementPenalty(games, partnerCounts, opponentCounts) + rng() * 0.001;

    if (score < bestScore) {
      bestScore = score;
      best = games;
    }
  }

  return best;
}

function arrangementPenalty(games, partnerCounts, opponentCounts) {
  let penalty = 0;

  for (const game of games) {
    penalty += pairPenalty(game.teamA, partnerCounts, 140);
    penalty += pairPenalty(game.teamB, partnerCounts, 140);

    for (const playerA of game.teamA) {
      for (const playerB of game.teamB) {
        penalty += pairPenaltyFor(
          playerA,
          playerB,
          opponentCounts,
          8
        );
      }
    }
  }

  return penalty;
}

function pairPenalty(team, counts, weight) {
  return pairPenaltyFor(team[0], team[1], counts, weight);
}

function pairPenaltyFor(playerA, playerB, counts, weight) {
  const count = counts.get(pairKey(playerA, playerB)) || 0;
  return (count * 2 + 1) * weight;
}

function recordGamePairs(game, partnerCounts, opponentCounts) {
  incrementPair(game.teamA[0], game.teamA[1], partnerCounts);
  incrementPair(game.teamB[0], game.teamB[1], partnerCounts);

  for (const playerA of game.teamA) {
    for (const playerB of game.teamB) {
      incrementPair(playerA, playerB, opponentCounts);
    }
  }
}

function evaluateSchedule(rounds) {
  const partnerCounts = new Map();
  const opponentCounts = new Map();

  for (const round of rounds) {
    for (const game of round.games) {
      recordGamePairs(game, partnerCounts, opponentCounts);
    }
  }

  const partner = pairSummary(partnerCounts);
  const opponent = pairSummary(opponentCounts);
  const score =
    partner.extra * 1000 +
    partner.repeatedPairs * 200 +
    partner.maximum * 50 +
    opponent.extra * 4 +
    opponent.repeatedPairs * 2 +
    opponent.maximum;

  return { score, partner, opponent };
}

function pairSummary(counts) {
  let extra = 0;
  let repeatedPairs = 0;
  let maximum = 0;

  for (const count of counts.values()) {
    extra += Math.max(0, count - 1);
    repeatedPairs += count > 1 ? 1 : 0;
    maximum = Math.max(maximum, count);
  }

  return { extra, repeatedPairs, maximum };
}

function incrementPair(playerA, playerB, counts) {
  const key = pairKey(playerA, playerB);
  counts.set(key, (counts.get(key) || 0) + 1);
}

function pairKey(playerA, playerB) {
  return playerA < playerB
    ? `${playerA}|${playerB}`
    : `${playerB}|${playerA}`;
}

function applyResult(stat, goalsFor, goalsAgainst) {
  if (!stat) {
    return;
  }

  stat.played += 1;
  stat.goalsFor += goalsFor;
  stat.goalsAgainst += goalsAgainst;

  if (goalsFor > goalsAgainst) {
    stat.wins += 1;
    stat.points += 1;
  } else {
    stat.losses += 1;
  }
}

function shuffle(values, rng) {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const target = Math.floor(rng() * (index + 1));
    [values[index], values[target]] = [values[target], values[index]];
  }

  return values;
}

function shuffleIndices(length, rng) {
  return shuffle(
    Array.from({ length }, (_, index) => index),
    rng
  );
}

function addEdge(graph, from, to, capacity) {
  const forward = { to, rev: graph[to].length, cap: capacity };
  const reverse = { to: from, rev: graph[from].length, cap: 0 };
  graph[from].push(forward);
  graph[to].push(reverse);
  return forward;
}

function maxFlow(graph, source, sink) {
  let flow = 0;

  while (true) {
    const level = Array(graph.length).fill(-1);
    const queue = [source];
    level[source] = 0;

    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const node = queue[cursor];

      for (const edge of graph[node]) {
        if (edge.cap > 0 && level[edge.to] === -1) {
          level[edge.to] = level[node] + 1;
          queue.push(edge.to);
        }
      }
    }

    if (level[sink] === -1) {
      break;
    }

    const nextEdge = Array(graph.length).fill(0);

    while (true) {
      const pushed = sendFlow(graph, source, sink, Infinity, level, nextEdge);
      if (pushed === 0) {
        break;
      }
      flow += pushed;
    }
  }

  return flow;
}

function sendFlow(graph, node, sink, available, level, nextEdge) {
  if (node === sink) {
    return available;
  }

  while (nextEdge[node] < graph[node].length) {
    const edge = graph[node][nextEdge[node]];

    if (edge.cap > 0 && level[edge.to] === level[node] + 1) {
      const pushed = sendFlow(
        graph,
        edge.to,
        sink,
        Math.min(available, edge.cap),
        level,
        nextEdge
      );

      if (pushed > 0) {
        edge.cap -= pushed;
        graph[edge.to][edge.rev].cap += pushed;
        return pushed;
      }
    }

    nextEdge[node] += 1;
  }

  return 0;
}
