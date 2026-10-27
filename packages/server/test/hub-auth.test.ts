import { townRoleId, World } from "@muster-town/core";
import type { FastifyInstance } from "fastify";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { defaultAuthSettings, safeReturnTo, sessionCookie } from "../src/auth/index.ts";
import { Hub, type HubCollective } from "../src/hub.ts";
import { json } from "./helpers.ts";

// docs/hosted-collectives.md step 2: one GitHub sign-in at the root, every World decides the visitor's role on its own.
const PROFILES: Record<string, { id: number; login: string; name: string | null; avatar_url: string }> = {
  gho_mitchell: { id: 1001, login: "mitchell-g", name: "Mitchell G", avatar_url: "https://avatars.test/1001" },
  gho_octo: { id: 2002, login: "octo", name: "Octo Cat", avatar_url: "https://avatars.test/2002" },
};
const CODES: Record<string, string> = { code_mitchell: "gho_mitchell", code_octo: "gho_octo" };
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const res = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  if (url === "https://gh.test/login/oauth/access_token") return res({ access_token: CODES[JSON.parse(String(init?.body)).code], token_type: "bearer" });
  const tok = /^Bearer (.+)$/.exec(new Headers(init?.headers).get("authorization") ?? "")?.[1] ?? "";
  return res(PROFILES[tok]);
}) as typeof globalThis.fetch;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function setup() {
  const auth = defaultAuthSettings({
    githubClientId: "cid", githubClientSecret: "csecret", publicUrl: "http://localhost:4322", admins: ["mitchell-g"],
    githubUrl: "https://gh.test", githubApiUrl: "https://api.gh.test", fetch: fakeFetch,
  });
  const world = World.open(":memory:");
  world.seedDefaults({ adminName: "Mitchell" });
  // as main.ts: the root's cookie and secret, no admin allowlist, the hub row's owner
  const hub = new Hub(mkdtempSync(join(tmpdir(), "hub-auth-")), (w: World, row: HubCollective, dir: string) => buildApp({
    world: w, webDist: false, prefix: `/${row.slug}`, exportDir: join(dir, "export"), runtime: null,
    auth: { ...auth, admins: [], hosted: { slug: row.slug, ownerGithubId: row.ownerGithubId } },
  }));
  await hub.openAll();
  const app = await buildApp({ world, webDist: false, hub, auth });
  cleanups.push(async () => { await app.close(); world.close(); });
  return { world, hub, app, auth };
}

const cookieOf = (setCookie: string | string[] | undefined, name: string) =>
  ([] as string[]).concat(setCookie ?? []).find((c) => c.startsWith(`${name}=`))?.split(";")[0];

/** The browser's sign-in from `start` (`/auth/github` or `/demo/auth/github`): where it lands and the session cookie. */
async function signIn(app: FastifyInstance, code: string, start = "/auth/github") {
  let res = await app.inject({ method: "GET", url: start });
  if (!res.headers.location!.startsWith("https://")) res = await app.inject({ method: "GET", url: res.headers.location! });
  const state = new URL(res.headers.location!).searchParams.get("state")!;
  const back = await app.inject({ method: "GET", url: `/auth/github/callback?code=${code}&state=${state}`, headers: { cookie: cookieOf(res.headers["set-cookie"], "at_oauth_state_4322")! } });
  expect(back.statusCode).toBe(302);
  return { landed: back.headers.location!, cookie: cookieOf(back.headers["set-cookie"], "at_session_4322")! };
}
const me = async (app: FastifyInstance, url: string, cookie: string) => json(app, "GET", url, { headers: { cookie } });
const demo = { slug: "demo", name: "Demo Collective", goal: "Show the hub works", tagline: "" };

