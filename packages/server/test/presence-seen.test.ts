import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { json, seededApp } from "./helpers.ts";

let ctx: Awaited<ReturnType<typeof seededApp>>;
beforeAll(async () => { ctx = await seededApp(); });
afterAll(async () => { await ctx.close(); });

describe("any authenticated agent REST call stamps lastSeenAt (dc_wxs73nuq93: the CI visitor only calls REST)", () => {
  it("an offline visitor's plain REST call stamps lastSeenAt and leaves it offline (no back transition)", async () => {
    const v = ctx.world.ops.registerVisitor(ctx.seed.admin.id, { name: "REST Caller", inheritsOwner: false });
    const old = new Date(Date.now() - 8 * 24 * 3_600_000).toISOString();
    ctx.world.agents.upsert({ ...ctx.world.agents.require(v.agent.id), lastSeenAt: old }, { silent: true });
    ctx.world.presence.sweep();
    const before = ctx.world.agents.require(v.agent.id);
    expect(before.status).toBe("offline");
    const t = Date.now();
    const r = await json(ctx.app, "GET", "/api/me", { headers: { authorization: `Bearer ${v.token}` } });
    expect(r.status).toBeLessThan(500);
    const after = ctx.world.agents.require(v.agent.id);
    expect(after.status).toBe("offline");
    expect(Date.parse(after.lastSeenAt!)).toBeGreaterThanOrEqual(t);
  });
});
