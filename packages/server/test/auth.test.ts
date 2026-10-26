import { World } from "@muster-town/core";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildApp } from "../src/app.ts";
import { sessionCookie, defaultAuthSettings, type AuthSettings } from "../src/auth/index.ts";
import { REPO_ROOT } from "./helpers.ts";

const PROFILES: Record<string, { id: number; login: string; name: string | null; avatar_url: string }> = {
  gho_mitchell: { id: 1001, login: "mitchell-g", name: "Mitchell G", avatar_url: "https://avatars.test/1001" },
  gho_octo: { id: 2002, login: "octo", name: null, avatar_url: "https://avatars.test/2002" },
};
const CODES: Record<string, string> = { code_mitchell: "gho_mitchell", code_octo: "gho_octo" };

/** A stand-in for github.com + api.github.com. Records calls. */
function fakeGithub() {
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url === "https://gh.test/login/oauth/access_token") {
      const b = JSON.parse(String(init?.body)) as { code: string; client_id: string; client_secret: string };
      if (b.client_id !== "cid" || b.client_secret !== "csecret") return json(401, { error: "incorrect_client_credentials" });
      return CODES[b.code] ? json(200, { access_token: CODES[b.code], token_type: "bearer" }) : json(200, { error: "bad_verification_code", error_description: "The code passed is incorrect or expired." });
    }
    if (url === "https://api.gh.test/user") {
      const tok = /^Bearer (.+)$/.exec(new Headers(init?.headers).get("authorization") ?? "")?.[1] ?? "";
      return PROFILES[tok] ? json(200, PROFILES[tok]) : json(401, { message: "Bad credentials" });
    }
    return json(404, { message: "not found" });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { await cleanup?.(); cleanup = null; });

async function setup(over: Partial<AuthSettings> = {}) {
  const world = World.open(":memory:");
  const seed = world.seedDefaults({ importDir: join(REPO_ROOT, "buildings/carbon-cycle"), townJsonPath: join(REPO_ROOT, "town.json") });
  const gh = fakeGithub();
  const auth = defaultAuthSettings({
    githubClientId: "cid", githubClientSecret: "csecret", publicUrl: "http://localhost:4322", admins: ["Mitchell-G"],
    githubUrl: "https://gh.test", githubApiUrl: "https://api.gh.test", fetch: gh.fetch, ...over,
  });
  const app = await buildApp({ world, dev: false, webDist: false, auth });
  cleanup = async () => { await app.close(); world.close(); };
  return { world, seed, app, gh, auth };
}

const cookieOf = (setCookie: string | string[] | undefined, name: string) =>
  ([] as string[]).concat(setCookie ?? []).find((c) => c.startsWith(`${name}=`))!.split(";")[0];

/** Run the web flow: /auth/github → (GitHub) → callback with `code`. Returns the callback response. */
async function webLogin(app: FastifyInstance, code: string) {
  const start = await app.inject({ method: "GET", url: "/auth/github" });
  expect(start.statusCode).toBe(302);
  const loc = new URL(start.headers.location as string);
  expect(loc.origin + loc.pathname).toBe("https://gh.test/login/oauth/authorize");
  expect(loc.searchParams.get("redirect_uri")).toBe("http://localhost:4322/auth/github/callback");
  expect(loc.searchParams.get("scope")).toBe("read:user");
  const state = loc.searchParams.get("state")!;
  const stateCookie = cookieOf(start.headers["set-cookie"], "at_oauth_state_4322");
  return app.inject({ method: "GET", url: `/auth/github/callback?code=${code}&state=${state}`, headers: { cookie: stateCookie } });
}

