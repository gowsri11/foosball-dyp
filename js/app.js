import {
  computeStandings,
  exactGameCounts,
  generateSchedule,
  getProgress,
  getSchedulePlan,
  isRecordedScore,
  isRoundComplete,
  standingsMode,
  validateScore
} from "./scheduler.js";
import {
  createCloudClient,
  createShareId,
  loadCloudConfig,
  tournamentSignature
} from "./cloud.js";
import {
  currentUser,
  getAccessToken,
  initAuth,
  onUserChange,
  signInWithGoogle,
  signOut,
  takeSavedDraft
} from "./auth.js";

const STORAGE_KEY = "foosball-dyp.v1";
const LOCAL_BACKUP_KEY = "foosball-dyp.v1.local-backup";
const POLL_INTERVAL_MS = 4000;
const SHARE_ID_PATTERN = /^[A-Za-z0-9]{8,24}$/;
const HISTORY_KEY = "foosball-dyp.v1.history";
const HISTORY_LIMIT = 12;
const MAX_PLAYERS = 40;
const MAX_GAMES_PER_PLAYER = 20;

const app = document.querySelector("#app");
const modalRoot = document.querySelector("#modal-root");
const toastRoot = document.querySelector("#toast-root");

let tournament = loadTournament();
let ui = {
  roundIndex: 0,
  editingGameId: null,
  setupDraft: null,
  busy: false
};

// Live sync with Supabase. `cloud` stays null when /api/config has no keys,
// and the app then works exactly as before, saving to this browser only.
let cloud = null;
let user = null;
let authAvailable = false;
const sync = {
  status: "local",
  timer: null,
  inFlight: false,
  deferred: false,
  pending: new Map()
};

