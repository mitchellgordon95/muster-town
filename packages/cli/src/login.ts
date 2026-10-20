/**
 * `muster-town login`: GitHub device flow → a town user token saved to a profile.
 * 1. `GET <town>/api/auth/config` for the public GitHub client id.
 * 2. GitHub `POST /login/device/code` → print the verification URL and user code.
 * 3. Poll GitHub `POST /login/oauth/access_token` until the user approves.
 * 4. `POST <town>/api/auth/github/device { accessToken }` → `{ token, user }` (the server checks GitHub `/user` and
 *    never stores the GitHub token) → `~/.agent-town/<profile>.env` (mode 600).
 * AGENT_TOWN_GITHUB_URL overrides https://github.com (tests).
 */
import type { AuthConfig, User } from "@muster-town/schema";
import type { Command } from "commander";
import { request } from "./client.ts";
import { CliError, DEFAULT_URL, writeProfile } from "./profile.ts";

/** Login saves a *user* token; agent commands read the `default` profile, so the user token lives apart. */
export const LOGIN_PROFILE = "user";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export interface LoginDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  print?: (s: string) => void;
  githubUrl?: string;
}

export interface LoginResult { user: User; path: string; profile: string }

async function githubPost<T>(f: typeof fetch, url: string, body: Record<string, string>): Promise<T> {
  let res: Response;
  try {
    res = await f(url, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    throw new CliError(`Can't reach GitHub (${e instanceof Error ? e.message : String(e)}).`);
  }
  const j = (await res.json().catch(() => ({}))) as T & { error?: string; error_description?: string };
  if (!res.ok && !j.error) throw new CliError(`GitHub returned ${res.status}.`);
  return j;
}

export async function login(o: { url: string; profile: string }, deps: LoginDeps = {}): Promise<LoginResult> {
  const f = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const print = deps.print ?? ((s: string) => process.stdout.write(s + "\n"));
  const gh = (deps.githubUrl ?? process.env.AGENT_TOWN_GITHUB_URL?.trim() ?? "https://github.com").replace(/\/+$/, "");
  const conn = { url: o.url.replace(/\/+$/, ""), token: null, source: "login" };

  const cfg = await request<AuthConfig>(conn, "GET", "/api/auth/config", { auth: false });
  if (!cfg.githubClientId) throw new CliError(`GitHub login isn't set up on ${conn.url}: the server needs GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET (see the README, "Logins").`, 2);

  const code = await githubPost<{ device_code?: string; user_code?: string; verification_uri?: string; expires_in?: number; interval?: number; error?: string; error_description?: string }>(
    f, `${gh}/login/device/code`, { client_id: cfg.githubClientId, scope: "read:user" });
  if (!code.device_code || !code.user_code) {
    const hint = code.error === "device_flow_disabled" ? " Turn on \"Enable Device Flow\" in the GitHub OAuth app's settings." : "";
    throw new CliError(`GitHub refused the device login: ${code.error_description ?? code.error ?? "no device code"}.${hint}`);
  }
  print(`Open ${code.verification_uri ?? "https://github.com/login/device"} and enter the code: ${code.user_code}`);
  print("Waiting for you to approve on GitHub…");

  let interval = (code.interval ?? 5) * 1000;
  const deadline = Date.now() + (code.expires_in ?? 900) * 1000;
  let accessToken: string | null = null;
  while (!accessToken) {
    if (Date.now() > deadline) throw new CliError("The code expired before it was approved. Run `muster-town login` again.");
    await sleep(interval);
    const t = await githubPost<{ access_token?: string; error?: string; error_description?: string; interval?: number }>(
      f, `${gh}/login/oauth/access_token`, { client_id: cfg.githubClientId, device_code: code.device_code, grant_type: DEVICE_GRANT });
    if (t.access_token) accessToken = t.access_token;
    else if (t.error === "authorization_pending") continue;
    else if (t.error === "slow_down") interval = (t.interval ?? interval / 1000 + 5) * 1000;
    else if (t.error === "expired_token") throw new CliError("The code expired before it was approved. Run `muster-town login` again.");
    else if (t.error === "access_denied") throw new CliError("Sign-in was cancelled on GitHub.");
    else throw new CliError(`GitHub sign-in failed: ${t.error_description ?? t.error ?? "unknown error"}.`);
  }

  const r = await request<{ token: string; user: User }>(conn, "POST", "/api/auth/github/device", { auth: false, body: { accessToken } });
  const path = writeProfile(o.profile, { url: conn.url, token: r.token });
  print(`logged in as ${r.user.githubLogin ?? r.user.name}`);
  print(`Saved your user token to ${path} (mode 600).`);
  return { user: r.user, path, profile: o.profile };
}

export function registerLogin(program: Command, deps: LoginDeps = {}): void {
  program
    .command("login")
    .description("Sign in with GitHub (device code) and save your user token to a profile")
    .option("--profile <name>", "profile to save to (~/.agent-town/<name>.env)", LOGIN_PROFILE)
    .option("--url <url>", "town server URL (default AGENT_TOWN_URL or http://localhost:4321)")
    .action(async (o: { profile: string; url?: string }) => {
      await login({ url: o.url ?? (process.env.AGENT_TOWN_URL?.trim() || DEFAULT_URL), profile: o.profile }, deps);
    });
}
