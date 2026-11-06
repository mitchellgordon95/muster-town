import { describe, expect, it } from "vitest";
import { buildingRoleId, createAssignment, freeTokens, newId, nowIso, reviewDeck, townHallIntray, intrayCount } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const KRS = [{ text: "A visitor can read the banner", howToCheck: "Open the lab" }, { text: "The board shows the goal", howToCheck: "Open the board" }];

/** A funded-able proposal in the lab, the town's pool input, and a member with their own input. */
function setup() {
  const s = seededWorld();
  const { world, admin } = s;
  const manager = world.agents.first("homeBuildingId = ? AND kind != 'human'", [LAB])!;
  world.permissions.grant(manager, buildingRoleId(LAB, "manager"));
  world.bank.addInput(admin.ownerUserId!, { label: "Town key", source: "api-key", model: "m", tokens: 5_000_000, apiKey: "sk-town" } as never);
  const user = world.ops.createUser("Member").user;
  const member = world.ops.ensureAvatar(user.id);
  const input = world.bank.addInput(user.id, { label: "Member key", source: "api-key", model: "m", tokens: 500_000, apiKey: "sk-member" } as never);
  const proposal = () => world.grantDesk.propose(manager, world.grantDesk.create(manager, LAB, { keyResults: KRS, objective: "Banner", approach: "a line", steps: [{ title: "Step 1", description: "Do the work" }], stopCondition: "two tries", askTokens: 200_000 }).id);
  const session = (agentId: string, grantId: string, status: "running" | "done", output = 0) => world.sessions.upsert({
    id: newId("se"), agentId, assignmentId: null, meetingId: null, purpose: "work", backend: "host", status, model: "m",
    sdkSessionId: null, output, costUsd: 0, startedAt: nowIso(), endedAt: status === "done" ? nowIso() : null, lane: "grant", grantId,
  } as never);
  const goalId = world.goalTree.attachmentOf(LAB);
  const free = () => freeTokens(world, goalId).freeTokens;
  return { ...s, manager, member, input, proposal, session, free };
}