const icons = {
  ball: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.6"/>
      <circle cx="12" cy="12" r="2.6" fill="currentColor"/>
      <path d="M12 3.5v4.9M12 15.6v4.9M3.5 12h4.9M15.6 12h4.9" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
    </svg>`,
  arrow: `
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4 10h11M11 5l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`,
  chevronLeft: `
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M12.5 4.5 7 10l5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`,
  chevronRight: `
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M7.5 4.5 13 10l-5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`,
  shuffle: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h3.2c1.4 0 2.7.7 3.5 1.8l2.6 3.6c.8 1.2 2.1 1.8 3.5 1.8H20M18 11l3 3-3 3M4 17h3.2c1.4 0 2.7-.7 3.5-1.8l.8-1.1M13.3 8.5l.6-.8C14.7 6.7 16 6 17.4 6H20M18 3l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`,
  grid: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.6"/>
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.6"/>
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.6"/>
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.6"/>
    </svg>`,
  chart: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 19.5V13M10 19.5V8M16 19.5V4.5M22 19.5H2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
    </svg>`,
  trophy: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 4h8v4.2a4 4 0 0 1-8 0V4Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
      <path d="M8 5.5H4.8v1.7A3.8 3.8 0 0 0 8.6 11M16 5.5h3.2v1.7A3.8 3.8 0 0 1 15.4 11M12 12.3V16M8.5 20h7M9.5 16h5l1 4h-7l1-4Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`,
  check: `
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m4.5 10.5 3.4 3.4 7.6-8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`,
  edit: `
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m12.7 4.2 3.1 3.1-8.4 8.4-3.8.7.7-3.8 8.4-8.4ZM11.2 5.7l3.1 3.1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`,
  download: `
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 3v9M6.5 8.5 10 12l3.5-3.5M4 15.5h12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`,
  google: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.4-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.5h3.24c1.9-1.75 2.98-4.32 2.98-7.35z"/>
      <path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.62-2.42l-3.24-2.5c-.9.6-2.04.96-3.38.96-2.6 0-4.8-1.76-5.59-4.12H3.07v2.58A10 10 0 0 0 12 22z"/>
      <path fill="#FBBC05" d="M6.41 13.92a6 6 0 0 1 0-3.84V7.5H3.07a10 10 0 0 0 0 9z"/>
      <path fill="#EA4335" d="M12 5.96c1.47 0 2.79.5 3.83 1.5l2.87-2.87A9.62 9.62 0 0 0 12 2a10 10 0 0 0-8.93 5.5l3.34 2.58C7.2 7.72 9.4 5.96 12 5.96z"/>
    </svg>
  `,
  lock: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="10.5" width="14" height="9.5" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.7"/>
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" fill="none" stroke="currentColor" stroke-width="1.7"/>
    </svg>
  `,
  link: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      <path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </svg>
  `,
  info: `
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="7.2" fill="none" stroke="currentColor" stroke-width="1.4"/>
      <path d="M10 9v4.6M10 6.4v.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
    </svg>`,
  close: `
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m5 5 10 10M15 5 5 15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
    </svg>`,
  users: `
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="7.2" cy="7" r="2.7" fill="none" stroke="currentColor" stroke-width="1.4"/>
      <path d="M2.8 16c.4-3 2-4.6 4.4-4.6s4 1.6 4.4 4.6M13 10.2c2 0 3.4 1.4 4 4M13 4.6a2.4 2.4 0 0 1 0 4.7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
    </svg>`,
  target: `
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.4"/>
      <circle cx="10" cy="10" r="3.6" fill="none" stroke="currentColor" stroke-width="1.4"/>
      <circle cx="10" cy="10" r="1" fill="currentColor"/>
    </svg>`,
  calendar: `
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="3" y="4.5" width="14" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/>
      <path d="M6.5 2.8v3.4M13.5 2.8v3.4M3 8h14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
    </svg>`,
  plus: `
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
    </svg>`,
  minus: `
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 8h10" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
    </svg>`,
  reset: `
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4.2 7.2A6.4 6.4 0 1 1 4 12M4.2 3.3v4.2h4.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`
};

function icon(name) {
  return icons[name] || "";
}

boot();

function renderSetup() {
  const draft = sanitizeDraft(ui.setupDraft) || {
    name: "",
    players: "",
    games: 4,
    target: 7
  };

  document.title = "Foosball DYP";
  app.innerHTML = `
    <div class="app-shell setup-shell">
      <header class="site-header">
        ${brandMarkup()}
        <div class="header-actions">
          <span class="header-note">2v2 · Individual scoring</span>
          <button class="button ghost header-secondary" type="button" data-action="show-rules" aria-label="How it works">
            ${icon("info")}
            <span>How it works</span>
          </button>
          <span id="auth-slot" class="auth-slot">${authControlMarkup()}</span>
        </div>
      </header>

      <main class="setup-main">
        <section class="setup-copy" aria-labelledby="setup-title">
          <div class="eyebrow"><span class="eyebrow-dot"></span> Draw your partner</div>
          <h1 id="setup-title">Good draws.<br /><span>Better games.</span></h1>
          <p class="lede">
            Run a balanced 2v2 foosball tournament with rotating partners,
            the fewest possible rounds, and a live table that settles every tie.
          </p>

          <div class="proof-row" aria-label="Tournament features">
            <div class="proof-item">
              <span class="proof-icon">${icon("grid")}</span>
              <strong>Fewest rounds</strong>
              <span>Built around your table count</span>
            </div>
            <div class="proof-item">
              <span class="proof-icon">${icon("shuffle")}</span>
              <strong>Fresh draws</strong>
              <span>Partners and opponents mixed</span>
            </div>
            <div class="proof-item">
              <span class="proof-icon">${icon("chart")}</span>
              <strong>Live table</strong>
              <span>Points, goals and goal diff</span>
            </div>
          </div>

          ${sampleTicketMarkup()}

          <div id="recent-tournaments" class="recent-tournaments" hidden></div>
        </section>

        <section class="setup-card card" aria-labelledby="create-title">
          <div class="card-kicker">
            <span>New tournament</span>
            <span class="kicker-step">01</span>
          </div>
          <h2 id="create-title">Set your table.</h2>
          <p class="card-intro">
            Add the roster, choose the race length, and the draw engine does the rest.
          </p>

          <form id="setup-form" novalidate>
            <label class="field">
              <span class="field-label">Tournament name</span>
              <input
                id="tournament-name"
                name="name"
                type="text"
                maxlength="48"
                autocomplete="off"
                placeholder="Friday night foosball"
                value="${escapeHtml(draft.name)}"
              />
            </label>

            <label class="field">
              <span class="field-label">
                Players
                <em id="player-count">0 players</em>
              </span>
              <textarea
                id="players-input"
                name="players"
                rows="6"
                spellcheck="false"
                placeholder="Anika&#10;Ravi&#10;Sam&#10;Jo&#10;Mira&#10;Dev"
              >${escapeHtml(draft.players)}</textarea>
              <small class="field-hint">One per line, or separate names with commas. Four players minimum.</small>
            </label>

            <div class="settings-grid">
              <div class="field">
                <span class="field-label">Games per player</span>
                <div class="stepper">
                  <button class="stepper-button" type="button" data-action="step-games" data-step="-1" aria-label="Decrease games per player">
                    ${icon("minus")}
                  </button>
                  <input
                    id="games-input"
                    name="games"
                    type="number"
                    inputmode="numeric"
                    min="1"
                    max="${MAX_GAMES_PER_PLAYER}"
                    step="1"
                    value="${escapeHtml(String(draft.games))}"
                    aria-label="Games per player"
                  />
                  <button class="stepper-button" type="button" data-action="step-games" data-step="1" aria-label="Increase games per player">
                    ${icon("plus")}
                  </button>
                </div>
              </div>

              <div class="field">
                <span class="field-label">Race to</span>
                <div class="segmented" role="group" aria-label="Points needed to win">
                  <label>
                    <input type="radio" name="target" value="7" ${draft.target === 7 ? "checked" : ""} />
                    <span>7 pts</span>
                  </label>
                  <label>
                    <input type="radio" name="target" value="10" ${draft.target === 10 ? "checked" : ""} />
                    <span>10 pts</span>
                  </label>
                </div>
              </div>
            </div>

            <div id="games-hint" class="games-hint" aria-live="polite"></div>

            <div id="format-preview" class="format-preview" aria-live="polite"></div>

            <p id="setup-error" class="form-error" role="alert" hidden></p>

            <button class="button primary generate-button" type="submit">
              <span>Generate schedule</span>
              ${icon("arrow")}
            </button>
            <p id="setup-footnote" class="form-footnote">${setupFootnote()}</p>
          </form>
        </section>
      </main>
    </div>
  `;

  updateSetupPreview();
  refreshRecentTournaments();
}

function setupFootnote() {
  if (!cloud) {
    return "Your tournament stays in this browser. No account needed.";
  }
  if (user) {
    return `You will own this tournament. Only you can redraw, and you choose who can enter scores.`;
  }
  return authAvailable
    ? "Guest tournament: anyone with the link can enter scores and redraw. Sign in to own it."
    : "Saved online. Share the link so anyone can follow along and enter scores.";
}

function sanitizeDraft(draft) {
  if (!draft || typeof draft !== "object") {
    return null;
  }
  const games = Math.floor(Number(draft.games));
  return {
    name: typeof draft.name === "string" ? draft.name.slice(0, 48) : "",
    players: typeof draft.players === "string" ? draft.players.slice(0, 4000) : "",
    games: Number.isFinite(games) ? clamp(games, 1, MAX_GAMES_PER_PLAYER) : 4,
    target: Number(draft.target) === 10 ? 10 : 7
  };
}

function readSetupDraftFromPage() {
  const form = document.querySelector("#setup-form");
  if (!form) {
    return null;
  }
  return {
    name: form.querySelector('[name="name"]').value,
    players: form.querySelector('[name="players"]').value,
    games: form.querySelector('[name="games"]').value,
    target: form.querySelector('input[name="target"]:checked')?.value || 7
  };
}

// ---- Sign-in and permissions ---------------------------------------------

function authControlMarkup() {
  if (!authAvailable) {
    return "";
  }
  if (!user) {
    return `
      <button class="button ghost compact auth-button" type="button" data-action="sign-in">
        ${icon("google")}
        <span>Sign in</span>
      </button>
    `;
  }
  const mine = `
    <button class="button ghost compact header-secondary" type="button" data-action="my-tournaments" aria-label="My tournaments">
      ${icon("grid")}
      <span>My tournaments</span>
    </button>
  `;
  const avatar = user.avatarUrl
    ? `<img class="auth-avatar" src="${escapeHtml(user.avatarUrl)}" alt="" referrerpolicy="no-referrer" />`
    : `<span class="avatar small" style="--avatar-hue: ${hueForName(user.name)}" aria-hidden="true">${escapeHtml(initialsForName(user.name))}</span>`;
  return `
    ${mine}
    <span class="auth-user" title="${escapeHtml(user.email)}">
      ${avatar}
      <span class="auth-name">${escapeHtml(user.name)}</span>
    </span>
    <button class="button text compact" type="button" data-action="sign-out">Sign out</button>
  `;
}

function isOwner(current = tournament) {
  return Boolean(current?.owned && current.isOwner && user);
}

function canScore(current = tournament) {
  if (!current?.cloud || !current.owned) {
    return true;
  }
  return current.editMode === "anyone" || isOwner(current);
}

function canRedraw(current = tournament) {
  if (!current?.cloud || !current.owned) {
    return true;
  }
  return isOwner(current);
}

function accessBarMarkup() {
  if (!tournament?.cloud) {
    return "";
  }
  if (!tournament.owned) {
    return `
      <div class="access-bar">
        <span class="access-text">
          <strong>Guest tournament.</strong> Anyone with the link can enter scores and redraw.
        </span>
      </div>
    `;
  }
  const ownerName = escapeHtml(tournament.ownerName || "the owner");
  if (isOwner()) {
    const mode = tournament.editMode;
    return `
      <div class="access-bar is-owner">
        <span class="access-text">
          <strong>You own this tournament.</strong> Only you can redraw.
        </span>
        <div class="access-toggle">
          <span>Who can enter scores</span>
          <div class="segmented compact" role="group" aria-label="Who can enter scores">
            <button type="button" data-action="set-edit-mode" data-mode="owner" aria-pressed="${mode === "owner"}" class="${mode === "owner" ? "is-active" : ""}">Only me</button>
            <button type="button" data-action="set-edit-mode" data-mode="anyone" aria-pressed="${mode === "anyone"}" class="${mode === "anyone" ? "is-active" : ""}">Anyone with the link</button>
          </div>
        </div>
      </div>
    `;
  }
  return `
    <div class="access-bar ${tournament.editMode === "owner" ? "is-locked" : ""}">
      <span class="access-text">
        ${
          tournament.editMode === "owner"
            ? `${icon("lock")} <strong>View only.</strong> ${ownerName} is entering the scores.${user ? "" : " Following live."}`
            : `<strong>Run by ${ownerName}.</strong> Anyone with the link can enter scores.`
        }
      </span>
    </div>
  `;
}

async function changeEditMode(mode) {
  if (!tournament?.cloud || !isOwner() || !cloud || tournament.editMode === mode) {
    return;
  }
  const previous = tournament.editMode;
  tournament.editMode = mode;
  renderTournament();
  try {
    const changed = await cloud.setEditMode(tournament.id, mode);
    if (!changed) {
      throw new Error("not allowed");
    }
    persistTournament();
    showToast(
      mode === "owner"
        ? "Only you can enter scores now."
        : "Anyone with the link can enter scores now."
    );
  } catch {
    tournament.editMode = previous;
    renderTournament();
    showToast("Could not change who can enter scores. Try again.", "error");
  }
}

async function startSignIn() {
  try {
    await signInWithGoogle(readSetupDraftFromPage());
  } catch {
    showToast("Could not start sign-in. Try again.", "error");
  }
}

async function handleSignOut() {
  try {
    await signOut();
  } catch {
    // the session is cleared locally either way
  }
  showToast("Signed out.");
}

function handleUserChange(nextUser) {
  user = nextUser;
  if (tournament) {
    if (tournament.cloud) {
      // Ownership is decided by the server for the signed-in user.
      tournament.isOwner = false;
      pollOnce({ force: true });
    }
    ui.editingGameId = canScore() ? ui.editingGameId : null;
    renderTournament();
  } else {
    ui.setupDraft = readSetupDraftFromPage() || ui.setupDraft;
    renderSetup();
  }
}

function rememberTournament(id) {
  try {
    const list = readHistory().filter((item) => item !== id);
    list.unshift(id);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_LIMIT)));
  } catch {
    // storage blocked; history is a convenience only
  }
}

function readHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((id) => typeof id === "string" && SHARE_ID_PATTERN.test(id))
      : [];
  } catch {
    return [];
  }
}

function renderLoading(message) {
  document.title = "Foosball DYP";
  app.innerHTML = `
    <div class="app-shell setup-shell">
      <header class="site-header">${brandMarkup()}</header>
      <main class="loading-main">
        <div class="busy-card loading-card" role="status">
          <span class="busy-spinner" aria-hidden="true">${icon("ball")}</span>
          <strong>${escapeHtml(message)}</strong>
          <span>Fetching the latest scores...</span>
        </div>
      </main>
    </div>
  `;
}

function renderTournament() {
  ensureTournamentState();

  const plan = getSchedulePlan(
    tournament.players.length,
    tournament.gamesPerPlayer
  );
  const progress = getProgress(tournament.rounds);
  const standings = computeStandings(tournament.players, tournament.rounds);
  const round = tournament.rounds[ui.roundIndex];
  const champion = progress.complete ? standings[0] : null;

  document.title = `${tournament.name} · Foosball DYP`;
  app.innerHTML = `
    <div class="app-shell tournament-shell">
      <header class="site-header">
        ${brandMarkup()}
        <div class="header-actions">
          ${syncPillMarkup()}
          ${
            tournament.cloud
              ? `<button class="button ghost header-secondary" type="button" data-action="copy-link" aria-label="Copy tournament link">
                  ${icon("link")}
                  <span>Copy link</span>
                </button>`
              : ""
          }
          <button class="button ghost header-secondary" type="button" data-action="show-rules" aria-label="How it works">
            ${icon("info")}
            <span>How it works</span>
          </button>
          <button class="button ghost header-secondary" type="button" data-action="export-csv" aria-label="Export standings as CSV">
            ${icon("download")}
            <span>Export</span>
          </button>
          <button class="button primary compact" type="button" data-action="new-tournament">
            New tournament
          </button>
          <span id="auth-slot" class="auth-slot">${authControlMarkup()}</span>
        </div>
      </header>

      <main class="tournament-main">
        <section class="tournament-hero" aria-labelledby="tournament-title">
          <div class="hero-copy">
            <div class="eyebrow">
              <span class="status-dot ${progress.complete ? "is-complete" : ""}"></span>
              ${progress.complete ? "Tournament complete" : "Tournament in progress"}
            </div>
            <h1 id="tournament-title">${escapeHtml(tournament.name)}</h1>
            <div class="meta-line">
              <span>${tournament.players.length} players</span>
              <span>${
                plan.extraAppearances
                  ? `${tournament.gamesPerPlayer}–${tournament.gamesPerPlayer + 1} games each`
                  : `${tournament.gamesPerPlayer} ${tournament.gamesPerPlayer === 1 ? "game" : "games"} each`
              }</span>
              <span>Race to ${tournament.targetScore}</span>
              <span class="meta-pill">${plan.rounds} ${plan.rounds === 1 ? "round" : "rounds"} · minimum</span>
            </div>
          </div>

          ${progressPanelMarkup(progress)}
        </section>

        ${accessBarMarkup()}

        ${champion ? championMarkup(champion) : ""}

        <div class="dashboard-grid">
          <section class="schedule-card card" aria-labelledby="round-title">
            ${roundTabsMarkup()}
            <div class="round-panel">
              <div class="round-heading">
                <div>
                  <span class="eyebrow">Round ${round.number} of ${tournament.rounds.length}</span>
                  <h2 id="round-title">Round ${round.number}</h2>
                  <p class="round-subtitle">
                    ${round.games.length} ${round.games.length === 1 ? "match" : "matches"}
                    ${round.byes.length ? `· ${round.byes.length} on bye` : "· full house"}
                    · first to ${tournament.targetScore}
                  </p>
                </div>
                <div class="round-switcher">
                  <button
                    class="icon-button"
                    type="button"
                    data-action="prev-round"
                    aria-label="Previous round"
                    ${ui.roundIndex === 0 ? "disabled" : ""}
                  >${icon("chevronLeft")}</button>
                  <span>${ui.roundIndex + 1} / ${tournament.rounds.length}</span>
                  <button
                    class="icon-button"
                    type="button"
                    data-action="next-round"
                    aria-label="Next round"
                    ${ui.roundIndex === tournament.rounds.length - 1 ? "disabled" : ""}
                  >${icon("chevronRight")}</button>
                </div>
              </div>

              ${roundStatusMarkup(round)}

              <div class="games-grid">
                ${round.games
                  .map((game, index) =>
                    gameCardMarkup(game, index, round)
                  )
                  .join("")}
              </div>

              ${byeMarkup(round)}
            </div>
          </section>

          ${standingsMarkup(standings, progress)}
        </div>

        <footer class="app-footer">
          <div class="footer-note">
            <span class="footer-mark">DYP</span>
            <p>
              The <strong>${plan.rounds}-round draw</strong> is the fewest possible for
              ${tournament.players.length} players at
              ${tournament.gamesPerPlayer} ${tournament.gamesPerPlayer === 1 ? "game" : "games"} each.
              ${
                plan.extraAppearances
                  ? `${plan.extraAppearances} ${plan.extraAppearances === 1 ? "player gets" : "players get"} one extra match to fill every four-player draw.`
                  : plan.byesTotal
                    ? `${plan.byesTotal} ${plan.byesTotal === 1 ? "bye is" : "byes are"} rotated through the draw.`
                    : "Everyone plays every round."
              }
            </p>
          </div>
          ${
            canRedraw()
              ? `<button class="button ghost compact" type="button" data-action="regenerate">
                  ${icon("reset")}
                  <span>Regenerate draw</span>
                </button>`
              : ""
          }
        </footer>
      </main>
    </div>
  `;

  requestAnimationFrame(() => {
    const tabs = document.querySelector(".round-tabs");
    const active = document.querySelector(".round-tab.is-active");

    if (tabs && active) {
      tabs.scrollLeft = Math.max(
        0,
        active.offsetLeft - tabs.clientWidth / 2 + active.clientWidth / 2
      );
    }
  });
}

function brandMarkup() {
  return `
    <div class="brand" aria-label="Foosball DYP">
      <span class="brand-mark">${icon("ball")}</span>
      <span class="brand-name">FOOSBALL <em>DYP</em></span>
    </div>
  `;
}

function sampleTicketMarkup() {
  return `
    <div class="sample-ticket" aria-hidden="true">
      <div class="ticket-top">
        <span>Sample draw · Round 03</span>
        <span class="ticket-live"><i></i> Race to 7</span>
      </div>
      <div class="ticket-match">
        <div class="ticket-team">
          <div class="ticket-avatars">
            <span class="mini-avatar" style="--avatar-hue: 84">AR</span>
            <span class="mini-avatar" style="--avatar-hue: 156">RP</span>
          </div>
          <div><strong>Anika + Ravi</strong><small>Team Lime</small></div>
        </div>
        <div class="ticket-score"><strong>7</strong><span>:</span><strong>4</strong></div>
        <div class="ticket-team is-right">
          <div class="ticket-avatars">
            <span class="mini-avatar" style="--avatar-hue: 24">SK</span>
            <span class="mini-avatar" style="--avatar-hue: 318">JO</span>
          </div>
          <div><strong>Sam + Jo</strong><small>Team Tangerine</small></div>
        </div>
      </div>
      <div class="ticket-bottom">
        <span>Partners drawn fresh</span>
        <span>1 win = 1 point</span>
      </div>
    </div>
  `;
}

function progressPanelMarkup(progress) {
  return `
    <div class="progress-panel">
      <div class="progress-ring" aria-hidden="true">
        <svg viewBox="0 0 100 100">
          <circle class="ring-track" cx="50" cy="50" r="43" pathLength="100"></circle>
          <circle
            class="ring-fill"
            cx="50"
            cy="50"
            r="43"
            pathLength="100"
            stroke-dasharray="${progress.percent} 100"
          ></circle>
        </svg>
        <div class="ring-label"><strong>${progress.percent}%</strong><span>played</span></div>
      </div>
      <div class="progress-copy">
        <span class="small-label">Match progress</span>
        <strong>${progress.completed} of ${progress.total}</strong>
        <span>${progress.complete ? "Every result is in." : `${progress.remaining} matches remaining`}</span>
      </div>
    </div>
  `;
}

function championMarkup(champion) {
  return `
    <section class="champion-banner" aria-label="Tournament champion">
      <div class="champion-icon">${icon("trophy")}</div>
      <div class="champion-copy">
        <span>Tournament champion</span>
        <h2>${escapeHtml(champion.name)}</h2>
      </div>
      <div class="champion-stats">
        <div><strong>${champion.points}</strong><span>points</span></div>
        <div><strong>${formatDifference(champion.goalDifference)}</strong><span>goal diff</span></div>
        <div><strong>${champion.goalsFor}</strong><span>goals</span></div>
      </div>
    </section>
  `;
}

function roundTabsMarkup() {
  return `
    <div class="round-tabs-wrap">
      <nav class="round-tabs" aria-label="Tournament rounds">
        ${tournament.rounds
          .map((round, index) => {
            const complete = isRoundComplete(round);
            const active = index === ui.roundIndex;
            const completed = round.games.filter(isRecordedScore).length;

            return `
              <button
                class="round-tab ${active ? "is-active" : ""} ${complete ? "is-complete" : ""}"
                type="button"
                data-action="select-round"
                data-index="${index}"
                ${active ? 'aria-current="step"' : ""}
              >
                <span class="round-tab-number">${String(index + 1).padStart(2, "0")}</span>
                <span class="round-tab-copy">
                  <strong>Round ${index + 1}</strong>
                  <small>${completed}/${round.games.length} played</small>
                </span>
                <span class="round-tab-mark">
                  ${complete ? icon("check") : active ? "<i></i>" : ""}
                </span>
              </button>
            `;
          })
          .join("")}
      </nav>
    </div>
  `;
}

function roundStatusMarkup(round) {
  const completed = round.games.filter(isRecordedScore).length;
  const complete = completed === round.games.length;

  return `
    <div class="round-status">
      <span class="status-tag ${complete ? "is-complete" : ""}">
        ${complete ? icon("check") : "<i></i>"}
        ${complete ? "Round complete" : "Enter scores"}
      </span>
      <span class="status-separator"></span>
      <span>${completed} of ${round.games.length} results saved</span>
    </div>
  `;
}

function gameCardMarkup(game, index, round) {
  const complete = isRecordedScore(game);
  const editing = ui.editingGameId === game.id;
  const winner =
    complete && game.scoreA !== game.scoreB
      ? game.scoreA > game.scoreB
        ? "A"
        : "B"
      : null;
  const allowed = canScore();
  const showInputs = allowed && (!complete || editing);

  return `
    <article
      class="game-card ${complete && !editing ? "is-complete" : ""} ${editing ? "is-editing" : ""}"
      data-game-id="${escapeHtml(game.id)}"
      data-round-number="${escapeHtml(String(round.number))}"
    >
      <header class="game-card-head">
        <span class="match-label">Match ${index + 1}</span>
        <span class="game-status ${complete ? "is-final" : ""}">
          ${editing ? "Editing" : complete ? "Final" : "Pending"}
        </span>
      </header>

      <div class="matchup">
        ${teamRowMarkup(game, "A", winner, showInputs)}
        <div class="match-vs"><span>vs</span></div>
        ${teamRowMarkup(game, "B", winner, showInputs)}
      </div>

      ${
        showInputs
          ? `
            <div class="game-entry">
              <span class="target-hint">${icon("target")} First to ${tournament.targetScore}</span>
              <div class="game-actions">
                ${editing ? `<button class="button text compact" type="button" data-action="cancel-edit">Cancel</button>` : ""}
                <button class="button primary compact" type="button" data-action="save-game">
                  Save result
                </button>
              </div>
            </div>
          `
          : `
            <footer class="game-footer">
              ${
                complete
                  ? `<span class="final-label">${icon("check")} Result saved</span>`
                  : `<span class="final-label is-waiting">${icon("lock")} Waiting for ${escapeHtml(tournament.ownerName || "the owner")}</span>`
              }
              ${
                allowed
                  ? `<button class="button text compact" type="button" data-action="edit-game">
                      ${icon("edit")} Edit score
                    </button>`
                  : ""
              }
            </footer>
          `
      }
      <p class="game-error" role="alert" hidden></p>
    </article>
  `;
}

function teamRowMarkup(game, side, winner, showInputs) {
  const ids = side === "A" ? game.teamA : game.teamB;
  const score = side === "A" ? game.scoreA : game.scoreB;
  const isWinner = winner === side;

  return `
    <div class="team-row ${isWinner ? "is-winner" : ""}">
      <div class="team-main">
        <span class="team-side">Team ${side}</span>
        <div class="team-players">
          ${ids
            .map((id) => {
              const player = tournament.players.find((item) => item.id === id);
              return playerMarkup(player);
            })
            .join("")}
        </div>
      </div>
      <div class="team-score">
        ${
          showInputs
            ? `<input
                class="score-input"
                type="number"
                inputmode="numeric"
                min="0"
                max="${tournament.targetScore}"
                step="1"
                value="${score ?? ""}"
                data-score="${side}"
                aria-label="Team ${side} score"
              />`
            : `<strong>${score}</strong>`
        }
      </div>
    </div>
  `;
}

function playerMarkup(player) {
  if (!player) {
    return "";
  }

  return `
    <span class="player-chip">
      <span class="avatar" style="--avatar-hue: ${hueForName(player.name)}" aria-hidden="true">${escapeHtml(initialsForName(player.name))}</span>
      <span class="player-name">${escapeHtml(player.name)}</span>
    </span>
  `;
}

function byeMarkup(round) {
  const players = round.byes
    .map((id) => tournament.players.find((player) => player.id === id))
    .filter(Boolean);

  return `
    <div class="bye-card ${players.length ? "" : "is-empty"}">
      <span class="bye-icon">${icon(players.length ? "shuffle" : "users")}</span>
      <div>
        <span class="bye-label">${players.length ? "On the bench" : "Full house"}</span>
        <div class="bye-names">
          ${
            players.length
              ? players
                  .map(
                    (player) =>
                      `<span class="bye-chip">${escapeHtml(player.name)}</span>`
                  )
                  .join("")
              : "<span>Every player is in play this round.</span>"
          }
        </div>
      </div>
    </div>
  `;
}

function standingsMarkup(standings, progress) {
  const byWinRate = standings[0]?.mode === "winRate";
  return `
    <aside class="standings-card card" aria-labelledby="standings-title">
      <div class="standings-head">
        <div>
          <span class="eyebrow">Live table</span>
          <h2 id="standings-title">Standings</h2>
        </div>
        <span class="results-count">${progress.completed}/${progress.total}</span>
      </div>

      <div class="table-wrap">
        <table class="standings-table">
          <thead>
            <tr>
              <th class="col-rank">#</th>
              <th class="col-player">Player</th>
              <th title="Played">P</th>
              <th title="Wins">W</th>
              <th title="Goals for">GF</th>
              <th title="Goals against">GA</th>
              <th title="Goal difference">GD</th>
              ${
                byWinRate
                  ? `<th title="Points">Pts</th><th class="col-points" title="Win rate">Win %</th>`
                  : `<th class="col-points" title="Points">Pts</th>`
              }
            </tr>
          </thead>
          <tbody>
            ${standings
              .map(
                (player) => `
                  <tr class="${player.rank === 1 && player.played > 0 ? "is-leading" : ""}">
                    <td class="col-rank"><span class="rank-badge">${player.rank}</span></td>
                    <td class="col-player">
                      <span class="table-player">
                        <span class="avatar small" style="--avatar-hue: ${hueForName(player.name)}" aria-hidden="true">${escapeHtml(initialsForName(player.name))}</span>
                        <span>${escapeHtml(player.name)}</span>
                      </span>
                    </td>
                    <td>${player.played}</td>
                    <td>${player.wins}</td>
                    <td>${player.goalsFor}</td>
                    <td>${player.goalsAgainst}</td>
                    <td class="${differenceClass(player.goalDifference)}">${formatDifference(player.goalDifference)}</td>
                    ${
                      byWinRate
                        ? `<td>${player.points}</td><td class="col-points">${formatRate(player.winRate, player.played)}</td>`
                        : `<td class="col-points">${player.points}</td>`
                    }
                  </tr>
                `
              )
              .join("")}
          </tbody>
        </table>
      </div>

      <div class="tiebreak-note">
        ${icon("info")}
        <span>${
          byWinRate
            ? "Some players have an extra game, so ranking is by win rate, then goal difference per game, then goals per game."
            : "Ties broken by points, then goal difference, then goals scored."
        }</span>
      </div>
    </aside>
  `;
}

function updateSetupPreview() {
  const textarea = document.querySelector("#players-input");
  const gamesInput = document.querySelector("#games-input");
  const preview = document.querySelector("#format-preview");
  const count = document.querySelector("#player-count");

  if (!textarea || !gamesInput || !preview || !count) {
    return;
  }

  const { names, duplicates } = parsePlayerNames(textarea.value);
  const games = clamp(
    Math.floor(Number(gamesInput.value) || 1),
    1,
    MAX_GAMES_PER_PLAYER
  );
  const plan = getSchedulePlan(names.length, games);

  count.textContent = `${names.length} ${names.length === 1 ? "player" : "players"}`;
  renderGamesHint(names.length, games, plan);

  if (duplicates.length) {
    preview.innerHTML = `
      <div class="preview-empty is-warning">
        <span class="preview-icon">${icon("info")}</span>
        <p>Duplicate name: <strong>${escapeHtml(duplicates[0])}</strong>. Each player needs a unique name.</p>
      </div>
    `;
    return;
  }

  if (!plan.valid) {
    preview.innerHTML = `
      <div class="preview-empty">
        <span class="preview-icon">${icon("users")}</span>
        <p>Add at least four players to preview the draw.</p>
      </div>
    `;
    return;
  }

  const note = plan.extraAppearances
    ? `${plan.extraAppearances} ${plan.extraAppearances === 1 ? "player" : "players"} will get one extra match to fill every four-player draw.`
    : plan.byesTotal
      ? "Byes rotate across rounds, keeping the schedule as tight as possible."
      : "Everyone plays in every round.";

  preview.innerHTML = `
    <div class="preview-heading">
      <span>Projected draw</span>
      <span class="preview-badge">Fewest rounds</span>
    </div>
    <div class="preview-stats">
      <div><strong>${plan.rounds}</strong><span>${plan.rounds === 1 ? "round" : "rounds"}</span></div>
      <div><strong>${plan.totalGames}</strong><span>${plan.totalGames === 1 ? "match" : "matches"}</span></div>
      <div><strong>${plan.byesTotal}</strong><span>${plan.byesTotal === 1 ? "bye" : "byes"}</span></div>
    </div>
    <p class="preview-note">${note}</p>
  `;
}

function renderGamesHint(playerCount, games, plan) {
  const hint = document.querySelector("#games-hint");
  if (!hint) {
    return;
  }

  const options = exactGameCounts(playerCount, MAX_GAMES_PER_PLAYER);
  if (!plan.valid || options.length === 0) {
    hint.innerHTML = "";
    return;
  }

  const chips = options
    .map(
      (value) => `
        <button
          class="games-chip ${value === games ? "is-active" : ""}"
          type="button"
          data-action="set-games"
          data-games="${value}"
          aria-pressed="${value === games}"
        >${value}</button>
      `
    )
    .join("");

  const warning = plan.extraAppearances
    ? `
      <div class="games-warning" role="status">
        <span class="preview-icon">${icon("info")}</span>
        <p>
          <strong>Uneven games.</strong>
          ${playerCount} players × ${games} ${games === 1 ? "game" : "games"} does not fill whole matches, so
          ${plan.extraAppearances} ${plan.extraAppearances === 1 ? "player gets" : "players get"} one extra game.
          The table will rank by win rate, then goal difference per game.
        </p>
      </div>
    `
    : "";

  hint.innerHTML = `
    <div class="games-hint-head">
      <span>Equal games for everyone</span>
      <small>Tap to use</small>
    </div>
    <div class="games-chips" role="group" aria-label="Games per player with equal games for everyone">
      ${chips}
    </div>
    ${warning}
  `;
}

function parsePlayerNames(raw) {
  const entries = raw
    .split(/[\n,;]+/)
    .map((name) => name.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const seen = new Set();
  const names = [];
  const duplicates = [];

  for (const entry of entries) {
    const key = entry.toLocaleLowerCase();
    if (seen.has(key)) {
      duplicates.push(entry);
    } else {
      seen.add(key);
      names.push(entry);
    }
  }

  return { names, duplicates };
}

function readSetupForm(form) {
  const { names, duplicates } = parsePlayerNames(
    form.querySelector('[name="players"]').value
  );
  const games = clamp(
    Math.floor(Number(form.querySelector('[name="games"]').value) || 1),
    1,
    MAX_GAMES_PER_PLAYER
  );
  const target = Number(
    form.querySelector('input[name="target"]:checked')?.value || 7
  );
  const name =
    form.querySelector('[name="name"]').value.trim() || "Foosball Tournament";

  return { name, names, duplicates, games, target };
}

function validateSetup({ names, duplicates }) {
  if (duplicates.length) {
    return `Duplicate player name: ${duplicates[0]}. Each player needs a unique name.`;
  }

  if (names.length < 4) {
    return "Add at least four players to run a 2v2 draw.";
  }

  if (names.length > MAX_PLAYERS) {
    return `Keep the roster to ${MAX_PLAYERS} players or fewer.`;
  }

  const longName = names.find((name) => name.length > 32);
  if (longName) {
    return `Player names must be 32 characters or fewer: ${longName}`;
  }

  return "";
}

function handleSetupSubmit(event) {
  event.preventDefault();

  if (ui.busy) {
    return;
  }

  const form = event.currentTarget;
  const setup = readSetupForm(form);
  const error = validateSetup(setup);

  if (error) {
    showFormError(error);
    return;
  }

  showFormError("");
  withBusy("Drawing your schedule", async () => {
    try {
      const players = setup.names.map((name, index) => ({
        id: `p${index + 1}`,
        name
      }));
      const schedule = generateSchedule(players, setup.games, {
        attempts: attemptCountFor(players.length)
      });
      const now = new Date().toISOString();
      const draft = {
        version: 1,
        id: cloud ? createShareId() : createId(),
        cloud: false,
        drawVersion: 1,
        name: setup.name,
        targetScore: setup.target === 10 ? 10 : 7,
        gamesPerPlayer: setup.games,
        players,
        rounds: schedule.rounds,
        createdAt: now,
        updatedAt: now
      };
      let savedOnline = false;
      let created = draft;

      if (cloud) {
        try {
          // Signed-in users own what they create. Scores start owner-only;
          // the owner can open them up from the tournament page.
          const stored = await cloud.createTournament({
            ...draft,
            editMode: user ? "owner" : undefined
          });
          // Keep the locally generated draw, take ownership fields from the server.
          created = {
            ...draft,
            cloud: true,
            owned: stored.owned,
            isOwner: stored.isOwner,
            ownerName: stored.ownerName,
            editMode: stored.editMode,
            createdAt: stored.createdAt || draft.createdAt,
            updatedAt: stored.updatedAt || draft.updatedAt
          };
          savedOnline = true;
          rememberTournament(created.id);
        } catch (cloudError) {
          showToast(
            "Could not reach the server. This tournament is saved on this device only.",
            "error"
          );
        }
      }

      tournament = created;
      ui.roundIndex = 0;
      ui.editingGameId = null;
      ui.setupDraft = null;
      persistTournament();
      if (savedOnline) {
        setSharedIdInUrl(tournament.id);
        setSyncStatus("live");
        startPolling();
      } else {
        setSyncStatus("local");
      }
      renderTournament();
      showToast(
        `Schedule ready: ${schedule.plan.rounds} rounds, ${schedule.plan.totalGames} matches. ${describeBalance(schedule.quality)}`
      );
    } catch (generationError) {
      showFormError(generationError.message);
    }
  });
}

function regenerateTournament() {
  if (!tournament || ui.busy) {
    return;
  }

  withBusy("Redrawing partners", async () => {
    try {
      const schedule = generateSchedule(tournament.players, tournament.gamesPerPlayer, {
        attempts: attemptCountFor(tournament.players.length)
      });

      if (tournament.cloud) {
        if (!cloud) {
          showToast("Live sync is offline, so the shared draw cannot be changed.", "error");
          return;
        }
        let replaced;
        try {
          replaced = await cloud.replaceDraw(
            tournament.id,
            tournament.drawVersion || 1,
            schedule.rounds
          );
        } catch (cloudError) {
          showToast("Could not reach the server. The draw was not changed.", "error");
          return;
        }
        if (!replaced) {
          showToast("Someone else redrew this tournament first. Loading their draw.", "error");
          await pollOnce({ force: true });
          return;
        }
        tournament.drawVersion = (tournament.drawVersion || 1) + 1;
        sync.pending.clear();
      }

      tournament.rounds = schedule.rounds;
      tournament.updatedAt = new Date().toISOString();
      ui.roundIndex = 0;
      ui.editingGameId = null;
      persistTournament();
      renderTournament();
      showToast(`New draw ready. All scores reset. ${describeBalance(schedule.quality)}`);
    } catch (generationError) {
      showToast(generationError.message, "error");
    }
  });
}

function describeBalance(quality) {
  const times = (summary) =>
    summary.min === summary.max
      ? `${summary.min}×`
      : `${summary.min}–${summary.max}×`;

  return `Each pair teams up ${times(quality.partner)} and faces off ${times(quality.opponent)}.`;
}

function attemptCountFor(playerCount) {
  if (playerCount <= 12) {
    return 16;
  }
  if (playerCount <= 20) {
    return 12;
  }
  if (playerCount <= 30) {
    return 8;
  }
  return 5;
}

function ensureTournamentState() {
  if (!tournament) {
    return;
  }

  ui.roundIndex = clamp(ui.roundIndex, 0, tournament.rounds.length - 1);
  const activeRound = tournament.rounds[ui.roundIndex];

  if (
    ui.editingGameId &&
    !activeRound.games.some((game) => game.id === ui.editingGameId)
  ) {
    ui.editingGameId = null;
  }
}

function persistTournament() {
  try {
    if (!tournament) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(tournament));
  } catch (error) {
    showToast("This browser could not save the tournament.", "error");
  }
}

function loadTournament() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return null;
    }

    const parsed = JSON.parse(stored);
    const valid =
      parsed &&
      parsed.version === 1 &&
      typeof parsed.name === "string" &&
      (parsed.targetScore === 7 || parsed.targetScore === 10) &&
      Number.isInteger(parsed.gamesPerPlayer) &&
      Array.isArray(parsed.players) &&
      parsed.players.length >= 4 &&
      Array.isArray(parsed.rounds) &&
      parsed.rounds.length > 0;

    return valid ? parsed : null;
  } catch (error) {
    return null;
  }
}

function saveGame(gameId, card) {
  if (!canScore()) {
    showGameError(card, `Only ${tournament.ownerName || "the owner"} can enter scores.`);
    return;
  }
  const round = tournament.rounds[ui.roundIndex];
  const game = round.games.find((item) => item.id === gameId);

  if (!game) {
    return;
  }

  const inputA = card.querySelector('[data-score="A"]');
  const inputB = card.querySelector('[data-score="B"]');
  const rawA = inputA.value.trim();
  const rawB = inputB.value.trim();

  if (!rawA || !rawB) {
    showGameError(card, "Enter a score for both teams.");
    return;
  }

  const scoreA = Number(rawA);
  const scoreB = Number(rawB);
  const validation = validateScore(scoreA, scoreB, tournament.targetScore);

  if (!validation.valid) {
    showGameError(card, validation.message);
    return;
  }

  const wasRoundComplete = isRoundComplete(round);
  game.scoreA = scoreA;
  game.scoreB = scoreB;
  tournament.updatedAt = new Date().toISOString();
  ui.editingGameId = null;
  sync.deferred = false;
  persistTournament();
  if (tournament.cloud) {
    queueResult(game);
  }
  renderTournament();

  const nowComplete = isRoundComplete(round);
  const progress = getProgress(tournament.rounds);

  if (progress.complete) {
    const standings = computeStandings(tournament.players, tournament.rounds);
    showToast(`${standings[0].name} wins the tournament.`);
  } else if (!wasRoundComplete && nowComplete) {
    showToast(`Round ${round.number} complete.`);
  } else {
    showToast("Result saved.");
  }
}

function showGameError(card, message) {
  const error = card.querySelector(".game-error");
  if (!error) {
    return;
  }

  error.textContent = message;
  error.hidden = false;
  card.querySelectorAll(".score-input").forEach((input) => {
    input.classList.add("has-error");
  });
}

function clearGameError(card) {
  const error = card.querySelector(".game-error");
  if (error) {
    error.hidden = true;
    error.textContent = "";
  }

  card.querySelectorAll(".score-input").forEach((input) => {
    input.classList.remove("has-error");
  });
}

function showFormError(message) {
  const error = document.querySelector("#setup-error");
  if (!error) {
    return;
  }

  error.textContent = message;
  error.hidden = !message;
}

function selectRound(index) {
  const nextIndex = clamp(index, 0, tournament.rounds.length - 1);

  if (nextIndex === ui.roundIndex && !ui.editingGameId) {
    return;
  }

  ui.roundIndex = nextIndex;
  ui.editingGameId = null;
  renderTournament();
}

function openNewTournamentDialog() {
  if (!tournament) {
    return;
  }

  const progress = getProgress(tournament.rounds);
  openDialog({
    eyebrow: "Start fresh",
    title: "Start a new tournament?",
    body: `
      <p>
        ${
          progress.completed
            ? tournament.cloud
              ? "This tournament stays saved online. You can reopen it any time from its link or the recent list."
              : `This draw has ${progress.completed} saved ${progress.completed === 1 ? "result" : "results"}. Starting fresh will erase the schedule and every score.`
            : tournament.cloud
              ? "This tournament stays saved online and can be reopened from its link."
              : "The current draw will be replaced with a new setup."
        }
      </p>
      <p class="dialog-muted">Your current player list will be kept in the setup form for a quick rematch.</p>
    `,
    actions: [
      { label: "Keep playing", action: "close-dialog", variant: "ghost" },
      {
        label: "Start new",
        action: "confirm-new-tournament",
        variant: "danger"
      }
    ]
  });
}

function confirmNewTournament() {
  const previous = tournament;

  stopPolling();
  sync.pending.clear();
  sync.deferred = false;
  setSharedIdInUrl(null);
  tournament = null;
  ui = {
    roundIndex: 0,
    editingGameId: null,
    setupDraft: previous
      ? {
          name: "",
          players: previous.players.map((player) => player.name).join("\n"),
          games: previous.gamesPerPlayer,
          target: previous.targetScore
        }
      : null,
    busy: false
  };
  persistTournament();
  closeDialog();
  renderSetup();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function requestRegenerate() {
  if (!tournament || ui.busy) {
    return;
  }
  if (!canRedraw()) {
    showToast(`Only ${tournament.ownerName || "the owner"} can regenerate this draw.`, "error");
    return;
  }

  const progress = getProgress(tournament.rounds);

  if (!progress.completed) {
    regenerateTournament();
    return;
  }

  openDialog({
    eyebrow: "New draw",
    title: "Reshuffle the schedule?",
    body: `
      <p>Regenerating creates new partners and opponents, but it also clears all ${progress.completed} saved ${progress.completed === 1 ? "result" : "results"}.</p>
      <p class="dialog-muted">The tournament name, players and scoring settings stay the same.</p>
    `,
    actions: [
      { label: "Keep this draw", action: "close-dialog", variant: "ghost" },
      {
        label: "Reshuffle & reset",
        action: "confirm-regenerate",
        variant: "danger"
      }
    ]
  });
}

function showRulesDialog() {
  openDialog({
    eyebrow: "Tournament guide",
    title: "Draw Your Partner, made simple.",
    body: `
      <div class="rule-list">
        <div class="rule-item">
          <span class="rule-number">01</span>
          <div><strong>Four players per match.</strong><p>Every game is 2v2. The scheduler fills as many matches as your roster allows, and nobody plays twice in the same round.</p></div>
        </div>
        <div class="rule-item">
          <span class="rule-number">02</span>
          <div><strong>Fewest possible rounds.</strong><p>The round count is calculated from the roster and games-per-player target. It is the mathematical minimum for those settings.</p></div>
        </div>
        <div class="rule-item">
          <span class="rule-number">03</span>
          <div><strong>Fresh partners, fair byes.</strong><p>Partners and opponents are mixed. When the roster does not divide into fours, byes rotate and up to three players receive one extra match.</p></div>
        </div>
        <div class="rule-item">
          <span class="rule-number">04</span>
          <div><strong>One point per win.</strong><p>Scores run to ${tournament ? tournament.targetScore : "7 or 10"}. Every player tracks wins, goals for, goals against and goal difference.</p></div>
        </div>
        <div class="rule-item">
          <span class="rule-number">05</span>
          <div><strong>Clear tiebreakers.</strong><p>Standings sort by points, then goal difference, then goals scored. If some players have an extra game, the table ranks by win rate, then goal difference per game, so the extra match is no advantage.</p></div>
        </div>
      </div>
    `,
    actions: [{ label: "Got it", action: "close-dialog", variant: "primary" }]
  });
}

function exportStandings() {
  if (!tournament) {
    return;
  }

  const standings = computeStandings(tournament.players, tournament.rounds);
  const rows = [
    [
      "Rank",
      "Player",
      "Played",
      "Wins",
      "Losses",
      "Goals For",
      "Goals Against",
      "Goal Difference",
      "Points",
      "Win Rate"
    ],
    ...standings.map((player) => [
      player.rank,
      player.name,
      player.played,
      player.wins,
      player.losses,
      player.goalsFor,
      player.goalsAgainst,
      player.goalDifference,
      player.points,
      formatRate(player.winRate, player.played)
    ])
  ];
  const csv = rows
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
  const blob = new Blob([`\ufeff${csv}`], {
    type: "text/csv;charset=utf-8"
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = `${slugify(tournament.name)}-standings.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast("Standings exported as CSV.");
}

