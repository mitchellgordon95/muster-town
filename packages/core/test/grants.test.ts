import { describe, expect, it } from "vitest";
import { buildingRoleId, newId, nowIso } from "../src/index.ts";
import { GrantStatus, stoplightOf } from "@muster-town/schema";
import { fundGoalOf, seededWorld } from "./helpers.ts";

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
  const admin = s.admin;
  const draft = (keyResults = [KRS[0]!]) => world.grantDesk.create(manager, LAB, { keyResults, objective: "Visitors can tell what the lab is for", approach: "a banner line", stopCondition: "two failed tries", askTokens: 10_000_000 });
  const charge = (grantId: string, tokens: number, lane: "grant" | "exploration" = "grant") => world.sessions.upsert({
    id: newId("se"), agentId: manager.id, assignmentId: null, meetingId: null, purpose: "work", backend: "host", status: "done", model: "m",
    sdkSessionId: null, output: tokens, costUsd: 0, startedAt: nowIso(), endedAt: nowIso(), lane, grantId: lane === "grant" ? grantId : null,
  } as never);
  return { ...s, admin, manager, draft, charge };
}

describe("grants service", () => {
  it("manager drafts, edits and proposes; drafts are hidden from the public list; funders get an inbox note", () => {
    const { world, manager, admin, draft } = setup();
    const g = draft();
    expect(g.status).toBe("draft");
    expect(g).toMatchObject({ keyResultId: g.keyResult?.id, approach: "a banner line", goalId: world.goalTree.attachmentOf(LAB) });
    expect(g.keyResult?.text).toBe(KRS[0]!.text);
    // the grant's own key results: under its goal, naming it
    expect(g.keyResults.map((k) => [k.text, k.grantId, k.goalId, k.status])).toEqual([[KRS[0]!.text, g.id, g.goalId, "not-started"]]);
    expect(world.keyResults.require(g.keyResultId!)).toMatchObject({ grantId: g.id, goalId: g.goalId, buildingId: LAB });
    expect(world.grantDesk.list(LAB)).toHaveLength(0);
    expect(world.grantDesk.list(LAB, { includeDrafts: true })).toHaveLength(1);
    const edited = world.grantDesk.update(manager, g.id, { askTokens: 12_000_000, keyResults: [...KRS, { text: "third", howToCheck: "look", due: "2026-12-31" }] });
    expect(edited.askTokens).toBe(12_000_000);
    // keyResults replaces the list; the first is the grant's keyResultId
    expect(edited.keyResults.map((k) => k.text)).toEqual([...KRS.map((k) => k.text), "third"]);
    expect(edited.keyResults[2]!.due).toBe("2026-12-31");
    expect(edited.keyResultId).toBe(edited.keyResults[0]!.id);
    expect(world.keyResults.get(g.keyResultId!)).toBeUndefined();
    expect(() => world.grantDesk.update(manager, g.id, { keyResults: [] })).toThrow();
    expect(() => world.grantDesk.create(manager, LAB, { keyResults: [1, 2, 3, 4, 5, 6].map((i) => ({ text: `k${i}`, howToCheck: "h" })), objective: "o", stopCondition: "s", askTokens: 1 })).toThrow();
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
    world.grantDesk.update(manager, g.id, { note: "sharpened", keyResults: KRS });
    world.grantDesk.propose(manager, g.id);
    const f = world.grantDesk.decide(admin, g.id, { action: "fund" });
    expect(f).toMatchObject({ status: "funded", grantTokens: 6_000_000, fundedBy: admin.ownerUserId, spentTokens: 0 });
    expect(f.history.map((h) => [h.action, h.byKind])).toEqual([["propose", "agent"], ["counter", "user"], ["edit", "agent"], ["propose", "agent"], ["fund", "user"]]);
    expect(world.grantDesk.board(LAB)).toMatchObject({ proposals: [], grants: [{ id: g.id }] });
    expect(() => world.grantDesk.decide(admin, g.id, { action: "fund" })).toThrow(/funded grant/);
  });

  it("reject closes the proposal, archives its key results and frees the slot", () => {
    const { world, manager, admin, draft } = setup();
    const g = world.grantDesk.propose(manager, draft(KRS).id);
    expect(world.grantDesk.decide(admin, g.id, { action: "reject", note: "not now" }).status).toBe("rejected");
    for (const k of world.grantDesk.keyResultsOf(g.id)) expect(k.archivedAt).toBeTruthy();
    expect(world.grantDesk.keyResultsOf(g.id)).toHaveLength(2);
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

  it("several live grants run side by side; liveGrantOf is the live grant a key result belongs to", () => {
    const { world, manager, admin, draft } = setup();
    const first = world.grantDesk.decide(admin, world.grantDesk.propose(manager, draft().id).id, { action: "fund" });
    const second = world.grantDesk.propose(manager, draft().id);
    expect(world.grantDesk.liveGrantOf(second.keyResultId!)).toBeUndefined(); // proposed: not live
    expect(world.grantDesk.decide(admin, second.id, { action: "fund" }).status).toBe("funded");
    expect(world.grantDesk.liveGrantOf(first.keyResultId!)?.id).toBe(first.id);
    expect(world.grantDesk.liveGrantOf(second.keyResultId!)?.id).toBe(second.id);
    world.grants.patch(first.id, { status: "checkpoint" });
    expect(world.grantDesk.liveGrantOf(first.keyResultId!)?.id).toBe(first.id);
    world.grantDesk.decide(admin, first.id, { action: "cut" });
    expect(world.grantDesk.liveGrantOf(first.keyResultId!)).toBeUndefined();
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

  it("a grant's key results: only humans (or the building's own manager agent) edit the words; manager sets status up to claimed, only funders set or undo met / missed", () => {
    const { world, manager, admin, draft } = setup();
    const d = draft(KRS);
    const krs = d.keyResults;
    expect(() => world.grantDesk.updateKeyResult(manager, krs[0]!.id, { text: "x" })).toThrow(/Only a human/);
    expect(world.grantDesk.updateKeyResult(admin, krs[0]!.id, { text: "sharper" }).text).toBe("sharper");
    expect(world.grantDesk.keyResults(LAB).map((k) => k.grantId)).toEqual([d.id, d.id]);
    const kr = krs[0]!;
    expect(world.grantDesk.updateKeyResult(manager, kr.id, { status: "claimed", note: "see banner" }).status).toBe("claimed");
    expect(() => world.grantDesk.updateKeyResult(manager, kr.id, { status: "met" })).toThrow(/building.fund/);
    expect(world.grantDesk.updateKeyResult(admin, kr.id, { status: "met" })).toMatchObject({ status: "met", statusBy: admin.ownerUserId });
    expect(() => world.grantDesk.updateKeyResult(manager, kr.id, { status: "on-track" })).toThrow(/building.fund/);
    const outsider = world.agents.first("homeBuildingId != ? AND kind != 'human'", [LAB]);
    if (outsider) expect(() => world.grantDesk.updateKeyResult(outsider, krs[1]!.id, { status: "at-risk" })).toThrow(/building.manage/);
    // an open grant carries it: it can't be deleted; the board shows it on the grant
    const g = world.grantDesk.decide(admin, world.grantDesk.propose(manager, d.id).id, { action: "fund" });
    expect(() => world.grantDesk.deleteKeyResult(admin, krs[1]!.id)).toThrow(/carries this key result/);
    expect(world.grantDesk.board(LAB)).toMatchObject({ blocked: null, grants: [{ id: g.id, keyResults: [{ id: kr.id }, { id: krs[1]!.id, grantId: g.id }] }] });
  });

  it("a grant without key results can't be proposed or funded", () => {
    const { world, manager, admin, draft } = setup();
    const g = draft();
    for (const k of world.grantDesk.keyResultsOf(g.id)) world.keyResults.delete(k.id);
    expect(() => world.grantDesk.propose(manager, g.id)).toThrow(/1-5 key results/);
    world.grants.patch(g.id, { status: "proposed" });
    expect(() => world.grantDesk.decide(admin, g.id, { action: "fund" })).toThrow(/carries no key results/);
  });

  it("never blocked for want of key results: no blocked state, no wake, nothing in the in-tray's blocked list", () => {
    const { world, manager } = setup();
    world.buildings.patch(LAB, { managerAgentId: manager.id });
    expect(world.grantDesk.keyResults(LAB)).toEqual([]);
    world.grantDesk.syncBlocked(LAB);
    expect(world.grantDesk.blocked(LAB)).toBeNull();
    expect(world.buildings.get(LAB)!.blockedAt ?? null).toBeNull();
    expect(world.assignments.where("agentId = ? AND title LIKE 'Get human decisions%'", [manager.id])).toHaveLength(0);
    expect(world.ops.townHallIntray().blocked).toEqual([]);
  });

  it("stoplight: null in the Town Hall; grey with no funded grant, green while funded grants run, yellow when one is held at its checkpoint", () => {
    const { world, manager, admin, draft } = setup();
    expect(world.grantDesk.stoplight(world.buildings.first("kind = 'town-hall'")!)).toBeNull();
    expect(world.grantDesk.stoplight(LAB)).toEqual({ light: "grey", reason: "no funded grant: the building explores or idles" });
    const p = world.grantDesk.propose(manager, draft().id);
    expect(world.grantDesk.board(LAB).stoplight?.light).toBe("grey"); // a proposal isn't funded
    const g1 = world.grantDesk.decide(admin, p.id, { action: "fund" });
    expect(world.grantDesk.stoplight(LAB)).toEqual({ light: "green", reason: "1 funded grant running" });
    const g0 = world.grantDesk.decide(admin, world.grantDesk.propose(manager, draft().id).id, { action: "fund" });
    expect(world.grantDesk.stoplight(LAB)).toEqual({ light: "green", reason: "2 funded grants running" });
    world.grants.patch(g1.id, { status: "checkpoint" });
    expect(world.grantDesk.stoplight(LAB)).toEqual({ light: "yellow", reason: `grant "${g1.objective}" is held at its checkpoint` });
    world.grants.patch(g0.id, { status: "closed" });
    expect(world.grantDesk.stoplight(LAB)!.light).toBe("yellow");
    expect(stoplightOf([])).toEqual({ light: "grey", reason: "no funded grant: the building explores or idles" });
    // the snapshot carries it; the Town Hall has none
    const snap = world.buildingsWithIntray();
    expect(snap.find((b) => b.id === LAB)!.stoplight?.light).toBe("yellow");
    expect(snap.find((b) => b.kind === "town-hall")!.stoplight).toBeNull();
  });

  it("exploration: uncapped by default with the free tokens under the goal, or the goal's cap; today's exploration sessions count", () => {
    const { world, admin, draft, charge } = setup();
    world.bank.addInput(admin.ownerUserId!, { label: "sub", source: "api-key", apiKey: "sk-test", model: "m", tokens: 20_000_000, recurrence: "daily" } as never);
    expect(world.grantDesk.exploration(LAB)).toEqual({ spentTodayTokens: 0, freeTokens: 20_000_000, cap: null });
    charge(draft().id, 300_000, "exploration");
    const goalId = fundGoalOf(world, LAB, { exploreCapTokensPerDay: 1_000_000 });
    expect(world.grantDesk.exploration(LAB)).toMatchObject({ spentTodayTokens: 300_000, cap: { tokensPerDay: 1_000_000, goalId, spentTodayTokens: 300_000 } });
  });
});
