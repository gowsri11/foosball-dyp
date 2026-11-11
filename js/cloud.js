// Thin Supabase REST (PostgREST) client for shared tournaments.
// The schedule lives in `tournaments`; each saved score is its own row in
// `game_results`, so two people scoring different games never overwrite
// each other.

const ID_ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

let configPromise = null;

export function loadCloudConfig(fetchImpl = globalThis.fetch) {
  if (!configPromise) {
    configPromise = fetchImpl("/api/config", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((config) =>
        config && config.supabaseUrl && config.supabaseKey
          ? {
              url: config.supabaseUrl.replace(/\/+$/, ""),
              key: config.supabaseKey
            }
          : null
      )
      .catch(() => null);
  }
  return configPromise;
}

export function createShareId(length = 10) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("");
}

export function toTournamentRow(tournament) {
  return {
    id: tournament.id,
    name: tournament.name,
    target_score: tournament.targetScore,
    games_per_player: tournament.gamesPerPlayer,
    players: tournament.players,
    rounds: stripScores(tournament.rounds)
  };
}

export function stripScores(rounds) {
  return rounds.map((round) => ({
    number: round.number,
    byes: round.byes,
    games: round.games.map((game) => ({
      id: game.id,
      teamA: game.teamA,
      teamB: game.teamB
    }))
  }));
}

const PLAYER_ID = /^p\d{1,3}$/;
const GAME_ID = /^[A-Za-z0-9]{1,16}$/;
const TOURNAMENT_ID = /^[A-Za-z0-9]{8,24}$/;

function invalid(reason) {
  throw new Error(`This tournament's saved data is invalid (${reason}).`);
}

function checkScore(value) {
  return value === null || (Number.isInteger(value) && value >= 0 && value <= 10);
}

/**
 * Anyone with the publishable key can write rows, so treat them as untrusted:
 * rebuild every object from checked primitives and reject anything unexpected.
 */
export function validateTournamentRow(row) {
  if (!row || typeof row !== "object") invalid("empty row");
  if (typeof row.id !== "string" || !TOURNAMENT_ID.test(row.id)) invalid("id");
  if (typeof row.name !== "string" || !row.name.trim() || row.name.length > 48) invalid("name");
  if (row.target_score !== 7 && row.target_score !== 10) invalid("target score");
  if (!Number.isInteger(row.games_per_player) || row.games_per_player < 1 || row.games_per_player > 20) {
    invalid("games per player");
  }
  const drawVersion = row.draw_version ?? 1;
  if (!Number.isInteger(drawVersion) || drawVersion < 1) invalid("draw version");

  if (!Array.isArray(row.players) || row.players.length < 4 || row.players.length > 40) {
    invalid("players");
  }
  const playerIds = new Set();
  const players = row.players.map((player) => {
    if (
      !player ||
      typeof player.id !== "string" ||
      !PLAYER_ID.test(player.id) ||
      playerIds.has(player.id) ||
      typeof player.name !== "string" ||
      !player.name.trim() ||
      player.name.length > 40
    ) {
      invalid("player");
    }
    playerIds.add(player.id);
    return { id: player.id, name: player.name };
  });

  const knownPlayer = (id) => typeof id === "string" && playerIds.has(id);
  if (!Array.isArray(row.rounds) || row.rounds.length < 1 || row.rounds.length > 400) {
    invalid("rounds");
  }
  const gameIds = new Set();
  const rounds = row.rounds.map((round, index) => {
    if (!round || round.number !== index + 1) invalid("round number");
    if (!Array.isArray(round.byes) || !round.byes.every(knownPlayer)) invalid("byes");
    if (!Array.isArray(round.games)) invalid("games");
    return {
      number: round.number,
      byes: [...round.byes],
      games: round.games.map((game) => {
        if (!game || typeof game.id !== "string" || !GAME_ID.test(game.id) || gameIds.has(game.id)) {
          invalid("game id");
        }
        gameIds.add(game.id);
        const teams = [game.teamA, game.teamB];
        if (!teams.every((team) => Array.isArray(team) && team.length === 2 && team.every(knownPlayer))) {
          invalid("teams");
        }
        if (new Set([...game.teamA, ...game.teamB]).size !== 4) invalid("teams");
        return { id: game.id, teamA: [...game.teamA], teamB: [...game.teamB] };
      })
    };
  });

  const results = (Array.isArray(row.game_results) ? row.game_results : []).filter(
    (result) =>
      result &&
      result.draw_version === drawVersion &&
      typeof result.game_id === "string" &&
      gameIds.has(result.game_id) &&
      checkScore(result.score_a) &&
      checkScore(result.score_b)
  );

  return {
    id: row.id,
    name: row.name,
    target_score: row.target_score,
    games_per_player: row.games_per_player,
    draw_version: drawVersion,
    players,
    rounds,
    game_results: results,
    created_at: typeof row.created_at === "string" ? row.created_at : null,
    updated_at: typeof row.updated_at === "string" ? row.updated_at : null
  };
}