function openDialog({ eyebrow, title, body, actions }) {
  const dialog = document.createElement("dialog");
  dialog.className = "app-dialog";
  dialog.setAttribute("aria-labelledby", "dialog-title");
  dialog.innerHTML = `
    <div class="dialog-inner">
      <button class="dialog-close" type="button" data-action="close-dialog" aria-label="Close dialog">
        ${icon("close")}
      </button>
      <span class="eyebrow">${escapeHtml(eyebrow)}</span>
      <h2 id="dialog-title">${escapeHtml(title)}</h2>
      <div class="dialog-body">${body}</div>
      <div class="dialog-actions">
        ${actions
          .map(
            (action) => `
              <button
                class="button ${action.variant || "ghost"} compact"
                type="button"
                data-action="${action.action}"
              >${escapeHtml(action.label)}</button>
            `
          )
          .join("")}
      </div>
    </div>
  `;

  modalRoot.innerHTML = "";
  modalRoot.appendChild(dialog);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      closeDialog();
    }
  });
  dialog.addEventListener("close", () => {
    if (modalRoot.contains(dialog)) {
      modalRoot.innerHTML = "";
    }
  });
  dialog.showModal();
}

function closeDialog() {
  const dialog = modalRoot.querySelector("dialog");
  if (dialog) {
    dialog.close();
  }
}

