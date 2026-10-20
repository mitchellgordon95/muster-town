/** v1.3: POST /api/admin/redeploy needs `town.redeploy` (admin, or the town `deployer` role). */
import { townRoleId } from "@muster-town/core";
import { afterEach, describe, expect, it } from "vitest";
import { json, seededApp } from "./helpers.ts";

let close: (() => Promise<void>) | null = null;
afterEach(async () => { await close?.(); close = null; });

describe("POST /api/admin/redeploy", () => {
  it("checks town.redeploy, then hands off to the runtime", async () => {
    const calls: { image: boolean; requestedBy: string }[] = [];
    let running = false;
    const t = await seededApp({ runtime: {
      chat: async () => "", interrupt: async () => undefined,
      redeploy: (o) => { calls.push(o); if (running) return { running: true }; running = true; return { started: true }; },
    } });
    close = t.close;
    const noor = t.by("Noor");
    const agentAuth = { authorization: `Bearer ${t.world.tokens.getOrCreate("agent", noor.id)}` };

    const denied = await json(t.app, "POST", "/api/admin/redeploy", { headers: agentAuth, body: {} });
    expect(denied.status).toBe(403);
    expect(calls).toHaveLength(0);

    t.world.permissions.grant(noor, townRoleId("deployer"));
    const ok = await json(t.app, "POST", "/api/admin/redeploy", { headers: agentAuth, body: { image: true } });
    expect(ok.status).toBe(202);
    expect(ok.body).toEqual({ started: true });
    expect(calls[0]).toEqual({ image: true, requestedBy: "Noor" });

    // admin holds every permission; a second request while one runs gets { running: true }
    const again = await json(t.app, "POST", "/api/admin/redeploy", { headers: t.auth, body: {} });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ running: true });
    expect(calls[1]!.image).toBe(false);

    expect((await json(t.app, "POST", "/api/admin/redeploy", { body: {} })).status).toBe(401);
  });

  it("503 without a runtime", async () => {
    const t = await seededApp();
    close = t.close;
    expect((await json(t.app, "POST", "/api/admin/redeploy", { headers: t.auth, body: {} })).status).toBe(503);
  });
});
