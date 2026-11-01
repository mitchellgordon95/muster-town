import { World } from "@muster-town/core";
import type { FastifyInstance } from "fastify";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { defaultAuthSettings, safeReturnTo } from "../src/auth/index.ts";
import { Hub, type HubCollective } from "../src/hub.ts";
import { json } from "./helpers.ts";

// docs/hosted-collectives.md step 3: anyone signed in with GitHub starts a collective, on their own key, and can retire it.
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

const KEY = "sk-ant-api03-test-key-0123456789abcdef";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function setup() {
  const auth = defaultAuthSettings({
    githubClientId: "cid", githubClientSecret: "csecret", publicUrl: "http://localhost:4322", admins: ["mitchell-g"],
    githubUrl: "https://gh.test", githubApiUrl: "https://api.gh.test", fetch: fakeFetch,
  });
  const world = World.open(":memory:");
  world.seedDefaults({ adminName: "Mitchell" });
  // as main.ts: each hosted app gets the root's cookie and secret, its owner, and the hub's retire
  const hub: Hub = new Hub(mkdtempSync(join(tmpdir(), "hub-start-")), (w: World, row: HubCollective, dir: string) => buildApp({
    world: w, webDist: false, prefix: `/${row.slug}`, exportDir: join(dir, "export"), runtime: null,
    auth: { ...auth, admins: [], hosted: { slug: row.slug, ownerGithubId: row.ownerGithubId } },
    retire: () => hub.retire(row.slug),
  }));
  await hub.openAll();
  const app = await buildApp({ world, webDist: false, hub, auth });
  cleanups.push(async () => { await app.close(); world.close(); });
  return { world, hub, app };
}

const cookieOf = (setCookie: string | string[] | undefined, name: string) =>
  ([] as string[]).concat(setCookie ?? []).find((c) => c.startsWith(`${name}=`))?.split(";")[0];

async function signIn(app: FastifyInstance, code: string, start = "/auth/github") {
  const res = await app.inject({ method: "GET", url: start });
  const state = new URL(res.headers.location!).searchParams.get("state")!;
  const back = await app.inject({ method: "GET", url: `/auth/github/callback?code=${code}&state=${state}`, headers: { cookie: cookieOf(res.headers["set-cookie"], "at_oauth_state_4322")! } });
  return { landed: back.headers.location!, cookie: cookieOf(back.headers["set-cookie"], "at_session_4322")! };
}
const start = (app: FastifyInstance, cookie: string, body: object) => json(app, "POST", "/api/collectives", { headers: { cookie }, body });
const garden = { name: "Garden Club!", goal: "Map every community garden in town" };