function showBusy(message) {
  ui.busy = true;
  const overlay = document.createElement("div");
  overlay.className = "busy-overlay";
  overlay.innerHTML = `
    <div class="busy-card">
      <span class="busy-spinner" aria-hidden="true">${icon("ball")}</span>
      <strong>${escapeHtml(message)}</strong>
      <span>Balancing partners and rounds...</span>
    </div>
  `;
  document.body.appendChild(overlay);
  return overlay;
}

function withBusy(message, task) {
  const overlay = showBusy(message);

  requestAnimationFrame(() => {
    setTimeout(async () => {
      try {
        await task();
      } finally {
        overlay.remove();
        ui.busy = false;
      }
    }, 40);
  });
}

function showToast(message, type = "success") {
  const toast = document.createElement("div");
  toast.className = `toast ${type === "error" ? "is-error" : ""}`;
  toast.innerHTML = `
    <span class="toast-icon">${icon(type === "error" ? "info" : "check")}</span>
    <span>${escapeHtml(message)}</span>
  `;
  toastRoot.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add("is-visible");
  });

  setTimeout(() => {
    toast.classList.remove("is-visible");
    setTimeout(() => toast.remove(), 220);
  }, 3400);
}

async function boot() {
  const sharedId = readSharedIdFromUrl();

  if (sharedId) {
    renderLoading("Opening tournament");
  } else {
    showInitialView();
  }

  const config = await loadCloudConfig();
  let returnUrl = null;

  if (config) {
    try {
      returnUrl = await initAuth(config);
      authAvailable = true;
      user = currentUser();
      onUserChange(handleUserChange);
    } catch {
      // Sign-in unavailable; guests can still use everything.
      authAvailable = false;
    }
  }
  cloud = config ? createCloudClient(config, undefined, authAvailable ? getAccessToken : undefined) : null;

  // Came back from Google: restore the page the user signed in from.
  if (returnUrl) {
    const restoredId = readSharedIdFromUrl();
    if (restoredId) {
      renderLoading("Opening tournament");
      await openSharedTournament(restoredId);
      if (user) showToast(`Signed in as ${user.name}.`);
      return;
    }
    // Keep whatever was typed into the setup form before signing in.
    const savedDraft = takeSavedDraft();
    if (savedDraft) {
      ui.setupDraft = savedDraft;
    }
  }

  if (sharedId && !returnUrl) {
    if (!cloud) {
      setSharedIdInUrl(null);
      showInitialView();
      showToast("Live sync is not set up here, so shared links cannot be opened.", "error");
      return;
    }
    await openSharedTournament(sharedId);
    return;
  }

  if (tournament?.cloud) {
    // Re-render so the header shows the signed-in user and permissions.
    renderTournament();
    resumeCachedCloudTournament();
    if (returnUrl && user) showToast(`Signed in as ${user.name}.`);
    return;
  }

  if (tournament) {
    renderTournament();
  } else {
    renderSetup();
  }
  if (returnUrl && user) showToast(`Signed in as ${user.name}.`);
}

