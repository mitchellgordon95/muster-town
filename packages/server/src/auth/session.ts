import { townRoleId, upsertGithubUser, type GithubProfile, type World } from "@muster-town/core";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Auth } from "../context.ts";
import type { AuthSettings } from "./config.ts";

export const SESSION_MAX_AGE_S = 30 * 24 * 3600;
export const STATE_MAX_AGE_S = 600;

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");
const mac = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest("base64url");

/** `<payload>.<hmac>` with a base64url JSON payload. */
export function sign(secret: string, payload: object): string {
  const p = b64(JSON.stringify(payload));
  return `${p}.${mac(secret, p)}`;
}

export function unsign<T>(secret: string, value: string | undefined): T | null {
  if (!value) return null;
  const i = value.lastIndexOf(".");
  if (i <= 0) return null;
  const p = value.slice(0, i), sig = Buffer.from(value.slice(i + 1)), want = Buffer.from(mac(secret, p));
  if (sig.length !== want.length || !timingSafeEqual(sig, want)) return null;
  try { return JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as T; } catch { return null; }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* malformed */ }
  }
  return out;
}

/**
 * Cookies aren't port-scoped, so collectives on different localhost ports would overwrite each other's session:
 * the name carries the public URL's port when it has one (`at_session_4322`), else plain `at_session`.
 */
export function sessionCookieName(publicUrl: string): string {
  try { const port = new URL(publicUrl).port; return port ? `at_session_${port}` : "at_session"; } catch { return "at_session"; }
}
export const stateCookieName = (publicUrl: string) => sessionCookieName(publicUrl).replace("at_session", "at_oauth_state");

export function cookie(name: string, value: string, o: { maxAge: number; path?: string; secure?: boolean }): string {
  return [`${name}=${encodeURIComponent(value)}`, `Path=${o.path ?? "/"}`, `Max-Age=${o.maxAge}`, "HttpOnly", "SameSite=Lax", ...(o.secure ? ["Secure"] : [])].join("; ");
}

export const isSecure = (s: AuthSettings) => s.publicUrl.startsWith("https:");

/** `userId` is the root World's user; `gh` (GitHub sign-ins) is what a hosted World resolves the visitor by. */
export interface SessionPayload { userId: string; iat: number; gh?: GithubProfile }

export function sessionCookie(s: AuthSettings, userId: string, now = Date.now(), gh?: GithubProfile): string {
  const payload: SessionPayload = { userId, iat: Math.floor(now / 1000), ...(gh ? { gh: { id: gh.id, login: gh.login, name: gh.name ?? null, avatarUrl: gh.avatarUrl ?? null } } : {}) };
  return cookie(sessionCookieName(s.publicUrl), sign(s.sessionSecret, payload), { maxAge: SESSION_MAX_AGE_S, secure: isSecure(s) });
}
export const clearSessionCookie = (s: AuthSettings) => cookie(sessionCookieName(s.publicUrl), "", { maxAge: 0, secure: isSecure(s) });

/** A fresh OAuth `state` nonce and the signed cookie that pins it (and where to land after) to this browser. */
export function newState(s: AuthSettings, returnTo: string | null = null): { state: string; setCookie: string } {
  const state = randomBytes(16).toString("base64url");
  return { state, setCookie: cookie(stateCookieName(s.publicUrl), sign(s.sessionSecret, { state, iat: Math.floor(Date.now() / 1000), ...(returnTo ? { returnTo } : {}) }), { maxAge: STATE_MAX_AGE_S, path: "/auth", secure: isSecure(s) }) };
}
/** The state cookie's return-to when `state` matches it and it hasn't expired; `false` when it doesn't check out. */
export function checkState(s: AuthSettings, req: FastifyRequest, state: string | undefined): { returnTo: string | null } | false {
  const v = unsign<{ state: string; iat: number; returnTo?: string }>(s.sessionSecret, parseCookies(req.headers.cookie)[stateCookieName(s.publicUrl)]);
  return !!v && !!state && v.state === state && Date.now() / 1000 - v.iat <= STATE_MAX_AGE_S ? { returnTo: v.returnTo ?? null } : false;
}

/**
 * Where a sign-in may land after the callback: a path on this host (no scheme, no `//`, no backslash) whose first
 * segment is one of `slugs` and that ends that segment with `/` (`/demo/`, `/demo/#/doc/x`). Anything else: null.
 */
export function safeReturnTo(raw: unknown, slugs: (slug: string) => boolean): string | null {
  if (typeof raw !== "string" || raw.length > 512 || !raw.startsWith("/") || raw.startsWith("//") || /[\\\s]/.test(raw)) return null;
  let u: URL;
  try { u = new URL(raw, "http://h.invalid"); } catch { return null; }
  if (u.host !== "h.invalid") return null;
  const m = /^\/([a-z0-9-]+)\//.exec(u.pathname);
  return m && slugs(m[1]!) ? u.pathname + u.search + u.hash : null;
}
export const clearStateCookie = (s: AuthSettings) => cookie(stateCookieName(s.publicUrl), "", { maxAge: 0, path: "/auth", secure: isSecure(s) });

/** Cross-origin requests (another site, or another localhost port) never ride on the session cookie. */
function sameOrigin(s: AuthSettings, req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  let host: string;
  try { host = new URL(origin).host; } catch { return false; }
  if (host === req.headers.host) return true;
  try { return host === new URL(s.publicUrl).host; } catch { return false; }
}

/** The user behind a valid, unexpired session cookie (null otherwise). */
export function sessionAuth(world: World, s: AuthSettings, req: FastifyRequest, now = Date.now()): Auth | null {
  const raw = parseCookies(req.headers.cookie)[sessionCookieName(s.publicUrl)];
  if (!raw || !sameOrigin(s, req)) return null;
  const p = unsign<SessionPayload>(s.sessionSecret, raw);
  if (!p || typeof p.userId !== "string" || typeof p.iat !== "number" || now / 1000 - p.iat > SESSION_MAX_AGE_S) return null;
  if (s.hosted) return hostedUser(world, s.hosted, p.gh);
  const user = world.users.get(p.userId);
  return user ? { kind: "user", user } : null;
}

/**
 * The root session's GitHub identity in a hosted World: its user by githubId, created on first visit (town `visitor`
 * only: a guest there until let in), and the collective's owner always holds `admin`. A session without GitHub (a
 * pasted token's) is nobody here.
 */
function hostedUser(world: World, h: NonNullable<AuthSettings["hosted"]>, gh: GithubProfile | undefined): Auth | null {
  if (!gh || typeof gh.id !== "number" || typeof gh.login !== "string") return null;
  const owner = h.ownerGithubId != null && h.ownerGithubId === String(gh.id);
  let user = world.users.first("githubId = ?", [gh.id]);
  if (!user || (owner && !world.permissions.isAdmin({ kind: "user", id: user.id }))) {
    const r = upsertGithubUser(world, gh, { admins: owner ? [gh.login] : [] });
    // the owner takes over the seeded "admin" placeholder (its buildings and avatar) under their own name
    user = r.linked ? world.users.upsert({ ...r.user, name: gh.name?.trim() || gh.login }) : r.user;
    if (owner) world.permissions.grant({ kind: "user", id: user.id }, townRoleId("admin"));
    world.ops.ensureAvatar(user.id);
  }
  return { kind: "user", user };
}
