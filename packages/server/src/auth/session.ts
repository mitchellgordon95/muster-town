import type { World } from "@agent-town/core";
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

export interface SessionPayload { userId: string; iat: number }

export function sessionCookie(s: AuthSettings, userId: string, now = Date.now()): string {
  return cookie(sessionCookieName(s.publicUrl), sign(s.sessionSecret, { userId, iat: Math.floor(now / 1000) } satisfies SessionPayload), { maxAge: SESSION_MAX_AGE_S, secure: isSecure(s) });
}
export const clearSessionCookie = (s: AuthSettings) => cookie(sessionCookieName(s.publicUrl), "", { maxAge: 0, secure: isSecure(s) });

/** A fresh OAuth `state` nonce and the signed cookie that pins it to this browser. */
export function newState(s: AuthSettings): { state: string; setCookie: string } {
  const state = randomBytes(16).toString("base64url");
  return { state, setCookie: cookie(stateCookieName(s.publicUrl), sign(s.sessionSecret, { state, iat: Math.floor(Date.now() / 1000) }), { maxAge: STATE_MAX_AGE_S, path: "/auth", secure: isSecure(s) }) };
}
export function checkState(s: AuthSettings, req: FastifyRequest, state: string | undefined): boolean {
  const v = unsign<{ state: string; iat: number }>(s.sessionSecret, parseCookies(req.headers.cookie)[stateCookieName(s.publicUrl)]);
  return !!v && !!state && v.state === state && Date.now() / 1000 - v.iat <= STATE_MAX_AGE_S;
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
  const user = world.users.get(p.userId);
  return user ? { kind: "user", user } : null;
}