function resumeCachedCloudTournament() {
  if (!tournament?.cloud) {
    return;
  }
  setSharedIdInUrl(tournament.id);
  if (!cloud) {
    setSyncStatus("offline");
    return;
  }
  setSyncStatus("connecting");
  startPolling();
  pollOnce({ force: true });
}

function showInitialView() {
  if (tournament) {
    ui.roundIndex = firstOpenRoundIndex(tournament);
    setSyncStatus(tournament.cloud ? "connecting" : "local");
    renderTournament();
  } else {
    renderSetup();
  }
}

function firstOpenRoundIndex(current) {
  const firstOpen = current.rounds.findIndex((round) => !isRoundComplete(round));
  return firstOpen === -1 ? 0 : firstOpen;
}

async function openSharedTournament(id) {
  const cached = tournament && tournament.id === id ? tournament : null;
  let remote = null;

  try {
    remote = await cloud.fetchTournament(id);
  } catch (error) {
    if (cached) {
      tournament = cached;
      ui.roundIndex = firstOpenRoundIndex(tournament);
      setSyncStatus("offline");
      renderTournament();
      startPolling();
      showToast("Could not reach the server. Showing the last saved copy.", "error");
      return;
    }
    setSharedIdInUrl(null);
    showInitialView();
    resumeCachedCloudTournament();
    showToast("Could not reach the server to open that tournament.", "error");
    return;
  }

  if (!remote) {
    setSharedIdInUrl(null);
    showInitialView();
    resumeCachedCloudTournament();
    showToast("That tournament link does not exist.", "error");
    return;
  }

  backupLocalOnlyTournament();
  rememberTournament(remote.id);
  tournament = remote;
  ui.roundIndex = firstOpenRoundIndex(tournament);
  ui.editingGameId = null;
  ui.setupDraft = null;
  persistTournament();
  setSyncStatus("live");
  renderTournament();
  startPolling();
}

