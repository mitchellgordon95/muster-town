/**
 * Sign-in state for the web client: signed in (bearer token or GitHub session cookie) or a read-only guest.
 * Guests read everything public (town, boards, docs, meetings, library) and walk a local-only ghost; anything that
 * writes shows a sign-in prompt instead.
 */
import { useSyncExternalStore } from "react";
import type { AuthConfig } from "@muster-town/schema";
import { isMock, tokenStore } from "../api";

export interface AuthState {
  /** no token and no session: read-only */
  guest: boolean;
  /** the server offers "Sign in with GitHub" */
  github: boolean;
  /** signed in via the GitHub session cookie (sign out = POST /auth/logout) */
  session: boolean;
}

let state: AuthState = { guest: false, github: false, session: false };
const subs = new Set<() => void>();
export const authStore = {
  get: () => state,
  set(p: Partial<AuthState>) { state = { ...state, ...p }; subs.forEach((f) => f()); },
  subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
};
export const useAuth = () => useSyncExternalStore(authStore.subscribe, authStore.get);

/** `GET /api/auth/config` (the mock pretends GitHub is configured so the button shows). */
export async function loadAuthConfig(): Promise<AuthConfig | null> {
  if (isMock) return { githubClientId: "mock", publicUrl: location.origin };
  try {
    const r = await fetch("/api/auth/config");
    return r.ok ? ((await r.json()) as AuthConfig) : null;
  } catch { return null; }
}

/** `?guest` in the URL skips the dev admin token so guest mode can be seen in dev. */
export const forceGuest = () => new URLSearchParams(location.search).has("guest");

/** One-time `?auth_error=` from a failed GitHub callback (removed from the address bar). */
export function takeAuthError(): string | null {
  const u = new URL(location.href);
  const e = u.searchParams.get("auth_error");
  if (e === null) return null;
  u.searchParams.delete("auth_error");
  history.replaceState(null, "", u.pathname + u.search + u.hash);
  return e || "GitHub sign-in failed.";
}

export function signInWithGithub() { if (!isMock) location.href = "/auth/github"; }

export async function signOut() {
  tokenStore.set(null);
  if (!isMock) await fetch("/auth/logout", { method: "POST" }).catch(() => undefined);
  location.href = `${import.meta.env.BASE_URL}?guest`;
}

/** Sign-in buttons: GitHub when the server offers it, else paste a token (dev). */
export function SignInButtons({ onPasteToken, compact }: { onPasteToken?: () => void; compact?: boolean }) {
  const a = useAuth();
  return (
    <div className={`signin ${compact ? "compact" : ""}`}>
      {a.github ? <button className="btn primary" onClick={signInWithGithub}>Sign in with GitHub</button> : null}
      {onPasteToken && (!a.github || !compact) ? <button className={`btn ${a.github ? "" : "primary"}`} onClick={onPasteToken}>Paste a token</button> : null}
    </div>
  );
}

/** Shown in place of a write action for guests: "Sign in to talk". */
export function SignInNote({ to }: { to: string }) {
  const a = useAuth();
  return (
    <div className="signin-note">
      <span>Sign in to {to}.</span>
      {a.github ? <button className="btn sm primary" onClick={signInWithGithub}>Sign in with GitHub</button> : <span className="muted">Paste a token from the town card.</span>}
    </div>
  );
}