describe("auth config", () => {
  it("advertises the client id, or null when GitHub isn't configured", async () => {
    const { app, seed, auth } = await setup();
    expect((await app.inject({ method: "GET", url: "/api/auth/config" })).json()).toEqual({ githubClientId: "cid", publicUrl: "http://localhost:4322", dev: false, session: false });
    // a valid session cookie: the client may ask /api/me (a guest's browser skips it, so no 401)
    const cookie = sessionCookie(auth, seed.admin.id).split(";")[0];
    expect((await app.inject({ method: "GET", url: "/api/auth/config", headers: { cookie } })).json().session).toBe(true);
    await cleanup!(); cleanup = null;
    const off = await setup({ githubClientId: null });
    expect((await off.app.inject({ method: "GET", url: "/api/auth/config" })).json().githubClientId).toBeNull();
    expect((await off.app.inject({ method: "GET", url: "/auth/github" })).statusCode).toBe(404);
  });
});

describe("GitHub web login", () => {
  it("callback creates a visitor, sets a session cookie /api/me accepts, and logout clears it", async () => {
    const { app, world } = await setup();
    const cb = await webLogin(app, "code_octo");
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe("/workshop/");
    const raw = ([] as string[]).concat(cb.headers["set-cookie"] ?? []).find((c) => c.startsWith("at_session_4322="))!;
    expect(raw).toMatch(/HttpOnly/);
    expect(raw).toMatch(/SameSite=Lax/);
    expect(raw).toMatch(/Max-Age=2592000/);
    const cookie = raw.split(";")[0];

    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user).toMatchObject({ name: "octo", githubLogin: "octo", githubId: 2002, avatarUrl: "https://avatars.test/2002" });
    expect(me.json().isAdmin).toBe(false);
    expect(me.json().roles.map((r: { name: string }) => r.name)).toEqual(["visitor"]);
    expect(world.users.first("githubId = ?", [2002])).toBeTruthy();

    // writes ride on the cookie too (same origin); a cross-origin request does not
    const sameOrigin = await app.inject({ method: "POST", url: "/api/bank/inputs", headers: { cookie, origin: "http://localhost:4322" }, payload: {} });
    expect(sameOrigin.statusCode).not.toBe(401);
    const cross = await app.inject({ method: "GET", url: "/api/me", headers: { cookie, origin: "http://evil.test" } });
    expect(cross.statusCode).toBe(401);

    const out = await app.inject({ method: "POST", url: "/auth/logout" });
    expect(String(out.headers["set-cookie"])).toMatch(/at_session_4322=; .*Max-Age=0/);
  });

  it("rejects a callback without the matching state cookie, and a bad code", async () => {
    const { app } = await setup();
    const forged = await app.inject({ method: "GET", url: "/auth/github/callback?code=code_octo&state=abc" });
    expect(forged.statusCode).toBe(302);
    expect(forged.headers.location).toMatch(/^\/workshop\/\?auth_error=/);
    expect(String(forged.headers["set-cookie"])).not.toMatch(/at_session_4322=[^;]/);
    const bad = await webLogin(app, "code_nope");
    expect(decodeURIComponent(bad.headers.location as string)).toMatch(/incorrect or expired/);
  });

  it("a tampered or foreign session cookie is ignored", async () => {
    const { app, seed, auth } = await setup();
    const good = sessionCookie(auth, seed.admin.id).split(";")[0];
    expect((await app.inject({ method: "GET", url: "/api/me", headers: { cookie: good } })).statusCode).toBe(200);
    const foreign = sessionCookie({ ...auth, sessionSecret: "other" }, seed.admin.id).split(";")[0];
    expect((await app.inject({ method: "GET", url: "/api/me", headers: { cookie: foreign } })).statusCode).toBe(401);
    const old = sessionCookie(auth, seed.admin.id, Date.now() - 31 * 24 * 3600 * 1000).split(";")[0];
    expect((await app.inject({ method: "GET", url: "/api/me", headers: { cookie: old } })).statusCode).toBe(401);
  });

  it("an allowlisted login gets admin and is linked to the seeded admin", async () => {
    const { app, seed, world } = await setup();
    const users = world.users.all().length;
    const cb = await webLogin(app, "code_mitchell");
    const cookie = cookieOf(cb.headers["set-cookie"], "at_session_4322");
    const me = (await app.inject({ method: "GET", url: "/api/me", headers: { cookie } })).json();
    expect(me.user.id).toBe(seed.admin.id);
    expect(me.user.githubLogin).toBe("mitchell-g");
    expect(me.isAdmin).toBe(true);
    expect(world.users.all().length).toBe(users);
  });
});