// Opening someone's link replaces the cached tournament. Keep a local-only
// one so it is not silently lost.
function backupLocalOnlyTournament() {
  if (!tournament || tournament.cloud) {
    return;
  }
  try {
    localStorage.setItem(LOCAL_BACKUP_KEY, JSON.stringify(tournament));
  } catch {
    // storage full or blocked; nothing else to do
  }
}

function startPolling() {
  stopPolling();
  sync.timer = setInterval(() => {
    pollOnce();
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (sync.timer) {
    clearInterval(sync.timer);
    sync.timer = null;
  }
}

async function pollOnce({ force = false } = {}) {
  if (!cloud || !tournament?.cloud || sync.inFlight) {
    return;
  }
  if (!force && document.hidden) {
    return;
  }

  sync.inFlight = true;
  const id = tournament.id;

  try {
    await flushPendingResults();
    const remote = await cloud.fetchTournament(id);
    if (!tournament || tournament.id !== id) {
      return;
    }
    if (!remote) {
      setSyncStatus("offline");
      return;
    }
    setSyncStatus(sync.pending.size ? "offline" : "live");
    applyRemoteTournament(remote);
  } catch (error) {
    setSyncStatus("offline");
  } finally {
    sync.inFlight = false;
  }
}

function applyRemoteTournament(remote) {
  // Scores saved here but not yet confirmed by the server win over the
  // server copy, so a slow upload does not flicker back to empty.
  for (const pending of sync.pending.values()) {
    if (pending.tournamentId !== remote.id || pending.drawVersion !== remote.drawVersion) {
      continue;
    }
    for (const round of remote.rounds) {
      const game = round.games.find((item) => item.id === pending.gameId);
      if (game) {
        game.scoreA = pending.scoreA;
        game.scoreB = pending.scoreB;
      }
    }
  }

  const drawChanged = (remote.drawVersion || 1) !== (tournament.drawVersion || 1);
  const changed = tournamentSignature(remote) !== tournamentSignature(tournament);

  if (!changed && !sync.deferred) {
    return;
  }

  tournament = remote;
  persistTournament();

  if (drawChanged) {
    // Game ids repeat between draws, so an open score form would point at a
    // different match. Re-render right away.
    sync.pending.clear();
    ui.editingGameId = null;
    sync.deferred = false;
    ui.roundIndex = firstOpenRoundIndex(tournament);
    renderTournament();
    showToast("The draw was regenerated on another device. Scores were reset.");
    return;
  }

  if (isUserTyping()) {
    sync.deferred = true;
    return;
  }

  sync.deferred = false;
  const scrollY = window.scrollY;
  renderTournament();
  window.scrollTo(0, scrollY);
}

function isUserTyping() {
  if (ui.busy || ui.editingGameId) {
    return true;
  }
  return [...document.querySelectorAll(".score-input")].some(
    (input) => input === document.activeElement || input.value !== input.defaultValue
  );
}

function queueResult(game) {
  const key = `${tournament.id}:${game.id}`;
  sync.pending.set(key, {
    tournamentId: tournament.id,
    drawVersion: tournament.drawVersion || 1,
    gameId: game.id,
    scoreA: game.scoreA,
    scoreB: game.scoreB
  });
  updateSyncPill();
  flushPendingResults();
}

async function flushPendingResults() {
  if (!cloud) {
    return;
  }

  for (const [key, pending] of [...sync.pending]) {
    const stale =
      !tournament ||
      pending.tournamentId !== tournament.id ||
      pending.drawVersion !== (tournament.drawVersion || 1);
    if (stale) {
      sync.pending.delete(key);
      continue;
    }

    try {
      await cloud.saveResult(
        pending.tournamentId,
        pending.drawVersion,
        pending.gameId,
        pending.scoreA,
        pending.scoreB
      );
      if (sync.pending.get(key) === pending) {
        sync.pending.delete(key);
      }
      setSyncStatus(sync.pending.size ? "offline" : "live");
    } catch (error) {
      const rejected = error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
      if (rejected) {
        sync.pending.delete(key);
        const locked = error.status === 401 || error.status === 403;
        showToast(
          locked
            ? "That score was not saved: scoring is now limited to the owner."
            : `The server rejected a score: ${error.message}`,
          "error"
        );
        setTimeout(() => pollOnce({ force: true }), 0);
        continue;
      }
      setSyncStatus("offline");
      break;
    }
  }
  updateSyncPill();
}

function setSyncStatus(status) {
  sync.status = status;
  updateSyncPill();
}

function syncPillMarkup() {
  return `<span id="sync-pill" class="sync-pill is-${tournament?.cloud ? sync.status : "local"}" role="status">${syncPillLabel()}</span>`;
}

function syncPillLabel() {
  if (!tournament?.cloud) {
    return "This device only";
  }
  const unsaved = sync.pending.size;
  if (sync.status === "live" && !unsaved) {
    return "Live";
  }
  if (sync.status === "connecting") {
    return "Connecting";
  }
  return unsaved ? `Offline · ${unsaved} unsaved` : "Offline · retrying";
}

function updateSyncPill() {
  const pill = document.querySelector("#sync-pill");
  if (!pill) {
    return;
  }
  const status = tournament?.cloud ? sync.status : "local";
  pill.className = `sync-pill is-${status === "live" && sync.pending.size ? "offline" : status}`;
  pill.textContent = syncPillLabel();
}

function shareUrl(id) {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("t", id);
  return url.toString();
}

async function copyShareLink() {
  if (!tournament?.cloud) {
    return;
  }
  const link = shareUrl(tournament.id);
  try {
    await navigator.clipboard.writeText(link);
    showToast("Link copied. Anyone with it can follow and enter scores.");
  } catch {
    window.prompt("Copy this tournament link", link);
  }
}

function readSharedIdFromUrl() {
  const id = new URLSearchParams(window.location.search).get("t");
  return id && SHARE_ID_PATTERN.test(id) ? id : null;
}

function setSharedIdInUrl(id) {
  const url = new URL(window.location.href);
  if (id) {
    url.searchParams.set("t", id);
  } else {
    url.searchParams.delete("t");
  }
  window.history.replaceState(null, "", url);
}

async function loadRecentLists() {
  const history = readHistory();
  const [owned, openedAll] = await Promise.all([
    user ? cloud.listOwnedTournaments(20) : [],
    history.length ? cloud.listTournamentsById(history) : []
  ]);
  const ownedIds = new Set(owned.map((row) => row.id));
  const opened = openedAll.filter((row) => !ownedIds.has(row.id)).slice(0, 10);
  return { owned, opened };
}

function recentListsMarkup({ owned, opened }, { currentId = null } = {}) {
  const dateFormat = new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  });
  const listMarkup = (rows) => `
    <ul class="recent-list">
      ${rows
        .map(
          (row) => `
            <li>
              <a class="recent-item ${row.id === currentId ? "is-current" : ""}" href="${escapeHtml(shareUrl(row.id))}">
                <strong>${escapeHtml(row.name)}</strong>
                <span>${row.playerCount} players · ${row.games_per_player} games · ${escapeHtml(dateFormat.format(new Date(row.created_at)))}${row.id === currentId ? " · open now" : ""}</span>
                ${icon("chevronRight")}
              </a>
            </li>
          `
        )
        .join("")}
    </ul>
  `;
  return `
    ${
      owned.length
        ? `<div class="recent-head">
            <span class="eyebrow">Your tournaments</span>
            <small>Created while signed in</small>
          </div>
          ${listMarkup(owned)}`
        : ""
    }
    ${
      opened.length
        ? `<div class="recent-head ${owned.length ? "is-spaced" : ""}">
            <span class="eyebrow">Recently opened</span>
            <small>On this device</small>
          </div>
          ${listMarkup(opened)}`
        : ""
    }
  `;
}

