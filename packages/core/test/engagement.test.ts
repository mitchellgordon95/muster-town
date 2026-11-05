import { describe, expect, it } from "vitest";
import { applyDecision } from "../src/domain.ts";
import { decideAccess, engagement, requestAccess, upsertGithubUser } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

// Community engagement in one collective (flag dc_r7u6bkaei4): what its humans did here, counts only, never who.
describe("engagement", () => {
  it("counts humans' lines, 1:1s, flags, decisions and join steps; agents never count; the answer names nobody", async () => {
    const { world, seed, by, admin } = seededWorld();
    world.ops.updateBuilding(admin, "carbon-cycle", { managerAgentId: by("Mei").id });
    const before = engagement(world).totals;
    const { user } = upsertGithubUser(world, { id: 7001, login: "ana" });
    const req = requestAccess(world, user.id);
    decideAccess(world, { kind: "user", id: seed.admin.id }, req.id, true, world.goalTree.attachmentOf("carbon-cycle"));
    const ana = world.ops.ensureAvatar(user.id);
    await world.verbs.say(ana, { text: "hello" });
    await world.verbs.say(ana, { text: "hello again" });
    const m = world.ops.openOneOnOne(ana, "carbon-cycle");
    world.ops.meetingSay(ana, m.id, "What should I do first?");
    const flag = world.ops.plantFlag(admin, "carbon-cycle", "Please map the sinks");
    applyDecision(world, flag.id, "approve", "", { kind: "user", id: seed.admin.id });
    // an agent's own work is not engagement
    await world.verbs.say(by("Mei"), { text: "on it" });

    const e = engagement(world);
    expect(e.totals).toMatchObject({
      spoke: before.spoke + 3, oneOnOnes: before.oneOnOnes + 1, flags: before.flags + 1, decisions: before.decisions + 1,
      asked: before.asked + 1, letIn: before.letIn + 1, acted: before.acted + 1,
    });
    expect(e.totals.humans).toBeGreaterThanOrEqual(2); // ana and the admin, each once however much they did
    expect(e.totals.humans).toBeLessThanOrEqual(before.humans + 2);
    const today = e.daily.at(-1)!;
    expect(today.day).toBe(new Date().toISOString().slice(0, 10));
    expect(today.humans).toBe(e.totals.humans);
    const json = JSON.stringify(e);
    for (const id of [user.id, ana.id, seed.admin.id, admin.id, "ana"]) expect(json).not.toContain(id);
  });

  it("keeps the window: a day before it does not count", () => {
    const { world } = seededWorld();
    const later = Date.now() + 40 * 86_400_000;
    const e = engagement(world, 30, later);
    expect(e.daily).toEqual([]);
    expect(e.totals.humans).toBe(0);
  });
});
