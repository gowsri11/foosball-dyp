// Google sign-in through Supabase Auth. The supabase-js browser bundle is
// vendored in js/vendor and only loaded when cloud sync is configured.

const SUPABASE_BUNDLE = "js/vendor/supabase-2.119.0.js";
const RETURN_KEY = "foosball-dyp.auth-return";
const DRAFT_KEY = "foosball-dyp.auth-draft";

let client = null;
let currentSession = null;
const listeners = new Set();

function loadBundle() {
  if (globalThis.supabase?.createClient) {
    return Promise.resolve(globalThis.supabase);
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SUPABASE_BUNDLE;
    script.onload = () =>
      globalThis.supabase?.createClient
        ? resolve(globalThis.supabase)
        : reject(new Error("Sign-in library failed to load."));
    script.onerror = () => reject(new Error("Sign-in library failed to load."));
    document.head.appendChild(script);
  });
}

/**
 * Sets up auth, finishes a sign-in redirect if one is in progress, and
 * returns the URL the user was on before they went to Google (or null).
 */
export async function initAuth(config) {
  const { createClient } = await loadBundle();
  client = createClient(config.url, config.key, {
    auth: {
      flowType: "pkce",
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  });

  // getSession waits for the ?code= exchange after a Google redirect.
  const { data } = await client.auth.getSession();
  currentSession = data.session;

  client.auth.onAuthStateChange((event, session) => {
    const before = currentSession?.user?.id || null;
    currentSession = session;
    const after = session?.user?.id || null;
    if (before !== after) {
      for (const listener of listeners) {
        listener(currentUser());
      }
    }
  });

  return consumeReturnUrl();
}

function consumeReturnUrl() {
  const url = new URL(window.location.href);
  const hadAuthParams = url.searchParams.has("code") || url.searchParams.has("error");
  let target = null;

  try {
    target = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
  } catch {
    target = null;
  }

  if (target) {
    const parsed = new URL(target, window.location.origin);
    // Only ever return to this site.
    if (parsed.origin === window.location.origin) {
      window.history.replaceState(null, "", parsed.pathname + parsed.search);
      return parsed.toString();
    }
  }

  if (hadAuthParams) {
    for (const key of ["code", "error", "error_code", "error_description", "state"]) {
      url.searchParams.delete(key);
    }
    window.history.replaceState(null, "", url.pathname + url.search);
  }
  return null;
}

export function authReady() {
  return client !== null;
}

export function currentUser() {
  const user = currentSession?.user;
  if (!user) {
    return null;
  }
  const meta = user.user_metadata || {};
  return {
    id: user.id,
    name: meta.full_name || meta.name || (user.email || "").split("@")[0] || "You",
    email: user.email || "",
    avatarUrl: typeof meta.avatar_url === "string" ? meta.avatar_url : ""
  };
}

export async function getAccessToken() {
  if (!client) {
    return null;
  }
  // getSession refreshes an expired token before returning it.
  const { data } = await client.auth.getSession();
  return data.session?.access_token || null;
}

export function onUserChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Sends the user to Google, then back to the page they were on. */
export async function signInWithGoogle(setupDraft) {
  if (!client) {
    throw new Error("Sign-in is not available.");
  }
  try {
    sessionStorage.setItem(RETURN_KEY, window.location.pathname + window.location.search);
    if (setupDraft) {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(setupDraft));
    }
  } catch {
    // sessionStorage blocked; the user just lands on the home page
  }
  const { error } = await client.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${window.location.origin}/` }
  });
  if (error) {
    throw error;
  }
}

export async function signOut() {
  if (client) {
    await client.auth.signOut();
  }
}

/** The setup form the user had filled in before signing in, if any. */
export function takeSavedDraft() {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    sessionStorage.removeItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
