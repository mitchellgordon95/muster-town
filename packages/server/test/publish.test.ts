import { randomBytes } from "node:crypto";
import { createUser } from "@muster-town/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { json, seededApp } from "./helpers.ts";

// Publish to GitHub (gr_30f8obzab8 step 1): PUT/DELETE /api/town/publish, GET /api/town's `publish`, GET /api/health's `export`.
const TOKEN = "github_pat_SERVERtest0123456789abcdefSECRET";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.unstubAllEnvs(); while (cleanups.length) await cleanups.pop()!(); });

describe("publish routes", () => {
  it("an admin sets, reads and clears it; the token never comes back; members, agents and guests are refused", async () => {
    vi.stubEnv("MUSTER_TOWN_DATA_KEY", randomBytes(32).toString("hex"));
    const s = await seededApp();
    cleanups.push(s.close);
    const { world, app, auth } = s;
    const resident = world.agents.first("kind = 'resident'")!;
    const agentAuth = { authorization: `Bearer ${world.tokens.getOrCreate("agent", resident.id)}` };
    const { token } = createUser(world, "Stranger");
    const userAuth = { authorization: `Bearer ${token}` };
    const bodies: unknown[] = [];

    const put = await json(app, "PUT", "/api/town/publish", { headers: auth, body: { repoUrl: "https://github.com/acme/town-docs.git", token: TOKEN } });
    expect(put.status).toBe(200);
    expect(put.body.publish).toEqual({ repoUrl: "https://github.com/acme/town-docs.git", tokenSet: true, lastPushAt: null, lastPushCommit: null, lastPushError: null, tokenSource: "own" });
    bodies.push(put.body);
    const town = await json(app, "GET", "/api/town", { headers: auth });
    expect(town.body.town.publish).toMatchObject({ repoUrl: "https://github.com/acme/town-docs.git", tokenSet: true });
    bodies.push(town.body, (await json(app, "GET", "/api/town")).body, (await json(app, "GET", "/api/secrets", { headers: auth })).body);
    expect((await json(app, "GET", "/api/secrets", { headers: auth })).body.secrets).toEqual([]);
    // later save without a token keeps it
    const keep = await json(app, "PUT", "/api/town/publish", { headers: auth, body: { repoUrl: "https://github.com/acme/town-docs" } });
    expect(keep.body.publish).toMatchObject({ repoUrl: "https://github.com/acme/town-docs", tokenSet: true });
    // the reserved name can't be reached through /api/secrets
    expect((await json(app, "PUT", "/api/secrets/MUSTER_TOWN_PUBLISH_TOKEN", { headers: auth, body: { value: "x" } })).status).toBe(400);
    expect((await json(app, "DELETE", "/api/secrets/MUSTER_TOWN_PUBLISH_TOKEN", { headers: auth })).body).toEqual({ removed: false });
    // not a GitHub repo over https
    for (const repoUrl of ["http://github.com/a/b", "https://gitlab.com/a/b", "https://github.com/a", "file:///tmp/x", `https://x-access-token:${TOKEN}@github.com/a/b`]) {
      expect((await json(app, "PUT", "/api/town/publish", { headers: auth, body: { repoUrl } })).status).toBe(400);
    }
    for (const h of [agentAuth, userAuth, {}]) {
      expect((await json(app, "PUT", "/api/town/publish", { headers: h, body: { repoUrl: "https://github.com/evil/repo", token: "t" } })).status).toBeGreaterThanOrEqual(401);
      expect((await json(app, "DELETE", "/api/town/publish", { headers: h })).status).toBeGreaterThanOrEqual(401);
    }
    expect(world.town.get().publish?.repoUrl).toBe("https://github.com/acme/town-docs");

    const events = await json(app, "GET", "/api/events?limit=1000", { headers: auth });
    bodies.push(events.body);
    expect(events.body.events.some((e: { type: string }) => e.type === "town.publish-set")).toBe(true);
    const del = await json(app, "DELETE", "/api/town/publish", { headers: auth });
    expect(del.body).toEqual({ cleared: true });
    expect((await json(app, "GET", "/api/town", { headers: auth })).body.town.publish).toBeUndefined();
    for (const b of bodies) expect(JSON.stringify(b)).not.toContain(TOKEN);
  });

  it("without a data key a token is refused (409); GET /api/health carries `export`", async () => {
    vi.stubEnv("MUSTER_TOWN_DATA_KEY", "");
    vi.stubEnv("AGENT_TOWN_DATA_KEY", "");
    const s = await seededApp();
    cleanups.push(s.close);
    const r = await json(s.app, "PUT", "/api/town/publish", { headers: s.auth, body: { repoUrl: "https://github.com/acme/town-docs", token: TOKEN } });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/MUSTER_TOWN_DATA_KEY/);
    expect(s.world.town.get().publish).toBeUndefined();
    expect((await json(s.app, "GET", "/api/health")).body.export).toEqual({ lastAt: null, commit: null, lastPushAt: null, pushError: null });
    s.world.events.append({ type: "export.done", text: "Exported", payload: { commit: "abc1234", pushError: null } });
    s.world.setPublish({ repoUrl: "https://github.com/acme/town-docs" });
    s.world.town.set({ publish: { ...s.world.town.get().publish!, lastPushAt: "2026-11-04T18:00:00.000Z", lastPushError: "git push: denied" } });
    const h = await json(s.app, "GET", "/api/health");
    expect(h.body.export).toMatchObject({ commit: "abc1234", lastPushAt: "2026-11-04T18:00:00.000Z", pushError: "git push: denied" });
    expect(h.body.export.lastAt).toEqual(expect.any(String));
  });
});
