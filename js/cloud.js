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
  const row = {
    id: tournament.id,
    name: tournament.name,
    target_score: tournament.targetScore,
    games_per_player: tournament.gamesPerPlayer,
    players: tournament.players,
    rounds: stripScores(tournament.rounds)
  };
  // The database decides the owner from the session. edit_mode is only a
  // request and is forced to "anyone" for guest tournaments.
  if (tournament.editMode) {
    row.edit_mode = tournament.editMode;
  }
  return row;
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

  const owned = row.owned === true;
  if (row.owned !== undefined && typeof row.owned !== "boolean") invalid("owner");
  if (row.is_owner !== undefined && typeof row.is_owner !== "boolean") invalid("owner");
  const isOwner = owned && row.is_owner === true;
  const ownerName = row.owner_name ?? null;
  if (ownerName !== null && (typeof ownerName !== "string" || ownerName.length > 80)) {
    invalid("owner name");
  }
  const editMode = row.edit_mode ?? "anyone";
  if (editMode !== "owner" && editMode !== "anyone") invalid("edit mode");

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
    owned,
    is_owner: isOwner,
    owner_name: owned ? ownerName || "Owner" : null,
    edit_mode: owned ? editMode : "anyone",
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
    owned: row.owned,
    isOwner: row.is_owner,
    ownerName: row.owner_name,
    editMode: row.edit_mode,
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
    tournament.editMode || "anyone",
    Boolean(tournament.isOwner),
    tournament.rounds.map((round) =>
      round.games.map((game) => [game.id, game.teamA, game.teamB, game.scoreA, game.scoreB])
    )
  ]);
}

function summaries(rows) {
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
      playerCount: Number.isInteger(row.player_count) ? row.player_count : 0
    }));
}

/**
 * @param getAccessToken optional async function returning the signed-in
 *   user's access token, or null for guests.
 */
export function createCloudClient(
  config,
  fetchImpl = globalThis.fetch,
  getAccessToken = async () => null
) {
  const base = `${config.url}/rest/v1`;

  async function buildHeaders(prefer) {
    const headers = {
      apikey: config.key,
      "Content-Type": "application/json"
    };
    const token = await getAccessToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    } else if (config.key.startsWith("eyJ")) {
      // Legacy anon keys are JWTs and also go in Authorization. New
      // sb_publishable_ keys must only be sent as apikey.
      headers.Authorization = `Bearer ${config.key}`;
    }
    if (prefer) {
      headers.Prefer = prefer;
    }
    return headers;
  }

  async function request(path, { method = "GET", body, prefer } = {}) {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: await buildHeaders(prefer),
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

  const rpc = (name, args) => request(`/rpc/${name}`, { method: "POST", body: args });

  return {
    /** Returns the stored tournament, including the owner the server set. */
    async createTournament(tournament) {
      const row = toTournamentRow(tournament);
      const stored = await rpc("create_tournament", {
        p_id: row.id,
        p_name: row.name,
        p_target_score: row.target_score,
        p_games_per_player: row.games_per_player,
        p_players: row.players,
        p_rounds: row.rounds,
        p_edit_mode: row.edit_mode ?? null
      });
      if (!stored || typeof stored !== "object") {
        throw new Error("The server did not confirm the new tournament.");
      }
      return fromTournamentRow(stored);
    },

    async fetchTournament(id) {
      if (!TOURNAMENT_ID.test(String(id))) {
        return null;
      }
      const row = await rpc("get_tournament", { p_id: id });
      return row ? fromTournamentRow(row) : null;
    },

    /** Returns false if the change was not allowed (not the owner). */
    async setEditMode(tournamentId, editMode) {
      return (await rpc("set_edit_mode", { p_id: tournamentId, p_mode: editMode })) === true;
    },

    /** Tournaments owned by the signed-in user. */
    async listOwnedTournaments(limit = 12) {
      return summaries(await rpc("my_tournaments", { p_limit: limit }));
    },

    /** Summaries for tournaments this browser has opened before. */
    async listTournamentsById(ids) {
      const safe = ids.filter((id) => TOURNAMENT_ID.test(String(id))).slice(0, 20);
      if (!safe.length) {
        return [];
      }
      const rows = summaries(await rpc("list_tournaments", { p_ids: safe }));
      const order = new Map(safe.map((id, index) => [id, index]));
      return rows.sort((a, b) => order.get(a.id) - order.get(b.id));
    },

    async saveResult(tournamentId, drawVersion, gameId, scoreA, scoreB) {
      await rpc("save_result", {
        p_tournament_id: tournamentId,
        p_draw_version: drawVersion,
        p_game_id: gameId,
        p_score_a: scoreA,
        p_score_b: scoreB
      });
    },

    /**
     * Replaces the draw only if nobody else redrew it first.
     * Returns false when the stored draw had already moved on.
     */
    async replaceDraw(tournamentId, expectedVersion, rounds) {
      return (
        (await rpc("redraw_tournament", {
          p_id: tournamentId,
          p_expected_version: expectedVersion,
          p_rounds: stripScores(rounds)
        })) === true
      );
    }
  };
}
