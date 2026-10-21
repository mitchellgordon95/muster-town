import { describe, expect, it } from "vitest";
import { buildingRoleId, newId, nowIso } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const KRS = [
  { text: "A visitor can see today's spend on the banner", howToCheck: "Open the lab banner, read Usage" },
  { text: "The board shows the lab's goal first", howToCheck: "Open the lab board" },
];

function setup() {
  const s = seededWorld();
  const { world } = s;
  const manager = world.agents.first("homeBuildingId = ? AND kind != 'human'", [LAB])!;
  world.permissions.grant(manager, buildingRoleId(LAB, "manager"));
  const draft = () => world.grantDesk.create(manager, LAB, { objective: "Visitors can tell what the lab is for", stopCondition: "two failed tries", askTokens: 10_000_000, keyResults: KRS });
  const charge = (grantId: string, tokens: number, lane: "grant" | "exploration" = "grant") => world.sessions.upsert({
    id: newId("se"), agentId: manager.id, assignmentId: null, meetingId: null, purpose: "work", backend: "host", status: "done", model: "m",
    sdkSessionId: null, tokens, costUsd: 0, startedAt: nowIso(), endedAt: nowIso(), lane, grantId: lane === "grant" ? grantId : null,
  } as never);
  return { ...s, manager, draft, charge };
}