async function refreshRecentTournaments() {
  const container = document.querySelector("#recent-tournaments");
  if (!container || !cloud) {
    return;
  }
  let lists;
  try {
    lists = await loadRecentLists();
  } catch {
    return;
  }
  // The setup page may have been replaced while the request was running.
  if (!document.body.contains(container)) {
    return;
  }
  if (!lists.owned.length && !lists.opened.length) {
    container.hidden = true;
    container.innerHTML = "";
    return;
  }
  container.innerHTML = recentListsMarkup(lists);
  container.hidden = false;
}

async function openTournamentsDialog() {
  if (!cloud) {
    return;
  }
  openDialog({
    eyebrow: user ? `Signed in as ${user.name}` : "This device",
    title: user ? "My tournaments" : "Recent tournaments",
    body: `<div id="tournaments-dialog-list" class="dialog-list"><p class="dialog-muted">Loading...</p></div>`,
    actions: [{ label: "Close", action: "close-dialog", variant: "ghost" }]
  });
  const target = () => document.querySelector("#tournaments-dialog-list");
  try {
    const lists = await loadRecentLists();
    if (!target()) {
      return;
    }
    target().innerHTML =
      lists.owned.length || lists.opened.length
        ? recentListsMarkup(lists, { currentId: tournament?.id })
        : `<p class="dialog-muted">${
            user
              ? "You have not created any tournaments while signed in yet."
              : "No tournaments opened on this device yet."
          }</p>`;
  } catch {
    if (target()) {
      target().innerHTML = `<p class="dialog-muted">Could not load tournaments. Check your connection and try again.</p>`;
    }
  }
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    pollOnce();
  }
});