describe("one sign-in across the hub", () => {
  it("signs in once at the root: the Workshop and /demo each give their own role; the owner is demo's admin", async () => {
    const { app, hub, auth, world } = await setup();
    await hub.create(demo, { id: 2002, login: "octo", name: "Octo Cat", avatarUrl: null });

    // octo owns demo: admin there (the seeded placeholder admin, renamed), a visitor (guest) in the Workshop
    const octo = (await signIn(app, "code_octo")).cookie;
    const wsOcto = await me(app, "/api/me", octo);
    expect(wsOcto.status).toBe(200);
    expect(wsOcto.body).toMatchObject({ isAdmin: false, canInteract: false });
    const demoOcto = await me(app, "/demo/api/me", octo);
    expect(demoOcto.status).toBe(200);
    expect(demoOcto.body).toMatchObject({ isAdmin: true, canInteract: true, user: { githubId: 2002, name: "Octo Cat" } });
    expect(hub.world("demo")!.users.all().filter((u) => u.githubId === 2002)).toHaveLength(1);

    // Mitchell is a Workshop admin and a guest in demo: read-only there, asks to join like anyone
    const mitchell = (await signIn(app, "code_mitchell")).cookie;
    expect((await me(app, "/api/me", mitchell)).body).toMatchObject({ isAdmin: true, canInteract: true });
    const demoMitchell = await me(app, "/demo/api/me", mitchell);
    expect(demoMitchell.status).toBe(200);
    expect(demoMitchell.body).toMatchObject({ isAdmin: false, canInteract: false });
    expect(demoMitchell.body.roles.map((r: { name: string }) => r.name)).toEqual(["visitor"]);
    expect((await json(app, "POST", "/demo/api/docs", { headers: { cookie: mitchell }, body: { title: "x", body: "y" } })).status).toBe(403);
    expect((await json(app, "POST", "/demo/api/access-requests", { headers: { cookie: mitchell }, body: {} })).status).toBeLessThan(300);
    // the owner may write in demo
    expect((await json(app, "POST", "/demo/api/docs", { headers: { cookie: octo }, body: { title: "x", body: "y" } })).status).toBeLessThan(300);

    // a cookie without a GitHub identity (a session minted for a Workshop user id) is nobody in demo
    expect((await me(app, "/demo/api/me", sessionCookie(auth, world.users.first("1=1")!.id).split(";")[0]!)).status).toBe(401);
  });

  it("creating a collective from a session makes the creator its admin, and the owner stays admin after a reopen", async () => {
    const { app, hub, auth } = await setup();
    const mitchell = (await signIn(app, "code_mitchell")).cookie;
    expect((await json(app, "POST", "/api/collectives", { headers: { cookie: mitchell }, body: demo })).status).toBe(201);
    expect(hub.get("demo")!.ownerGithubId).toBe("1001");
    expect((await me(app, "/demo/api/me", mitchell)).body).toMatchObject({ isAdmin: true, user: { name: "Mitchell", githubLogin: "mitchell-g" } });
    expect((await me(app, "/api/me", mitchell)).body.isAdmin).toBe(true);

    // a reopen (restart) on the same dir: the owner still holds admin even if it was revoked meanwhile
    const w = hub.world("demo")!;
    const owner = w.users.first("githubId = ?", [1001])!;
    w.permissions.revoke({ kind: "user", id: owner.id }, townRoleId("admin"));
    const dir = hub.dir;
    await hub.close();
    const hub2 = new Hub(dir, (wd: World, row: HubCollective, d: string) => buildApp({ world: wd, webDist: false, prefix: `/${row.slug}`, exportDir: join(d, "export"), runtime: null, auth: { ...auth, admins: [], hosted: { slug: row.slug, ownerGithubId: row.ownerGithubId } } }));
    await hub2.openAll();
    cleanups.push(() => hub2.close());
    const w2 = hub2.world("demo")!;
    expect(w2.permissions.isAdmin({ kind: "user", id: w2.users.first("githubId = ?", [1001])!.id })).toBe(true);
  });

  it("a sign-in started at /demo/ goes through the root's flow and lands back on /demo/", async () => {
    const { app, hub } = await setup();
    await hub.create(demo);
    const hand = await app.inject({ method: "GET", url: "/demo/auth/github" });
    expect(hand.statusCode).toBe(302);
    expect(hand.headers.location).toBe("/auth/github?return_to=%2Fdemo%2F");
    const { landed, cookie } = await signIn(app, "code_octo", "/demo/auth/github");
    expect(landed).toBe("/demo/");
    expect((await me(app, "/demo/api/me", cookie)).body).toMatchObject({ isAdmin: false, canInteract: false });
    // a foreign or unknown return-to lands on the Workshop's client
    for (const bad of ["https://evil.test/demo/", "//evil.test/demo/", "/nope/", "/demo", "/\\evil.test/demo/"]) {
      const start = await app.inject({ method: "GET", url: `/auth/github?return_to=${encodeURIComponent(bad)}` });
      const state = new URL(start.headers.location!).searchParams.get("state")!;
      const back = await app.inject({ method: "GET", url: `/auth/github/callback?code=code_octo&state=${state}`, headers: { cookie: cookieOf(start.headers["set-cookie"], "at_oauth_state_4322")! } });
      expect(back.headers.location, bad).toBe("/workshop/");
    }
    // the hosted app has no callback of its own
    expect((await app.inject({ method: "GET", url: "/demo/auth/github/callback?code=x&state=y" })).statusCode).toBe(404);
  });
});

describe("safeReturnTo", () => {
  const slugs = (s: string) => s === "demo" || s === "workshop";
  it("keeps a path under a known collective and rejects everything else", () => {
    expect(safeReturnTo("/demo/", slugs)).toBe("/demo/");
    expect(safeReturnTo("/demo/#/doc/dc_1?x=1", slugs)).toBe("/demo/#/doc/dc_1?x=1");
    expect(safeReturnTo("/demo/../evil/", slugs)).toBeNull();
    for (const bad of ["https://evil.test/demo/", "//evil.test/demo/", "/\\evil.test", "/demo", "/other/", "demo/", "", null, 42, "/demo/\nx"]) {
      expect(safeReturnTo(bad, slugs), String(bad)).toBeNull();
    }
  });
});
