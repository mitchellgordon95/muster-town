import { townEnv } from "@muster-town/schema";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Sign-in settings for one collective (from its `.env`). */
export interface AuthSettings {
  /** GitHub OAuth app client id; null = GitHub login not offered */
  githubClientId: string | null;
  githubClientSecret: string | null;
  /** where browsers reach this server; the OAuth callback is `<publicUrl>/auth/github/callback` */
  publicUrl: string;
  /** GitHub logins that get the town `admin` role on sign-in (case-insensitive) */
  admins: string[];
  /** HMAC key for session and OAuth-state cookies */
  sessionSecret: string;
  /** injectable for tests */
  fetch: typeof fetch;
  githubUrl: string;
  githubApiUrl: string;
  /**
   * A hosted collective's app (docs/hosted-collectives.md step 2): it shares the root's session cookie and secret,
   * resolves the cookie's GitHub identity against its own World (a user row on first visit), sends `/auth/github` to
   * the root's flow with a return-to of `/<slug>/`, and makes `ownerGithubId` its admin. Unset at the root.
   */
  hosted?: { slug: string; ownerGithubId: string | null } | null;
}

export const GITHUB_URL = "https://github.com";
export const GITHUB_API_URL = "https://api.github.com";

export function defaultAuthSettings(over: Partial<AuthSettings> = {}): AuthSettings {
  return {
    githubClientId: null, githubClientSecret: null, publicUrl: "http://localhost", admins: [],
    sessionSecret: randomBytes(32).toString("hex"), fetch: globalThis.fetch.bind(globalThis),
    githubUrl: GITHUB_URL, githubApiUrl: GITHUB_API_URL, ...over,
  };
}

/** `<dataDir>/session-secret`, created once (mode 600) when `MUSTER_TOWN_SESSION_SECRET` (or the old `AGENT_TOWN_SESSION_SECRET`) is unset. */
export function sessionSecretFile(dataDir: string): string {
  const path = join(dataDir, "session-secret");
  if (existsSync(path)) {
    const s = readFileSync(path, "utf8").trim();
    if (s) return s;
  }
  mkdirSync(dataDir, { recursive: true });
  const s = randomBytes(32).toString("hex");
  writeFileSync(path, s + "\n", { mode: 0o600 });
  return s;
}

/**
 * Env: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, MUSTER_TOWN_PUBLIC_URL (default http://localhost:<port>),
 * MUSTER_TOWN_ADMINS (comma-separated GitHub logins), MUSTER_TOWN_SESSION_SECRET (default: <dataDir>/session-secret).
 * Each MUSTER_TOWN_<X> falls back to AGENT_TOWN_<X>.
 */
export function loadAuthSettings(o: { env?: NodeJS.ProcessEnv; dataDir: string; port: number }): AuthSettings {
  const env = o.env ?? process.env;
  const id = env.GITHUB_CLIENT_ID?.trim() || null;
  const secret = env.GITHUB_CLIENT_SECRET?.trim() || null;
  return defaultAuthSettings({
    githubClientId: id && secret ? id : null,
    githubClientSecret: secret,
    publicUrl: (townEnv("PUBLIC_URL", env)?.trim() || `http://localhost:${o.port}`).replace(/\/+$/, ""),
    admins: (townEnv("ADMINS", env) ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    sessionSecret: townEnv("SESSION_SECRET", env)?.trim() || sessionSecretFile(o.dataDir),
  });
}