describe("grants service", () => {
  it("manager drafts, edits and proposes; drafts are hidden from the public list; funders get an inbox note", () => {
    const { world, manager, admin, draft } = setup();
    const g = draft();
    expect(g.status).toBe("draft");
    expect(g.keyResults.map((k) => k.position)).toEqual([0, 1]);
    expect(world.grantDesk.list(LAB)).toHaveLength(0);
    expect(world.grantDesk.list(LAB, { includeDrafts: true })).toHaveLength(1);
    const edited = world.grantDesk.update(manager, g.id, { askTokens: 12_000_000, keyResults: [...KRS, { text: "third", howToCheck: "look" }] });
    expect(edited.askTokens).toBe(12_000_000);
    expect(edited.keyResults).toHaveLength(3);
    const p = world.grantDesk.propose(manager, g.id);
    expect(p.status).toBe("proposed");
    expect(p.history.map((h) => h.action)).toEqual(["propose"]);
    expect(world.messages.where("toId = ? AND kind = 'system'", [admin.id]).some((m) => m.body.includes("proposed"))).toBe(true);
    expect(world.grantDesk.board(LAB).proposal?.id).toBe(g.id);
    // one open proposal per building
    const g2 = draft();
    expect(() => world.grantDesk.propose(manager, g2.id)).toThrow(/open proposal/);
    // can't edit once proposed
    expect(() => world.grantDesk.update(manager, g.id, { askTokens: 1 })).toThrow(/proposed grant/);
  });

  it("only a human with building.fund decides: counter → edit → propose → fund", () => {
    const { world, manager, admin, draft } = setup();
    const g = world.grantDesk.propose(manager, draft().id);
    expect(() => world.grantDesk.decide(manager, g.id, { action: "fund" })).toThrow(/building.fund/);
    expect(() => world.grantDesk.decide(admin, g.id, { action: "counter" })).toThrow(/note/);
    const c = world.grantDesk.decide(admin, g.id, { action: "counter", tokens: 6_000_000, note: "half, and sharper KRs" });
    expect(c.status).toBe("countered");
    expect(c.askTokens).toBe(6_000_000);
    expect(world.messages.where("toId = ?", [manager.id]).some((m) => m.body.includes("countered"))).toBe(true);
    world.grantDesk.update(manager, g.id, { note: "sharpened", keyResults: KRS });
    world.grantDesk.propose(manager, g.id);
    const f = world.grantDesk.decide(admin, g.id, { action: "fund" });
    expect(f).toMatchObject({ status: "funded", grantTokens: 6_000_000, fundedBy: admin.ownerUserId, spentTokens: 0 });
    expect(f.history.map((h) => [h.action, h.byKind])).toEqual([["propose", "agent"], ["counter", "user"], ["edit", "agent"], ["propose", "agent"], ["fund", "user"]]);
    expect(world.grantDesk.board(LAB)).toMatchObject({ proposal: null, grants: [{ id: g.id }] });
    expect(() => world.grantDesk.decide(admin, g.id, { action: "fund" })).toThrow(/funded grant/);
  });

  it("reject closes the proposal and frees the slot", () => {
    const { world, manager, admin, draft } = setup();
    const g = world.grantDesk.propose(manager, draft().id);
    expect(world.grantDesk.decide(admin, g.id, { action: "reject", note: "not now" }).status).toBe("rejected");
    expect(world.grantDesk.propose(manager, draft().id).status).toBe("proposed");
  });

  it("spend is derived from sessions; checkpoint decisions continue / adjust / cut", () => {
    const { world, manager, admin, draft, charge } = setup();
    const g = world.grantDesk.decide(admin, world.grantDesk.propose(manager, draft().id).id, { action: "fund", tokens: 4_000_000 });
    charge(g.id, 2_500_000);
    expect(world.grantDesk.get(g.id).spentTokens).toBe(2_500_000);
    expect(() => world.grantDesk.decide(admin, g.id, { action: "continue" })).toThrow(/checkpoint/);
    // step 2 sets checkpoint from Budget.charge; here by hand
    world.grants.patch(g.id, { status: "checkpoint", checkpointsDone: [0.5] });
    expect(world.grantDesk.decide(admin, g.id, { action: "continue", note: "on track" }).status).toBe("funded");
    world.grants.patch(g.id, { status: "checkpoint" });
    expect(() => world.grantDesk.decide(admin, g.id, { action: "adjust", tokens: 2_000_000 })).toThrow(/more than that/);
    const a = world.grantDesk.decide(admin, g.id, { action: "adjust", tokens: 8_000_000, stopCondition: "one more try" });
    expect(a).toMatchObject({ status: "funded", grantTokens: 8_000_000, stopCondition: "one more try", checkpointsDone: [] });
    charge(g.id, 6_000_000);
    world.grants.patch(g.id, { status: "checkpoint", checkpointsDone: [0.5, 1] });
    expect(() => world.grantDesk.decide(admin, g.id, { action: "continue" })).toThrow(/fully spent/);
    expect(world.grantDesk.decide(admin, g.id, { action: "cut" })).toMatchObject({ status: "closed", outcome: "cut" });
  });

  it("close: the manager only as stopped; funders any outcome; proposals can only be withdrawn", () => {
    const { world, manager, admin, draft } = setup();
    const d = draft();
    expect(() => world.grantDesk.close(manager, d.id, { outcome: "met" })).toThrow(/stopped/);
    expect(world.grantDesk.close(manager, d.id, { outcome: "stopped", note: "withdrawn" }).status).toBe("closed");
    expect(() => world.grantDesk.close(manager, d.id, { outcome: "stopped" })).toThrow(/already closed/);
    const g = world.grantDesk.decide(admin, world.grantDesk.propose(manager, draft().id).id, { action: "fund" });
    expect(world.grantDesk.close(admin, g.id, { outcome: "met" })).toMatchObject({ status: "closed", outcome: "met" });
  });

  it("key results: manager up to claimed, only funders set or undo met / missed, only on live grants", () => {
    const { world, manager, admin, draft } = setup();
    const p = world.grantDesk.propose(manager, draft().id);
    const kr = p.keyResults[0]!;
    expect(() => world.grantDesk.updateKeyResult(manager, kr.id, { status: "on-track" })).toThrow(/funded grant/);
    world.grantDesk.decide(admin, p.id, { action: "fund" });
    expect(world.grantDesk.updateKeyResult(manager, kr.id, { status: "claimed", note: "see banner" }).status).toBe("claimed");
    expect(() => world.grantDesk.updateKeyResult(manager, kr.id, { status: "met" })).toThrow(/building.fund/);
    expect(world.grantDesk.updateKeyResult(admin, kr.id, { status: "met" })).toMatchObject({ status: "met", statusBy: admin.ownerUserId });
    expect(() => world.grantDesk.updateKeyResult(manager, kr.id, { status: "on-track" })).toThrow(/building.fund/);
    const outsider = world.agents.first("homeBuildingId != ? AND kind != 'human'", [LAB]);
    if (outsider) expect(() => world.grantDesk.updateKeyResult(outsider, p.keyResults[1]!.id, { status: "at-risk" })).toThrow(/building.manage/);
  });

  it("exploration: 10% of the pool's daily inflow by default, or the building's setting; today's exploration sessions count", () => {
    const { world, admin, draft, charge } = setup();
    world.bank.addInput(admin.ownerUserId!, { label: "sub", source: "api-key", apiKey: "sk-test", model: "m", tokens: 20_000_000, recurrence: "daily" } as never);
    const inflow = world.bank.poolDailyInflow(world.bank.poolOf(LAB).id);
    expect(world.grantDesk.exploration(LAB)).toEqual({ allowanceTokens: Math.floor(inflow * 0.1), spentTodayTokens: 0 });
    charge(draft().id, 300_000, "exploration");
    world.ops.updateBuilding(admin, LAB, { explorationTokensPerDay: 1_000_000 });
    expect(world.grantDesk.exploration(LAB)).toEqual({ allowanceTokens: 1_000_000, spentTodayTokens: 300_000 });
  });
});