document.addEventListener("focusout", () => {
  // A remote update arrived while someone was typing. Apply it once they
  // leave the score fields without unsaved input.
  setTimeout(() => {
    if (sync.deferred && tournament && !isUserTyping()) {
      sync.deferred = false;
      renderTournament();
    }
  }, 0);
});

function createId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function initialsForName(name) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return "?";
  }
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }
  return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
}

function hueForName(name) {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) % 360;
  }
  return hash;
}

function formatRate(rate, played) {
  return played ? `${Math.round(rate * 100)}%` : "–";
}

function formatDifference(value) {
  return value > 0 ? `+${value}` : String(value);
}

function differenceClass(value) {
  return value > 0 ? "is-positive" : value < 0 ? "is-negative" : "";
}

function csvCell(value) {
  let text = String(value ?? "");

  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }

  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function slugify(value) {
  return (
    value
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "foosball-tournament"
  );
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

document.addEventListener("submit", (event) => {
  if (event.target.matches("#setup-form")) {
    handleSetupSubmit(event);
  }
});

document.addEventListener("input", (event) => {
  if (
    event.target.matches("#players-input") ||
    event.target.matches("#games-input")
  ) {
    updateSetupPreview();
  }

  if (event.target.matches(".score-input")) {
    const card = event.target.closest(".game-card");
    if (card) {
      clearGameError(card);
    }
  }
});

document.addEventListener("change", (event) => {
  if (event.target.matches('input[name="target"]')) {
    updateSetupPreview();
  }
});

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button || button.disabled) {
    return;
  }

  const action = button.dataset.action;

  if (action === "step-games") {
    const input = document.querySelector("#games-input");
    if (!input) {
      return;
    }
    const step = Number(button.dataset.step) || 0;
    const next = clamp(
      (Math.floor(Number(input.value) || 1) || 1) + step,
      1,
      MAX_GAMES_PER_PLAYER
    );
    input.value = String(next);
    updateSetupPreview();
    return;
  }

  if (action === "set-games") {
    const input = document.querySelector("#games-input");
    if (input) {
      input.value = button.dataset.games;
      updateSetupPreview();
    }
    return;
  }

  if (action === "my-tournaments") {
    openTournamentsDialog();
    return;
  }

  if (action === "sign-in") {
    startSignIn();
    return;
  }

  if (action === "sign-out") {
    handleSignOut();
    return;
  }

  if (action === "set-edit-mode") {
    changeEditMode(button.dataset.mode === "owner" ? "owner" : "anyone");
    return;
  }

  if (action === "copy-link") {
    copyShareLink();
    return;
  }

  if (action === "show-rules") {
    showRulesDialog();
    return;
  }

  if (action === "close-dialog") {
    closeDialog();
    return;
  }

  if (action === "new-tournament") {
    openNewTournamentDialog();
    return;
  }

  if (action === "confirm-new-tournament") {
    confirmNewTournament();
    return;
  }

  if (action === "regenerate") {
    requestRegenerate();
    return;
  }

  if (action === "confirm-regenerate") {
    closeDialog();
    regenerateTournament();
    return;
  }

  if (action === "export-csv") {
    exportStandings();
    return;
  }

  if (action === "select-round") {
    selectRound(Number(button.dataset.index));
    return;
  }

  if (action === "prev-round") {
    selectRound(ui.roundIndex - 1);
    return;
  }

  if (action === "next-round") {
    selectRound(ui.roundIndex + 1);
    return;
  }

  if (action === "edit-game") {
    const card = button.closest(".game-card");
    if (!card) {
      return;
    }
    ui.editingGameId = card.dataset.gameId;
    renderTournament();
    requestAnimationFrame(() => {
      document
        .querySelector(
          `[data-game-id="${CSS.escape(ui.editingGameId)}"] [data-score="A"]`
        )
        ?.focus();
    });
    return;
  }

  if (action === "cancel-edit") {
    ui.editingGameId = null;
    sync.deferred = false;
    renderTournament();
    return;
  }

  if (action === "save-game") {
    const card = button.closest(".game-card");
    if (card) {
      saveGame(card.dataset.gameId, card);
    }
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || !event.target.matches(".score-input")) {
    return;
  }

  event.preventDefault();
  const card = event.target.closest(".game-card");
  card?.querySelector('[data-action="save-game"]')?.click();
});