export function fromTournamentRow(untrustedRow) {
  const row = validateTournamentRow(untrustedRow);
  const drawVersion = row.draw_version;
  const results = new Map(
    (row.game_results || [])
      .filter((result) => result.draw_version === drawVersion)
      .map((result) => [result.game_id, result])
  );

  return {
    version: 1,
    id: row.id,
    cloud: true,
    drawVersion,
    name: row.name,
    targetScore: row.target_score,
    gamesPerPlayer: row.games_per_player,
    players: row.players,
    rounds: row.rounds.map((round) => ({
      number: round.number,
      byes: round.byes,
      games: round.games.map((game) => {
        const result = results.get(game.id);
        return {
          id: game.id,
          teamA: game.teamA,
          teamB: game.teamB,
          scoreA: result ? result.score_a : null,
          scoreB: result ? result.score_b : null
        };
      })
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** Changes whenever the draw or any score changes. */
export function tournamentSignature(tournament) {
  return JSON.stringify([
    tournament.drawVersion || 1,
    tournament.rounds.map((round) =>
      round.games.map((game) => [game.id, game.teamA, game.teamB, game.scoreA, game.scoreB])
    )
  ]);
}

export function createCloudClient(config, fetchImpl = globalThis.fetch) {
  const base = `${config.url}/rest/v1`;
  const headers = {
    apikey: config.key,
    "Content-Type": "application/json"
  };
  // Legacy anon keys are JWTs and also go in Authorization. New
  // sb_publishable_ keys must only be sent as apikey.
  if (config.key.startsWith("eyJ")) {
    headers.Authorization = `Bearer ${config.key}`;
  }

  async function request(path, { method = "GET", body, prefer } = {}) {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: prefer ? { ...headers, Prefer: prefer } : headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store"
    });

    if (!response.ok) {
      let detail = "";
      try {
        const payload = await response.json();
        detail = payload.message || payload.hint || "";
      } catch {
        // ignore unreadable error bodies
      }
      const error = new Error(detail || `Server error ${response.status}`);
      error.status = response.status;
      throw error;
    }

    if (response.status === 204) {
      return null;
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  return {
    async createTournament(tournament) {
      await request("/tournaments", {
        method: "POST",
        body: toTournamentRow(tournament),
        prefer: "return=minimal"
      });
    },

    async fetchTournament(id) {
      const rows = await request(
        `/tournaments?id=eq.${encodeURIComponent(id)}` +
          "&select=*,game_results(draw_version,game_id,score_a,score_b)"
      );
      return rows && rows.length ? fromTournamentRow(rows[0]) : null;
    },

    async listTournaments(limit = 12) {
      const rows = await request(
        `/tournaments?select=id,name,created_at,games_per_player,players&order=created_at.desc&limit=${limit}`
      );
      return (Array.isArray(rows) ? rows : [])
        .filter(
          (row) =>
            row &&
            typeof row.id === "string" &&
            TOURNAMENT_ID.test(row.id) &&
            typeof row.name === "string" &&
            Number.isInteger(row.games_per_player) &&
            !Number.isNaN(Date.parse(row.created_at))
        )
        .map((row) => ({
          id: row.id,
          name: row.name.slice(0, 48),
          created_at: row.created_at,
          games_per_player: row.games_per_player,
          playerCount: Array.isArray(row.players) ? row.players.length : 0
        }));
    },

    async saveResult(tournamentId, drawVersion, gameId, scoreA, scoreB) {
      await request("/game_results", {
        method: "POST",
        body: {
          tournament_id: tournamentId,
          draw_version: drawVersion,
          game_id: gameId,
          score_a: scoreA,
          score_b: scoreB
        },
        prefer: "resolution=merge-duplicates,return=minimal"
      });
    },

    /**
     * Replaces the draw only if nobody else redrew it first.
     * Returns false when the stored draw had already moved on.
     */
    async replaceDraw(tournamentId, expectedVersion, rounds) {
      const rows = await request(
        `/tournaments?id=eq.${encodeURIComponent(tournamentId)}&draw_version=eq.${expectedVersion}`,
        {
          method: "PATCH",
          body: { rounds: stripScores(rounds), draw_version: expectedVersion + 1 },
          prefer: "return=representation"
        }
      );
      return Array.isArray(rows) && rows.length === 1;
    }
  };
}