describe("device-code login", () => {
  it("verifies the GitHub token via /user and mints a town user token", async () => {
    const { app, gh, world } = await setup();
    const r = await app.inject({ method: "POST", url: "/api/auth/github/device", payload: { accessToken: "gho_octo" } });
    expect(r.statusCode).toBe(200);
    const { token, user } = r.json();
    expect(user.githubLogin).toBe("octo");
    expect(gh.calls).toContain("GET https://api.gh.test/user");
    expect(world.tokens.resolve(token)).toMatchObject({ kind: "user", id: user.id });
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${token}` } });
    expect(me.json().user.id).toBe(user.id);
    // the GitHub token is never stored
    expect(JSON.stringify(world.users.all())).not.toContain("gho_octo");

    const bad = await app.inject({ method: "POST", url: "/api/auth/github/device", payload: { accessToken: "gho_fake" } });
    expect(bad.statusCode).toBe(401);
  });
});

describe("guests", () => {
  it("read town, docs, boards, meetings and the library without a token; writes stay authenticated", async () => {
    const { app } = await setup();
    for (const url of ["/api/town", "/api/events", "/api/docs", "/api/docs?state=library", "/api/meetings", "/api/buildings/carbon-cycle", "/api/buildings/carbon-cycle/board", "/api/buildings/carbon-cycle/cabinet", "/api/buildings/carbon-cycle/intray", "/api/roles", "/api/budget"]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(200);
    }
    const docs = (await app.inject({ method: "GET", url: "/api/docs" })).json().docs;
    if (docs[0]) expect((await app.inject({ method: "GET", url: `/api/docs/${docs[0].id}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/me" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/docs", payload: { title: "x", body: "y" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/meetings", payload: { kind: "standup", buildingId: "carbon-cycle" } })).statusCode).toBe(401);
  });

  it("an unauthenticated WS gets a snapshot and live events, and an error on move/say", async () => {
    const { app, world } = await setup();
    world.start(10);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const msgs: any[] = [];
    ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
    const waitFor = async (pred: (m: any) => boolean) => {
      for (let i = 0; i < 100; i++) { const m = msgs.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 20)); }
      throw new Error("timeout");
    };
    await new Promise((r) => ws.once("open", r));
    const snap = await waitFor((m) => m.type === "snapshot");
    expect(snap.avatarAgentId).toBeUndefined();
    expect(snap.agents.length).toBeGreaterThan(0);

    ws.send(JSON.stringify({ type: "human.move", x: 1, y: 1 }));
    expect((await waitFor((m) => m.type === "error")).message).toMatch(/guest/);
    ws.send(JSON.stringify({ type: "human.say", text: "hello?" }));
    await waitFor((m) => m.type === "error" && msgs.filter((x) => x.type === "error").length === 2);

    world.events.append({ type: "system", text: "guests can watch" });
    expect(await waitFor((m) => m.type === "event" && m.event.text === "guests can watch")).toBeTruthy();
    ws.close();
  });

  it("a WS handshake with a session cookie is signed in without an auth message", async () => {
    const { app, seed, auth } = await setup();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: sessionCookie(auth, seed.admin.id).split(";")[0] } });
    const first = await new Promise<any>((r) => ws.once("message", (d) => r(JSON.parse(String(d)))));
    expect(first.type).toBe("snapshot");
    expect(first.avatarAgentId).toMatch(/^ag_/);
    ws.close();
  });
});
