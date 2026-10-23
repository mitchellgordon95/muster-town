import { randomBytes } from "node:crypto";
import { createUser } from "@muster-town/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { json, seededApp } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.unstubAllEnvs(); while (cleanups.length) await cleanups.pop()!(); });

describe("secrets routes", () => {
  it("admins set, list (never values), regrant and delete; agents and non-admins are refused", async () => {
    vi.stubEnv("MUSTER_TOWN_DATA_KEY", randomBytes(32).toString("hex"));
    const s = await seededApp();
    cleanups.push(s.close);
    const { world, app, auth } = s;
    const resident = world.agents.first("kind = 'resident'")!;
    const agentAuth = { authorization: `Bearer ${world.tokens.getOrCreate("agent", resident.id)}` };
    const { token } = createUser(world, "Stranger");
    const userAuth = { authorization: `Bearer ${token}` };

    const put = await json(app, "PUT", "/api/secrets/MINICLAW_WS_TOKEN", { headers: auth, body: { value: "ws-secret", grants: { skills: [] } } });
    expect(put.status).toBe(200);
    expect(put.body.secret).toMatchObject({ name: "MINICLAW_WS_TOKEN", set: true });
    const list = await json(app, "GET", "/api/secrets", { headers: auth });
    expect(list.body).toMatchObject({ keyConfigured: true, secrets: [{ name: "MINICLAW_WS_TOKEN", set: true }] });
    expect(JSON.stringify(list.body)).not.toContain("ws-secret");
    const regrant = await json(app, "PUT", "/api/secrets/MINICLAW_WS_TOKEN", { headers: auth, body: { grants: { agents: [resident.id] } } });
    expect(regrant.body.secret).toMatchObject({ set: true, grants: { agents: [resident.id], buildings: [], skills: [] } });
    expect(world.secrets.forAgent(resident.id).map((x) => x.value)).toEqual(["ws-secret"]);

    for (const h of [agentAuth, userAuth, {}]) {
      expect((await json(app, "GET", "/api/secrets", { headers: h })).status).toBeGreaterThanOrEqual(401);
      expect((await json(app, "PUT", "/api/secrets/X_KEY", { headers: h, body: { value: "v" } })).status).toBeGreaterThanOrEqual(401);
    }
    expect((await json(app, "PUT", "/api/secrets/GH_OTHER", { headers: auth, body: { value: "v" } })).status).toBe(400); // GH_TOKEN itself is allowed: the collective repo token
    expect((await json(app, "DELETE", "/api/secrets/MINICLAW_WS_TOKEN", { headers: auth })).body).toEqual({ removed: true });
    expect((await json(app, "GET", "/api/secrets", { headers: auth })).body.secrets).toEqual([]);
  });

  it("without a data key a value is refused (409), never stored", async () => {
    vi.stubEnv("MUSTER_TOWN_DATA_KEY", "");
    vi.stubEnv("AGENT_TOWN_DATA_KEY", "");
    const s = await seededApp();
    cleanups.push(s.close);
    const r = await json(s.app, "PUT", "/api/secrets/A_KEY", { headers: s.auth, body: { value: "v" } });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/MUSTER_TOWN_DATA_KEY/);
    expect((await json(s.app, "GET", "/api/secrets", { headers: s.auth })).body).toEqual({ secrets: [], keyConfigured: false });
  });
});
