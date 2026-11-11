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

  const playerIds = players.map((player) => player.id);
  const balanced = balanceRounds(best.rounds, playerIds, rng, {
    iterations: options.balanceIterations
  });

  return {
    plan,
    rounds: balanced,
    quality: evaluateSchedule(balanced)
  };
}

/**
 * Games-per-player values that let every player play exactly the same number
 * of games (players x games must fill whole four-player matches).
 */
export function exactGameCounts(playerCount, maxGames) {
  const n = Number(playerCount);
  if (!Number.isInteger(n) || n < MIN_PLAYERS) {
    return [];
  }

  const values = [];
  for (let games = 1; games <= maxGames; games += 1) {
    if ((n * games) % 4 === 0) {
      values.push(games);
    }
  }
  return values;
}

/**
 * "points" when every player is scheduled for the same number of games,
 * otherwise "winRate" so players with an extra match gain no edge.
 */
export function standingsMode(rounds) {
  const scheduled = new Map();

  for (const round of rounds) {
    for (const game of round.games) {
      for (const id of [...game.teamA, ...game.teamB]) {
        scheduled.set(id, (scheduled.get(id) || 0) + 1);
      }
    }
  }

  return new Set(scheduled.values()).size > 1 ? "winRate" : "points";
}

export function computeStandings(players, rounds) {
  const mode = standingsMode(rounds);
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
  const perGame = (value, played) => (played ? value / played : 0);
  const byPoints = (a, b) =>
    b.points - a.points ||
    b.goalDifference - a.goalDifference ||
    b.goalsFor - a.goalsFor ||
    collator.compare(a.name, b.name);
  // Unequal schedules: compare rates, not totals, so an extra match is not
  // an advantage. Goal difference and goals scored are compared per game.
  const byWinRate = (a, b) =>
    b.winRate - a.winRate ||
    perGame(b.goalDifference, b.played) - perGame(a.goalDifference, a.played) ||
    perGame(b.goalsFor, b.played) - perGame(a.goalsFor, a.played) ||
    collator.compare(a.name, b.name);

  return [...stats.values()]
    .map((row) => ({
      ...row,
      goalDifference: row.goalsFor - row.goalsAgainst,
      winRate: perGame(row.wins, row.played),
      mode
    }))
    .sort(mode === "winRate" ? byWinRate : byPoints)
    .map((row, index) => ({ ...row, rank: index + 1 }));
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

/**
 * Simulated annealing pass that rearranges an already valid schedule so that
 * every pair of players is teamed up and matched against each other as evenly
 * as the field allows. It never changes how many games a player gets or how
 * many games are in each round, so the plan stays valid.
 *
 * Moves:
 *  - swap two players inside a round (changes partners and opponents)
 *  - swap two whole teams between games in a round (changes opponents only)
 *  - swap a playing and a resting player across two rounds (changes byes)
 */
function balanceRounds(rounds, playerIds, rng, options = {}) {
  const n = playerIds.length;
  const indexOf = new Map(playerIds.map((id, index) => [id, index]));
  const state = rounds.map((round) => ({
    slots: round.games.flatMap((game) =>
      [...game.teamA, ...game.teamB].map((id) => indexOf.get(id))
    ),
    byes: round.byes.map((id) => indexOf.get(id))
  }));

  const totalGames = state.reduce((sum, round) => sum + round.slots.length / 4, 0);
  if (n < 5 || totalGames < 2) {
    return rounds;
  }

  // Weights used to pick the final answer: partners first, then opponents,
  // then avoiding back-to-back byes for the same player.
  const FINAL_PARTNER = 1000;
  const FINAL_OPPONENT = 10;
  const FINAL_BYE = 1;
  // Softer weights while searching so the walk can pass through slightly
  // worse partner arrangements to reach better opponent arrangements.
  const SEARCH_PARTNER = 30;
  const SEARCH_OPPONENT = 10;
  const SEARCH_BYE = 1;

  const partner = new Int32Array(n * n);
  const opponent = new Int32Array(n * n);
  const pairIndex = (a, b) => (a < b ? a * n + b : b * n + a);
  const byeRounds = Array.from({ length: n }, () => new Set());
  let partnerSq = 0;
  let opponentSq = 0;
  let byeAdjacent = 0;

  function addGame(slots, game, sign) {
    const base = game * 4;
    const a = slots[base];
    const b = slots[base + 1];
    const c = slots[base + 2];
    const d = slots[base + 3];
    partnerSq += bump(partner, pairIndex(a, b), sign);
    partnerSq += bump(partner, pairIndex(c, d), sign);
    opponentSq += bump(opponent, pairIndex(a, c), sign);
    opponentSq += bump(opponent, pairIndex(a, d), sign);
    opponentSq += bump(opponent, pairIndex(b, c), sign);
    opponentSq += bump(opponent, pairIndex(b, d), sign);
  }

  function bump(counts, key, sign) {
    const before = counts[key];
    counts[key] += sign;
    return counts[key] * counts[key] - before * before;
  }

  function adjacentByes(player) {
    let total = 0;
    for (const round of byeRounds[player]) {
      if (byeRounds[player].has(round + 1)) {
        total += 1;
      }
    }
    return total;
  }

  state.forEach((round, roundIndex) => {
    for (let game = 0; game < round.slots.length / 4; game += 1) {
      addGame(round.slots, game, 1);
    }
    for (const player of round.byes) {
      byeRounds[player].add(roundIndex);
    }
  });
  for (let player = 0; player < n; player += 1) {
    byeAdjacent += adjacentByes(player);
  }

  const pairs = (n * (n - 1)) / 2;
  const flattest = (total) => {
    const base = Math.floor(total / pairs);
    const rest = total % pairs;
    return (pairs - rest) * base * base + rest * (base + 1) * (base + 1);
  };
  const partnerBound = flattest(totalGames * 2);
  const opponentBound = flattest(totalGames * 4);
  const roundsWithByes = state
    .map((round, index) => (round.byes.length > 0 ? index : -1))
    .filter((index) => index >= 0);

  const finalScore = () =>
    partnerSq * FINAL_PARTNER + opponentSq * FINAL_OPPONENT + byeAdjacent * FINAL_BYE;
  const snapshot = () =>
    state.map((round) => ({ slots: [...round.slots], byes: [...round.byes] }));

  let bestScore = finalScore();
  let bestState = snapshot();
  const iterations = Math.max(1, options.iterations || 300000);
  const startTemperature = SEARCH_PARTNER * 3;
  const endTemperature = SEARCH_OPPONENT * 0.2;
  const coolingFactor = Math.log(endTemperature / startTemperature);
  const accept = (delta, temperature) =>
    delta <= 0 || rng() < Math.exp(-delta / temperature);

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const atBound =
      partnerSq === partnerBound &&
      opponentSq === opponentBound &&
      (byeAdjacent === 0 || roundsWithByes.length === 0);
    if (atBound) {
      break;
    }

    const temperature =
      startTemperature * Math.exp((coolingFactor * iteration) / iterations);
    const roll = rng();

    if (roundsWithByes.length > 0 && roll < 0.35) {
      // Swap a playing player with a resting player across two rounds.
      const roundA = roundsWithByes[Math.floor(rng() * roundsWithByes.length)];
      const stateA = state[roundA];
      const byeSlot = Math.floor(rng() * stateA.byes.length);
      const resting = stateA.byes[byeSlot];
      const slotA = Math.floor(rng() * stateA.slots.length);
      const playing = stateA.slots[slotA];
      const candidates = [];
      for (const round of byeRounds[playing]) {
        if (round !== roundA && !byeRounds[resting].has(round)) {
          candidates.push(round);
        }
      }
      if (candidates.length === 0) {
        continue;
      }
      const roundB = candidates[Math.floor(rng() * candidates.length)];
      const stateB = state[roundB];
      const slotB = stateB.slots.indexOf(resting);
      const byeSlotB = stateB.byes.indexOf(playing);
      const gameA = Math.floor(slotA / 4);
      const gameB = Math.floor(slotB / 4);
      const beforePartner = partnerSq;
      const beforeOpponent = opponentSq;
      const beforeByes = byeAdjacent;
      const beforeAdjacent = adjacentByes(playing) + adjacentByes(resting);

      const apply = (forward) => {
        addGame(stateA.slots, gameA, -1);
        addGame(stateB.slots, gameB, -1);
        stateA.slots[slotA] = forward ? resting : playing;
        stateA.byes[byeSlot] = forward ? playing : resting;
        stateB.slots[slotB] = forward ? playing : resting;
        stateB.byes[byeSlotB] = forward ? resting : playing;
        byeRounds[playing].delete(forward ? roundB : roundA);
        byeRounds[playing].add(forward ? roundA : roundB);
        byeRounds[resting].delete(forward ? roundA : roundB);
        byeRounds[resting].add(forward ? roundB : roundA);
        addGame(stateA.slots, gameA, 1);
        addGame(stateB.slots, gameB, 1);
      };

      apply(true);
      byeAdjacent += adjacentByes(playing) + adjacentByes(resting) - beforeAdjacent;
      const delta =
        (partnerSq - beforePartner) * SEARCH_PARTNER +
        (opponentSq - beforeOpponent) * SEARCH_OPPONENT +
        (byeAdjacent - beforeByes) * SEARCH_BYE;
      if (!accept(delta, temperature)) {
        apply(false);
        byeAdjacent = beforeByes;
      }
    } else if (roll < 0.6) {
      // Swap two whole teams between games in the same round.
      const roundIndex = Math.floor(rng() * state.length);
      const round = state[roundIndex];
      const gameCount = round.slots.length / 4;
      if (gameCount < 2) {
        continue;
      }
      const gameA = Math.floor(rng() * gameCount);
      let gameB = Math.floor(rng() * (gameCount - 1));
      if (gameB >= gameA) {
        gameB += 1;
      }
      const teamA = gameA * 4 + (rng() < 0.5 ? 0 : 2);
      const teamB = gameB * 4 + (rng() < 0.5 ? 0 : 2);
      const beforeOpponent = opponentSq;
      const swapTeams = () => {
        addGame(round.slots, gameA, -1);
        addGame(round.slots, gameB, -1);
        swapSlots(round.slots, teamA, teamB);
        swapSlots(round.slots, teamA + 1, teamB + 1);
        addGame(round.slots, gameA, 1);
        addGame(round.slots, gameB, 1);
      };
      swapTeams();
      if (!accept((opponentSq - beforeOpponent) * SEARCH_OPPONENT, temperature)) {
        swapTeams();
      }
    } else {
      // Swap two players inside a round.
      const roundIndex = Math.floor(rng() * state.length);
      const round = state[roundIndex];
      const slotA = Math.floor(rng() * round.slots.length);
      let slotB = Math.floor(rng() * (round.slots.length - 1));
      if (slotB >= slotA) {
        slotB += 1;
      }
      if (slotA >> 1 === slotB >> 1) {
        continue; // same team, nothing changes
      }
      const gameA = Math.floor(slotA / 4);
      const gameB = Math.floor(slotB / 4);
      const beforePartner = partnerSq;
      const beforeOpponent = opponentSq;
      const swapPlayers = () => {
        addGame(round.slots, gameA, -1);
        if (gameB !== gameA) {
          addGame(round.slots, gameB, -1);
        }
        swapSlots(round.slots, slotA, slotB);
        addGame(round.slots, gameA, 1);
        if (gameB !== gameA) {
          addGame(round.slots, gameB, 1);
        }
      };
      swapPlayers();
      const delta =
        (partnerSq - beforePartner) * SEARCH_PARTNER +
        (opponentSq - beforeOpponent) * SEARCH_OPPONENT;
      if (!accept(delta, temperature)) {
        swapPlayers();
      }
    }

    const current = finalScore();
    if (current < bestScore) {
      bestScore = current;
      bestState = snapshot();
    }
  }

  return rounds.map((round, roundIndex) => ({
    ...round,
    games: round.games.map((game, gameIndex) => {
      const base = gameIndex * 4;
      const slots = bestState[roundIndex].slots;
      return {
        ...game,
        teamA: [playerIds[slots[base]], playerIds[slots[base + 1]]],
        teamB: [playerIds[slots[base + 2]], playerIds[slots[base + 3]]]
      };
    }),
    byes: bestState[roundIndex].byes.map((player) => playerIds[player])
  }));
}

