import { describe, expect, it } from "vitest";
import { buildingRoleId, newId, nowIso } from "../src/index.ts";
import { GrantStatus, stoplightOf } from "@muster-town/schema";
import { fundGoalOf, seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const KRS = [
  { text: "A visitor can see today's spend on the banner", howToCheck: "Open the lab banner, read Usage" },
  { text: "The board shows the lab's goal first", howToCheck: "Open the lab board" },
];
const PLAN = [{ text: "Banner shows Usage", howToCheck: "Open the lab banner" }];

function setup() {
  const s = seededWorld();
  const { world } = s;
  const manager = world.agents.first("homeBuildingId = ? AND kind != 'human'", [LAB])!;
  world.permissions.grant(manager, buildingRoleId(LAB, "manager"));
  const admin = s.admin;
  const krs = KRS.map((k) => world.grantDesk.createKeyResult(admin, LAB, k));
  const draft = (keyResultId = krs[0]!.id) => world.grantDesk.create(manager, LAB, { keyResultId, objective: "Visitors can tell what the lab is for", approach: "a banner line", stopCondition: "two failed tries", askTokens: 10_000_000, testingPlan: PLAN });
  const charge = (grantId: string, tokens: number, lane: "grant" | "exploration" = "grant") => world.sessions.upsert({
    id: newId("se"), agentId: manager.id, assignmentId: null, meetingId: null, purpose: "work", backend: "host", status: "done", model: "m",
    sdkSessionId: null, output: tokens, costUsd: 0, startedAt: nowIso(), endedAt: nowIso(), lane, grantId: lane === "grant" ? grantId : null,
  } as never);
  return { ...s, manager, krs, draft, charge };
}

describe("grants service", () => {
  it("manager drafts, edits and proposes; drafts are hidden from the public list; funders get an inbox note", () => {
    const { world, manager, admin, draft } = setup();
    const g = draft();
    expect(g.status).toBe("draft");
    expect(g).toMatchObject({ keyResultId: g.keyResult?.id, approach: "a banner line", testingPlan: PLAN });
    expect(g.keyResult?.text).toBe(KRS[0]!.text);
    expect(world.grantDesk.list(LAB)).toHaveLength(0);
    expect(world.grantDesk.list(LAB, { includeDrafts: true })).toHaveLength(1);
    const edited = world.grantDesk.update(manager, g.id, { askTokens: 12_000_000, testingPlan: [...PLAN, { text: "third", howToCheck: "look" }] });
    expect(edited.askTokens).toBe(12_000_000);
    expect(edited.testingPlan).toHaveLength(2);
    expect(() => world.grantDesk.update(manager, g.id, { keyResultId: "kr_nope" })).toThrow(/not a key result/);
    const p = world.grantDesk.propose(manager, g.id);
    expect(p.status).toBe("proposed");
    expect(p.history.map((h) => h.action)).toEqual(["propose"]);
    expect(world.messages.where("toId = ? AND kind = 'system'", [admin.id]).some((m) => m.body.includes("proposed"))).toBe(true);
    expect(world.grantDesk.board(LAB).proposals.map((x) => x.id)).toEqual([g.id]);
    // several open proposals per building, each on its own (newest first on the board)
    const g2 = draft();
    expect(world.grantDesk.propose(manager, g2.id).status).toBe("proposed");
    expect(world.grantDesk.board(LAB).proposals.map((x) => x.id)).toEqual([g2.id, g.id]);
    world.grantDesk.close(manager, g2.id, { outcome: "stopped" });
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
    world.grantDesk.update(manager, g.id, { note: "sharpened", testingPlan: PLAN });
    world.grantDesk.propose(manager, g.id);
    const f = world.grantDesk.decide(admin, g.id, { action: "fund" });
    expect(f).toMatchObject({ status: "funded", grantTokens: 6_000_000, fundedBy: admin.ownerUserId, spentTokens: 0 });
    expect(f.history.map((h) => [h.action, h.byKind])).toEqual([["propose", "agent"], ["counter", "user"], ["edit", "agent"], ["propose", "agent"], ["fund", "user"]]);
    expect(world.grantDesk.board(LAB)).toMatchObject({ proposals: [], grants: [{ id: g.id }] });
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

  it("refuses funding a second live grant on a key result", () => {
    const { world, manager, admin, krs, draft } = setup();
    const first = world.grantDesk.decide(admin, world.grantDesk.propose(manager, draft().id).id, { action: "fund" });
    // proposing on a key result with a live grant is fine: the proposal waits in the in-tray
    const second = world.grantDesk.propose(manager, draft().id);
    expect(second.status).toBe("proposed");
    for (const status of ["funded", "checkpoint"] as const) {
      world.grants.patch(first.id, { status });
      expect(() => world.grantDesk.decide(admin, second.id, { action: "fund" })).toThrow(new RegExp(`live grant ${first.id}`));
    }
    expect(world.grantDesk.get(second.id).status).toBe("proposed");
    expect(world.grantDesk.liveGrantOf(krs[0]!.id)?.id).toBe(first.id);
    // once the live grant closes, the waiting proposal can be funded
    world.grantDesk.decide(admin, first.id, { action: "cut" });
    expect(world.grantDesk.decide(admin, second.id, { action: "fund" }).status).toBe("funded");
    expect(world.grantDesk.liveGrantOf(krs[0]!.id)?.id).toBe(second.id);
  });

  it("refuses adjust to tokens at or below the grant's spend", () => {
    const { world, manager, admin, draft, charge } = setup();
    const g = world.grantDesk.decide(admin, world.grantDesk.propose(manager, draft().id).id, { action: "fund", tokens: 4_000_000 });
    charge(g.id, 4_000_000);
    world.grants.patch(g.id, { status: "checkpoint", checkpointsDone: [0.5, 1] });
    for (const tokens of [1, 3_999_999, 4_000_000]) {
      expect(() => world.grantDesk.decide(admin, g.id, { action: "adjust", tokens })).toThrow(/more than that/);
    }
    expect(() => world.grantDesk.decide(admin, g.id, { action: "adjust" })).toThrow(/more than that/); // the default keeps grantTokens = spend
    expect(world.grantDesk.get(g.id)).toMatchObject({ status: "checkpoint", grantTokens: 4_000_000 });
    expect(world.grantDesk.decide(admin, g.id, { action: "adjust", tokens: 4_000_001 })).toMatchObject({ status: "funded", grantTokens: 4_000_001 });
  });

  it("every grant status × action: only the legal transitions pass", () => {
    const LEGAL: Record<string, GrantStatus[]> = {
      propose: ["draft", "countered"],
      fund: ["proposed"], counter: ["proposed"], reject: ["proposed"],
      continue: ["checkpoint"], adjust: ["checkpoint"], cut: ["checkpoint"],
    };
    const AFTER: Record<string, GrantStatus> = { propose: "proposed", fund: "funded", counter: "countered", reject: "rejected", continue: "funded", adjust: "funded", cut: "closed" };
    const { world, manager, admin, draft, charge } = setup();
    for (const status of GrantStatus.options) {
      for (const action of Object.keys(LEGAL)) {
        const g = draft();
        // a grant that has been funded for 1M tokens and spent 100k, so continue/adjust aren't refused for spend
        world.grants.patch(g.id, { status, grantTokens: 1_000_000 });
        charge(g.id, 100_000);
        const act = () => action === "propose"
          ? world.grantDesk.propose(manager, g.id)
          : world.grantDesk.decide(admin, g.id, { action: action as "fund", tokens: action === "adjust" ? 2_000_000 : undefined, note: "n" });
        if (LEGAL[action]!.includes(status)) expect(act().status, `${status} × ${action}`).toBe(AFTER[action]);
        else expect(act, `${status} × ${action}`).toThrow(/grant can't be/);
        world.grants.patch(g.id, { status: "closed" }); // keeps the key result free of live grants for the next case
      }
    }
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

  it("goal key results: only humans (or the building's own manager agent) write them; manager sets status up to claimed, only funders set or undo met / missed", () => {
    const { world, manager, admin, krs, draft } = setup();
    expect(() => world.grantDesk.createKeyResult(manager, LAB, { text: "x", howToCheck: "y" })).toThrow(/Only a human/);
    expect(() => world.grantDesk.updateKeyResult(manager, krs[0]!.id, { text: "x" })).toThrow(/Only a human/);
    expect(world.grantDesk.updateKeyResult(admin, krs[0]!.id, { text: "sharper" }).text).toBe("sharper");
    expect(world.grantDesk.keyResults(LAB).map((k) => [k.position, k.grantId])).toEqual([[0, null], [1, null]]);
    const kr = krs[0]!;
    expect(world.grantDesk.updateKeyResult(manager, kr.id, { status: "claimed", note: "see banner" }).status).toBe("claimed");
    expect(() => world.grantDesk.updateKeyResult(manager, kr.id, { status: "met" })).toThrow(/building.fund/);
    expect(world.grantDesk.updateKeyResult(admin, kr.id, { status: "met" })).toMatchObject({ status: "met", statusBy: admin.ownerUserId });
    expect(() => world.grantDesk.updateKeyResult(manager, kr.id, { status: "on-track" })).toThrow(/building.fund/);
    const outsider = world.agents.first("homeBuildingId != ? AND kind != 'human'", [LAB]);
    if (outsider) expect(() => world.grantDesk.updateKeyResult(outsider, krs[1]!.id, { status: "at-risk" })).toThrow(/building.manage/);
    // a grant names it: it can't be deleted; once funded the goal view shows the grant on it
    const g = world.grantDesk.decide(admin, world.grantDesk.propose(manager, draft(krs[1]!.id).id).id, { action: "fund" });
    expect(() => world.grantDesk.deleteKeyResult(admin, krs[1]!.id)).toThrow(/names this key result/);
    expect(world.grantDesk.keyResults(LAB)[1]!.grantId).toBe(g.id);
    expect(world.grantDesk.board(LAB)).toMatchObject({ blocked: null, keyResults: [{ id: kr.id }, { id: krs[1]!.id, grantId: g.id }] });
  });

  it("a grant without a goal key result can't be proposed or funded", () => {
    const { world, manager, admin, draft } = setup();
    const g = draft();
    world.grants.patch(g.id, { keyResultId: null });
    expect(() => world.grantDesk.propose(manager, g.id)).toThrow(/keyResultId/);
    world.grants.patch(g.id, { status: "proposed" });
    expect(() => world.grantDesk.decide(admin, g.id, { action: "fund" })).toThrow(/names no goal key result/);
  });

  it("blocked: a goal-directed building with no goal KRs and no funded grant; the manager is woken once per transition", () => {
    const { world, manager, admin, krs } = setup();
    world.buildings.patch(LAB, { managerAgentId: manager.id });
    const wakes = () => world.assignments.where("agentId = ? AND title LIKE 'Get human decisions%'", [manager.id]);
    expect(world.grantDesk.blocked(LAB)).toBeNull();
    world.grantDesk.deleteKeyResult(admin, krs[0]!.id);
    expect(wakes()).toHaveLength(0);
    world.grantDesk.deleteKeyResult(admin, krs[1]!.id);
    expect(world.grantDesk.blocked(LAB)).toBe("blocked: no key results to work toward");
    expect(world.buildings.get(LAB)!.blockedAt).not.toBeNull();
    expect(wakes()).toHaveLength(1);
    expect(wakes()[0]).toMatchObject({ lane: "directed", createdBy: "system", status: "pending" });
    world.grantDesk.syncBlocked(LAB);
    fundGoalOf(world, LAB, { explorationTokensPerDay: 5 });
    expect(wakes()).toHaveLength(1); // no loop while it stays blocked
    expect(world.ops.townHallIntray().blocked).toEqual([expect.objectContaining({ buildingId: LAB, reason: "blocked: no key results to work toward" })]);
    world.grantDesk.createKeyResult(admin, LAB, KRS[0]!);
    expect(world.buildings.get(LAB)!.blockedAt).toBeNull();
    expect(world.ops.townHallIntray().blocked).toEqual([]);
    world.grantDesk.deleteKeyResult(admin, world.grantDesk.keyResults(LAB)[0]!.id);
    expect(wakes()).toHaveLength(2); // a new transition wakes again
  });

  it("stoplight: null in the Town Hall; red with no KRs or no funded grant, yellow with an unfunded KR or a held grant, green when every KR has a funded grant", () => {
    const { world, manager, admin, krs, draft } = setup();
    expect(world.grantDesk.stoplight(world.buildings.first("kind = 'town-hall'")!)).toBeNull();
    expect(world.grantDesk.stoplight(LAB)).toEqual({ light: "red", reason: "no funded grant on any of its 2 key results" });
    expect(world.grantDesk.board(LAB).stoplight?.light).toBe("red");
    const g1 = world.grantDesk.decide(admin, world.grantDesk.propose(manager, draft(krs[1]!.id).id).id, { action: "fund" });
    expect(world.grantDesk.stoplight(LAB)).toEqual({ light: "yellow", reason: "1 of 2 key results has no funded grant" });
    const g0 = world.grantDesk.decide(admin, world.grantDesk.propose(manager, draft(krs[0]!.id).id).id, { action: "fund" });
    expect(world.grantDesk.stoplight(LAB)).toEqual({ light: "green", reason: "2 funded grants running on all 2 key results" });
    world.grants.patch(g1.id, { status: "checkpoint" });
    expect(world.grantDesk.stoplight(LAB)).toMatchObject({ light: "yellow", reason: expect.stringMatching(/held at its checkpoint/) });
    world.grants.patch(g0.id, { status: "closed" });
    expect(world.grantDesk.stoplight(LAB)!.reason).toMatch(/held at its checkpoint; 1 of 2 key results has no funded grant/);
    expect(stoplightOf([], [])).toEqual({ light: "red", reason: "no key results to work toward" });
    // the snapshot carries it; the Town Hall and open buildings have none
    const snap = world.buildingsWithIntray();
    expect(snap.find((b) => b.id === LAB)!.stoplight?.light).toBe("yellow");
    expect(snap.filter((b) => b.id !== LAB).every((b) => b.stoplight === null)).toBe(true);
  });

  it("exploration: 10% of the pool's daily inflow by default, or the building's setting; today's exploration sessions count", () => {
    const { world, admin, draft, charge } = setup();
    world.bank.addInput(admin.ownerUserId!, { label: "sub", source: "api-key", apiKey: "sk-test", model: "m", tokens: 20_000_000, recurrence: "daily" } as never);
    const inflow = world.bank.poolDailyInflow(world.bank.poolOf(LAB).id);
    expect(world.grantDesk.exploration(LAB)).toEqual({ allowanceTokens: Math.floor(inflow * 0.1), spentTodayTokens: 0 });
    charge(draft().id, 300_000, "exploration");
    fundGoalOf(world, LAB, { explorationTokensPerDay: 1_000_000 });
    expect(world.grantDesk.exploration(LAB)).toEqual({ allowanceTokens: 1_000_000, spentTodayTokens: 300_000 });
  });
});
