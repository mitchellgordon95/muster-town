import { AppError, type GithubProfile } from "@agent-town/core";
import type { AuthSettings } from "./config.ts";

export function authorizeUrl(s: AuthSettings, state: string): string {
  const q = new URLSearchParams({ client_id: s.githubClientId!, redirect_uri: `${s.publicUrl}/auth/github/callback`, scope: "read:user", state, allow_signup: "true" });
  return `${s.githubUrl}/login/oauth/authorize?${q}`;
}

/** Web flow step 2: the `code` from the callback → a GitHub access token (used once, never stored). */
export async function exchangeCode(s: AuthSettings, code: string): Promise<string> {
  const res = await s.fetch(`${s.githubUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: s.githubClientId, client_secret: s.githubClientSecret, code, redirect_uri: `${s.publicUrl}/auth/github/callback` }),
  });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !j.access_token) throw new AppError("unauthorized", `GitHub sign-in failed: ${j.error_description ?? j.error ?? res.status}`);
  return j.access_token;
}

/** `GET /user` with the token: proves who the caller is on GitHub. */
export async function fetchGithubUser(s: AuthSettings, accessToken: string): Promise<GithubProfile> {
  const res = await s.fetch(`${s.githubApiUrl}/user`, {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${accessToken}`, "user-agent": "agent-town", "x-github-api-version": "2022-11-28" },
  });
  if (!res.ok) throw new AppError("unauthorized", `GitHub rejected the token (${res.status}).`);
  const u = (await res.json()) as { id?: number; login?: string; name?: string | null; avatar_url?: string | null };
  if (typeof u.id !== "number" || typeof u.login !== "string") throw new AppError("unauthorized", "GitHub returned no user.");
  return { id: u.id, login: u.login, name: u.name ?? null, avatarUrl: u.avatar_url ?? null };
}