function swapSlots(slots, a, b) {
  const held = slots[a];
  slots[a] = slots[b];
  slots[b] = held;
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
  const playerIds = new Set();

  for (const round of rounds) {
    for (const game of round.games) {
      recordGamePairs(game, partnerCounts, opponentCounts);
      for (const id of [...game.teamA, ...game.teamB]) {
        playerIds.add(id);
      }
    }
    for (const id of round.byes) {
      playerIds.add(id);
    }
  }

  const totalPairs = (playerIds.size * (playerIds.size - 1)) / 2;
  const partner = pairSummary(partnerCounts, totalPairs);
  const opponent = pairSummary(opponentCounts, totalPairs);
  // Lower sum of squares means the pairings are spread more evenly. Partner
  // balance dominates; opponent balance breaks ties.
  const score = partner.sumOfSquares * 1000 + opponent.sumOfSquares * 10;

  return {
    score,
    partner,
    opponent,
    balanced: partner.max - partner.min <= 1 && opponent.max - opponent.min <= 1
  };
}

function pairSummary(counts, totalPairs) {
  let extra = 0;
  let repeatedPairs = 0;
  let maximum = 0;
  let sumOfSquares = 0;

  for (const count of counts.values()) {
    extra += Math.max(0, count - 1);
    repeatedPairs += count > 1 ? 1 : 0;
    maximum = Math.max(maximum, count);
    sumOfSquares += count * count;
  }

  const distinct = counts.size;
  const minimum = distinct < totalPairs ? 0 : Math.min(...counts.values());

  return {
    extra,
    repeatedPairs,
    maximum,
    sumOfSquares,
    distinct,
    totalPairs,
    min: minimum,
    max: maximum
  };
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
