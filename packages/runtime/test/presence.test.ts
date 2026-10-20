import { describe, expect, it } from "vitest";
import { OFFER_TTL_MS } from "@agent-town/core";
import { init, result, setup } from "./helpers.ts";

describe("v1.4 runtime presence tick", () => {
  it("tickOnce marks quiet visitors offline (every 30 s), never residents; a call brings them back", async () => {
    const { world, seed, runtime, clock, by } = setup(async function* () { yield init(); yield result(10, 0.001); });
    const v = world.ops.registerVisitor(seed.admin.id, { name: "Away Claude" }).agent;
    world.presence.touch(v.id);
    clock.t = Date.now() + 30_000;
    await runtime.tickOnce();
    expect(world.agents.require(v.id).status).toBe("idle");
    clock.t = Date.now() + 45_000;
    await runtime.tickOnce(); // < 30 s since the last presence pass: skipped
    expect(world.agents.require(v.id).status).toBe("idle");
    clock.t = Date.now() + 121_000;
    await runtime.tickOnce();
    expect(world.agents.require(v.id).status).toBe("offline");
    expect(world.agents.where("kind = 'resident' AND status = 'offline'")).toHaveLength(0);
    expect(by("Ravi").status).not.toBe("offline");
    // back
    world.presence.touch(v.id);
    const back = world.agents.require(v.id);
    expect(back.status).toBe("idle");
    expect(world.events.recent({ agentId: v.id, limit: 5 }).some((e) => e.type === "agent.status" && e.text === "Away Claude is back")).toBe(true);
    await runtime.whenIdle();
  });

  it("the scheduler never starts an offer; the presence pass expires it after 24 h", async () => {
    const { world, seed, runtime, sdk, clock } = setup(async function* () { yield init(); yield result(10, 0.001); });
    const avatar = world.ops.ensureAvatar(seed.admin.id);
    const v = world.ops.registerVisitor(seed.admin.id, { name: "Offer Claude", buildingId: "carbon-cycle" }).agent;
    const a = world.ops.createWork(avatar, v.id, { title: "Have a look" });
    expect(a.offered).toBe(true);
    world.presence.touch(v.id);
    clock.t = Date.now();
    await runtime.tickOnce();
    await runtime.whenIdle();
    expect(sdk.sessions.filter((s) => s.agentId === v.id)).toHaveLength(0);
    expect(world.assignments.require(a.id).status).toBe("pending");
    clock.t = Date.now() + OFFER_TTL_MS + 60_000;
    const r = runtime.presenceTick();
    expect(r.expiredOffers).toEqual([a.id]);
    expect(r.offline).toEqual([v.id]);
    expect(world.assignments.require(a.id).status).toBe("cancelled");
    expect(world.ops.intray("carbon-cycle").some((d) => d.title === "Offer Claude didn't pick up: Have a look")).toBe(true);
  });
});