describe("Grants.stop (gr_8i952perny)", () => {
  it("only a human who can fund stops a live grant; the manager's close as stopped on it is refused, its withdraw of a proposal is not", () => {
    const { world, admin, manager, member, proposal } = setup();
    const g = proposal();
    expect(() => world.grantDesk.stop(admin, g.id, { reason: "no" })).toThrow(/proposed grant can't be stopped/);
    world.grantDesk.decide(admin, g.id, { action: "fund" });
    expect(() => world.grantDesk.stop(manager, g.id, { reason: "no" })).toThrow(/Only a human/);
    expect(() => world.grantDesk.close(manager, g.id, { outcome: "stopped", note: "no" })).toThrow(/Only a human stops/);
    expect(() => world.grantDesk.stop(member, g.id, { reason: "no" })).toThrow(/Only a human who can fund/);
    expect(() => world.grantDesk.stop(admin, g.id, { reason: "  " })).toThrow(/reason/);
    expect(world.grantDesk.get(g.id).status).toBe("funded");
    const other = proposal();
    expect(world.grantDesk.close(manager, other.id, { outcome: "stopped", note: "superseded" })).toMatchObject({ status: "closed", outcome: "stopped" });
    // a funder closing a live grant as stopped goes through stop
    expect(world.grantDesk.close(admin, g.id, { outcome: "stopped", note: "plans changed" })).toMatchObject({ status: "closed", outcome: "stopped" });
    expect(world.grantDesk.get(g.id).keyResults.every((k) => k.status === "missed" && k.statusNote === "Grant stopped: plans changed")).toBe(true);
  });

  it("one running fork and one queued assignment: the fork is interrupted, the queued one cancelled with the reason, the grant stopping until the session ends, then closed as stopped", () => {
    const { world, admin, manager, proposal, session, free } = setup();
    const g = proposal();
    world.grantDesk.decide(admin, g.id, { action: "fund" });
    const fork = world.agents.upsert({ ...manager, id: newId("ag"), name: `${manager.name} 1`, forkOf: manager.id, forkN: 1, status: "working" });
    const running = session(fork.id, g.id, "running");
    session(manager.id, g.id, "done", 30_000);
    const queued = createAssignment(world, { agentId: manager.id, title: "Step 2", description: "Do it.", createdBy: { kind: "system", id: "system" }, laneOverride: { lane: "grant", grantId: g.id, keyResultId: g.keyResultId, gap: null, sourceId: null } });
    const before = free();

    const out = world.grantDesk.stop(admin, g.id, { reason: "the plan is wrong" });
    expect(out.status).toBe("stopping");
    // the fork: interrupted with the reason, a hard stop pending
    const req = world.events.list({ agentId: fork.id, types: ["system"], payloadKey: "stopFork" });
    expect(req.map((e) => e.payload)).toEqual([expect.objectContaining({ stopFork: "requested", sessionId: running.id, by: admin.id, reason: expect.stringContaining("the plan is wrong") })]);
    expect(JSON.parse(world.town.marker("pendingForkStops")!)).toEqual([expect.objectContaining({ forkId: fork.id })]);
    // the queue: cancelled, the reason on the row; nothing new may name the grant
    expect(world.assignments.require(queued.id)).toMatchObject({ status: "cancelled", heldReason: "Grant stopped: the plan is wrong" });
    expect(() => createAssignment(world, { agentId: manager.id, title: "Step 3", description: "x", createdBy: { kind: "system", id: "system" }, lane: { lane: "grant", grantId: g.id } })).toThrow(/stopping/);
    // key results missed with the reason (no postmortem), the manager told
    expect(out.keyResults.map((k) => [k.status, k.statusNote, !!k.archivedAt])).toEqual([["missed", "Grant stopped: the plan is wrong", true], ["missed", "Grant stopped: the plan is wrong", true]]);
    expect(world.messages.where("toId = ?", [manager.id]).some((m) => m.body.includes("stopped your grant") && m.body.includes("the plan is wrong"))).toBe(true);
    // not live: its unspent rest is free again at once (200,000 granted − 30,000 spent)
    expect(free()).toBe(before + 170_000);

    // still a session running on it: the tick leaves it stopping
    expect(world.grantDesk.finishStopping()).toEqual([]);
    expect(world.grantDesk.get(g.id).status).toBe("stopping");
    // the fork files its report (its session ends, 10,000 more booked): the next tick closes it
    world.sessions.upsert({ ...running, status: "done", output: 10_000, endedAt: nowIso() } as never);
    expect(world.grantDesk.finishStopping().map((x) => x.id)).toEqual([g.id]);
    expect(world.grantDesk.get(g.id)).toMatchObject({ status: "closed", outcome: "stopped", spentTokens: 40_000 });
    const ev = world.events.list({ types: ["grant.closed"] }).at(-1)!;
    expect(ev.agentId).toBe(admin.id);
    expect(ev.payload).toMatchObject({ outcome: "stopped", reason: "the plan is wrong", spentTokens: 40_000, grantTokens: 200_000, unspentTokens: 160_000, returnedTo: "pool" });
    expect(ev.text).toMatch(/returned 160,000 unspent tokens to the Bank as free tokens/);
    // the close returns nothing twice: the claim went at the stop (this fixture's sessions are not debited from the Bank)
    expect(free()).toBe(before + 170_000);
  });

  it("pool-funded with nothing running: closes at once and the unspent rest is free tokens again", () => {
    const { world, admin, manager, proposal, session, free } = setup();
    const g = proposal();
    world.grantDesk.decide(admin, g.id, { action: "fund" });
    session(manager.id, g.id, "done", 50_000);
    const funded = free();
    expect(world.grantDesk.stop(admin, g.id, { reason: "done with it" })).toMatchObject({ status: "closed", outcome: "stopped" });
    expect(free()).toBe(funded + 150_000);
  });

  it("member-funded: nothing moves, the rest stays on the member's input and the event says so", () => {
    const { world, admin, member, manager, input, proposal } = setup();
    const g = proposal();
    world.grantDesk.decide(member, g.id, { action: "fund", fundWith: input.id });
    world.budget.charge(manager.id, 40_000, 0, undefined, { grantId: g.id });
    world.sessions.upsert({ id: newId("se"), agentId: manager.id, assignmentId: null, meetingId: null, purpose: "work", backend: "host", status: "done", model: "m", sdkSessionId: null, output: 40_000, costUsd: 0, startedAt: nowIso(), endedAt: nowIso(), lane: "grant", grantId: g.id } as never);
    const balance = world.bank.inputBalance(input.id);
    expect(balance).toBe(460_000);
    world.grantDesk.stop(admin, g.id, { reason: "member changed their mind" });
    expect(world.bank.inputBalance(input.id)).toBe(balance);
    const ev = world.events.list({ types: ["grant.closed"] }).at(-1)!;
    expect(ev.payload).toMatchObject({ outcome: "stopped", spentTokens: 40_000, grantTokens: 200_000, unspentTokens: 160_000, returnedTo: "input", fundedWith: input.id });
    expect(ev.text).toMatch(/the unspent 160,000 tokens stay on Member key/);
  });

  it("a stopped grant shows on the Town Hall in-tray and the review deck for the record (who, why, spent and returned), uncounted, for 3 days after it closes", () => {
    const { world, admin, manager, proposal, session } = setup();
    const th = world.buildings.first("kind = 'town-hall'")!;
    const g = proposal();
    world.grantDesk.decide(admin, g.id, { action: "fund" });
    const withdrawn = proposal();
    world.grantDesk.close(manager, withdrawn.id, { outcome: "stopped", note: "superseded" });
    const fork = world.agents.upsert({ ...manager, id: newId("ag"), name: `${manager.name} 1`, forkOf: manager.id, forkN: 1, status: "working" });
    const running = session(fork.id, g.id, "running");
    const count = intrayCount(world, th.id);
    world.grantDesk.stop(admin, g.id, { reason: "the plan is wrong" });
    // stopping: listed already; a withdrawn proposal is not a stop
    expect(townHallIntray(world).stopped.map((x) => [x.id, x.status])).toEqual([[g.id, "stopping"]]);
    expect(intrayCount(world, th.id)).toBe(count);
    world.sessions.upsert({ ...running, status: "done", output: 30_000, endedAt: nowIso() } as never);
    world.grantDesk.finishStopping();
    expect(townHallIntray(world).stopped.map((x) => [x.id, x.status, x.outcome])).toEqual([[g.id, "closed", "stopped"]]);
    const slide = reviewDeck(world).slides.find((x) => x.kind === "stopped")!;
    expect(slide).toMatchObject({ grantId: g.id, key: `stopped:${g.id}` });
    expect(slide.text).toContain(`stopped ${g.id}:** the plan is wrong`);
    expect(slide.text).toContain("Spent 30k of 200k adjusted tokens granted; 170k unspent returned to the Bank as free tokens.");
    expect(slide.text).toContain("**Your call:** None");
    // not a decision: slide 1's count leaves it out
    expect(reviewDeck(world).slides[0]!.text).not.toMatch(/\b1 decision/);
    // 3 days after it closed it leaves
    world.grants.upsert({ ...world.grants.require(g.id), closedAt: new Date(Date.now() - 4 * 24 * 3_600_000).toISOString() });
    expect(townHallIntray(world).stopped).toEqual([]);
  });
});