describe("Start a collective", () => {
  it("a never-granted stranger starts one: the address comes from the name, they land as its admin, no key means held", async () => {
    const { app, hub } = await setup();
    // the homepage offers it beside the list (the bundle opens the form at #start)
    expect((await app.inject({ method: "GET", url: "/" })).body).toContain('<a class="btn" href="#start">Start a collective</a>');
    const octo = (await signIn(app, "code_octo")).cookie;
    expect((await json(app, "GET", "/api/me", { headers: { cookie: octo } })).body).toMatchObject({ canInteract: false });
    // a tagline sent by an old client is ignored: a collective's goal is its tagline
    const res = await start(app, octo, { ...garden, tagline: "ignored" });
    expect(res.status).toBe(201);
    expect(res.body.collective).toMatchObject({ slug: "garden-club", url: "/garden-club/", name: "Garden Club!", ownerGithubId: "2002", tagline: "" });
    expect((await json(app, "GET", "/garden-club/api/me", { headers: { cookie: octo } })).body).toMatchObject({ isAdmin: true });
    // its first screen carries its name and goal; with no key its agents are held
    const town = (await json(app, "GET", "/garden-club/api/town")).body;
    expect(town.town).toMatchObject({ name: "Garden Club!", goal: garden.goal });
    expect(town.health.funding).toBe("none");
    // the homepage lists it with its goal under the name
    const home = (await app.inject({ method: "GET", url: "/" })).body;
    expect(home).toContain(`<p class="tile-tag">${garden.goal}</p>`);
    expect(home).not.toContain("ignored");
    expect((await json(app, "GET", "/garden-club/api/health")).body.funding).toBe("none");
    // the Workshop's own health says nothing about funding
    expect((await json(app, "GET", "/api/health")).body.funding).toBeUndefined();
    // its goal tree is the founder's (gr_5ltmbf3a2f): root = the Start form's goal, the founder captains it, no Workshop pillars
    const me = (await json(app, "GET", "/garden-club/api/me", { headers: { cookie: octo } })).body;
    const goals = (await json(app, "GET", "/garden-club/api/goals")).body;
    expect(goals.root).toMatchObject({ id: "gl_town", text: garden.goal, children: [] });
    expect(goals.root.ownerId).toBeTruthy();
    expect(goals.root.owner.name).toBe(me.user?.name ?? me.name);
    expect(goals.root.owner.name).not.toBe("admin");
    // the Workshop's tree keeps its pillars
    expect((await json(app, "GET", "/api/goals")).body.root.children.map((c: { id: string }) => c.id)).toEqual(expect.arrayContaining(["gl_fund", "gl_join", "gl_trust"]));
    expect(hub.ownedBy(2002)).toHaveLength(1);
  });

  it("one active collective per person; a town admin has no cap", async () => {
    const { app } = await setup();
    const octo = (await signIn(app, "code_octo")).cookie;
    expect((await start(app, octo, garden)).status).toBe(201);
    const second = await start(app, octo, { name: "Second", goal: "Another one" });
    expect(second.status).toBe(429);
    expect(second.body.error).toMatch(/garden-club.*one collective per person/);
    const mitchell = (await signIn(app, "code_mitchell")).cookie;
    expect((await start(app, mitchell, { name: "One", goal: "g" })).status).toBe(201);
    expect((await start(app, mitchell, { name: "Two", goal: "g" })).status).toBe(201);
    // taken and reserved still answer 409 and 400
    expect((await start(app, mitchell, { name: "garden club", goal: "g" })).status).toBe(409);
    expect((await start(app, mitchell, { name: "Workshop", goal: "g" })).status).toBe(400);
  });

  it("takes an API key, stores it in that World only and never returns it; refuses subscription tokens", async () => {
    const { app, hub } = await setup();
    const octo = (await signIn(app, "code_octo")).cookie;
    const oat = await start(app, octo, { ...garden, apiKey: "sk-ant-oat01-abcdefghijklmnop" });
    expect(oat.status).toBe(400);
    expect(oat.body.error).toMatch(/subscription token/);
    expect(hub.get("garden-club")).toBeNull();
    expect((await start(app, octo, { ...garden, apiKey: "not-a-key" })).status).toBe(400);

    const res = await start(app, octo, { ...garden, apiKey: KEY });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain(KEY);
    const w = hub.world("garden-club")!;
    const input = w.bank.liveApiKeyInput()!;
    expect(input).toMatchObject({ source: "api-key", hasApiKey: true });
    expect(w.bank.apiKeyFor(input.id)).toBe(KEY);
    for (const url of ["/garden-club/api/bank", "/garden-club/api/town", "/garden-club/api/health", "/api/collectives"]) {
      const r = await app.inject({ method: "GET", url, headers: { cookie: octo } });
      expect(r.body, url).not.toContain(KEY);
    }
    expect((await json(app, "GET", "/garden-club/api/health")).body.funding).toBe("api-key");
  });

  it("a hosted collective's Bank takes API keys only", async () => {
    const { app } = await setup();
    const octo = (await signIn(app, "code_octo")).cookie;
    await start(app, octo, garden);
    const sub = await json(app, "POST", "/garden-club/api/bank/inputs", { headers: { cookie: octo }, body: { label: "Max", source: "subscription", model: "claude-opus-5-5", tokens: 1000, recurrence: "daily", weeklyCapTokens: 5000 } });
    expect(sub.status).toBe(400);
    const oat = await json(app, "POST", "/garden-club/api/bank/inputs", { headers: { cookie: octo }, body: { label: "k", source: "api-key", model: "claude-opus-5-5", tokens: 1000, apiKey: "sk-ant-oat01-abcdefghijklmnop" } });
    expect(oat.status).toBe(400);
    const ok = await json(app, "POST", "/garden-club/api/bank/inputs", { headers: { cookie: octo }, body: { label: "k", source: "api-key", model: "claude-opus-5-5", tokens: 1000, apiKey: KEY } });
    expect(ok.status).toBe(201);
    expect(JSON.stringify(ok.body)).not.toContain(KEY);
    expect((await json(app, "GET", "/garden-club/api/health")).body.funding).toBe("api-key");
  });

  it("its admin retires it: a retired notice at its address, the slug stays taken, the cap frees up", async () => {
    const { app, hub } = await setup();
    const octo = (await signIn(app, "code_octo")).cookie;
    await start(app, octo, garden);
    const mitchell = (await signIn(app, "code_mitchell")).cookie;
    expect((await json(app, "POST", "/garden-club/api/collective/retire", { headers: { cookie: mitchell } })).status).toBe(403);
    const done = await json(app, "POST", "/garden-club/api/collective/retire", { headers: { cookie: octo } });
    expect(done.status).toBe(200);
    expect(hub.get("garden-club")!.state).toBe("retired");
    const page = await app.inject({ method: "GET", url: "/garden-club/" });
    expect(page.statusCode).toBe(410);
    expect(page.body).toContain("Garden Club! was retired");
    expect((await app.inject({ method: "GET", url: "/garden-club/api/town" })).statusCode).toBe(410);
    expect((await json(app, "GET", "/api/collectives")).body.collectives.map((c: { slug: string }) => c.slug)).not.toContain("garden-club");
    expect((await start(app, octo, garden)).status).toBe(409);
    expect((await start(app, octo, { name: "Garden Club 2", goal: "again" })).status).toBe(201);
    // the Workshop is untouched
    expect((await app.inject({ method: "GET", url: "/api/town" })).statusCode).toBe(200);
  });

  it("sign-in from the Start form comes back to /#start", async () => {
    const { app } = await setup();
    const { landed } = await signIn(app, "code_octo", `/auth/github?return_to=${encodeURIComponent("/#start")}`);
    expect(landed).toBe("/#start");
    expect(safeReturnTo("/#start", () => false)).toBe("/#start");
    expect(safeReturnTo("//evil.test/#start", () => false)).toBeNull();
  });
});
