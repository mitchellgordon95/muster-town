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

/** `<dataDir>/session-secret`, created once (mode 600) when `AGENT_TOWN_SESSION_SECRET` is unset. */
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
 * Env: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, AGENT_TOWN_PUBLIC_URL (default http://localhost:<port>),
 * AGENT_TOWN_ADMINS (comma-separated GitHub logins), AGENT_TOWN_SESSION_SECRET (default: <dataDir>/session-secret).
 */
export function loadAuthSettings(o: { env?: NodeJS.ProcessEnv; dataDir: string; port: number }): AuthSettings {
  const env = o.env ?? process.env;
  const id = env.GITHUB_CLIENT_ID?.trim() || null;
  const secret = env.GITHUB_CLIENT_SECRET?.trim() || null;
  return defaultAuthSettings({
    githubClientId: id && secret ? id : null,
    githubClientSecret: secret,
    publicUrl: (env.AGENT_TOWN_PUBLIC_URL?.trim() || `http://localhost:${o.port}`).replace(/\/+$/, ""),
    admins: (env.AGENT_TOWN_ADMINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    sessionSecret: env.AGENT_TOWN_SESSION_SECRET?.trim() || sessionSecretFile(o.dataDir),
  });
}
