import { describe, it, expect } from "vitest";
import { World, buildingRoleId } from "@muster-town/core";
import { fundingForSession } from "../src/session.ts";

/** A lab with a proposed grant, a member's own API-key input, and the town's input keeping the pool funded. */
function setup() {
  const world = World.open(":memory:");
  const seed = world.seedDefaults({ adminName: "T", importDir: new URL("../../../buildings/carbon-cycle", import.meta.url).pathname });
  const bid = seed.lab!.id;
  const admin = world.ops.ensureAvatar(seed.admin.id);
  for (const a of world.allocations.where("buildingId = ?", [bid])) world.budget.retire(a.id);
  const manager = world.agents.first("homeBuildingId = ? AND kind != 'human'", [bid])!;
  world.permissions.grant(manager, buildingRoleId(bid, "manager"));
  const kr = world.grantDesk.createKeyResult(admin, bid, { text: "A banner", howToCheck: "Open the lab" });
  const mk = () => {
    const g = world.grantDesk.create(manager, bid, { keyResultId: kr.id, objective: "Banner", approach: "a line", stopCondition: "two tries", askTokens: 20_000, testingPlan: [] });
    world.grantDesk.propose(manager, g.id);
    return g;
  };
  world.bank.addInput(seed.admin.id, { label: "Town key", source: "api-key", model: "m", tokens: 1_000_000, apiKey: "sk-town" } as never);
  const user = world.ops.createUser("Member").user;
  const member = world.ops.ensureAvatar(user.id);
  const input = world.bank.addInput(user.id, { label: "Member key", source: "api-key", model: "m", tokens: 50_000, apiKey: "sk-member" } as never);
  return { world, admin, manager, member, input, mk };
}

describe("fundingForSession (member funding)", () => {
  it("a member-funded grant's session runs on the member's key; a pool-funded one keeps the pool's key", () => {
    const { world, admin, manager, member, input, mk } = setup();
    const env = { ANTHROPIC_API_KEY: "" } as NodeJS.ProcessEnv;
    const mine = mk(), pool = mk();
    world.grantDesk.decide(member, mine.id, { action: "fund", fundWith: input.id });
    world.grantDesk.decide(admin, pool.id, { action: "fund" });
    const work = (grantId: string) => world.ops.createWork(admin, manager.id, { title: "Step", lane: "grant", grantId }).id;
    expect(fundingForSession(world, manager.id, work(mine.id), env)).toMatchObject({ auth: "api-key", apiKey: "sk-member", inputId: input.id, allocationId: null });
    const p = fundingForSession(world, manager.id, work(pool.id), env);
    expect(p).toMatchObject({ auth: "api-key", apiKey: "sk-town" });
    expect(p.inputId).toBeUndefined();
    // the started session names the input it ran on
    const asg = work(mine.id);
    const f = fundingForSession(world, manager.id, asg, env);
    world.ops.startSession(manager.id, { purpose: "work", model: "m", assignmentId: asg, funding: f.auth, inputId: f.inputId });
    const ev = world.events.list({ types: ["session.started"] }).at(-1)!;
    expect(ev.payload).toMatchObject({ inputId: input.id, grantId: mine.id, funding: "api-key" });
    expect(ev.text).toMatch(/funded by Member key's API key/);
    // a cancelled input falls back to the pool's key
    world.bank.cancelInput(member.ownerUserId!, input.id);
    expect(fundingForSession(world, manager.id, work(mine.id), env)).toMatchObject({ apiKey: "sk-town" });
    world.close();
  });
});
