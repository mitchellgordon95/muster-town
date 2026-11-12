/**
 * No more rollups (plan dc_uwx045472m step 7; 1:1 mt_msnjkpgwdb decision 21). What a rollup carried has three homes:
 * what shipped is named at `close_grant` (one notice each), what only a human can settle is an ask on a job's thread
 * (`ask`), and the rest is the record on the threads. Undecided rollups left in the Town Hall queue are closed at boot.
 */
import { describe, expect, it } from "vitest";
import { buildingQueue, createBuilding, createDoc, createResident, forkManager, intrayOf, jobThread, managePrompt, managerSystemPrompt, openManagerEntries, retireFork, setAssignmentStatus, townHallIntray, updateBuilding } from "../src/index.ts";
import { decideAsk } from "../src/asks.ts";
import { retireRollups } from "../src/domain.ts";
import { listNotices } from "../src/notices.ts";
import { creditBank, seededWorld } from "./helpers.ts";

const STEPS = [{ size: "M" as const, title: "Build it", description: "Ship the PR" }];
const MONEY = {
  type: "money" as const, title: "Raise the banner grant's ceiling",
  body: "You funded this at 150k today. It has spent nothing yet. One step is left; none is done.\nIf you raise it: the banner gets a picture.\nIf you keep it: the banner ships without one.",
  branches: [{ label: "Raise" }, { label: "Keep" }], recommendation: "Raise: the picture is the point.",
};

function lab() {
  const s = seededWorld();
  const { world, seed, admin } = s;
  const b = createBuilding(world, { name: "Quiet", headcount: 3, model: "claude-opus-5-5", cheapModel: "claude-haiku-5-5" }, seed.admin.id);
  const pix = createResident(world, { buildingId: b.id, name: "Pix" });
  updateBuilding(world, b.id, { managerAgentId: pix.id });
  creditBank(world);
  const g0 = world.grantDesk.propose(null, world.grantDesk.create(null, b.id, { keyResults: [{ text: "A banner", howToCheck: "Open the lab" }], objective: "A banner", approach: "a", steps: STEPS, stopCondition: "s", askTokens: 150_000 }).id);
  const g = world.grantDesk.decide(admin, g0.id, { action: "fund" });
  return { ...s, b: world.buildings.require(b.id), pix: world.agents.require(pix.id), g };
}

describe("no more rollups", () => {
  it("submit_report with rollup: true is refused and says where each part goes now", async () => {
    const { world, pix } = lab();
    await expect(world.verbs.submit_report(pix, { title: "Rollup", body: "## Shipped\nx", verdict: "stop", rollup: true })).rejects.toThrow(/Rollups are retired.*close_grant.*`ask`/);
    expect(world.docs.count("authorId = ? AND type = 'report'", [pix.id])).toBe(0);
  });

  it("ask: the manager's card is an ask in the queue and one entry at level human on the thread of the grant it targets; the decision comes back there", async () => {
    const { world, admin, b, pix, g } = lab();
    const r = await world.verbs.ask(pix, { ...MONEY, targetId: g.id, note: "The fork found a picture would double the effect." });
    // the grant has no live ask (it is funded and running), so this is a new one, on the grant's own thread
    expect(r).toMatchObject({ jobId: `jb_${g.id}`, folded: false });
    expect(world.asks.require(r.askId)).toMatchObject({ type: "money", status: "open", targetKind: "grant", targetId: g.id, buildingId: b.id, title: MONEY.title, recommendation: MONEY.recommendation });
    const raised = jobThread(world, g.id)!.entries.find((e) => e.id === r.entryId)!;
    expect(raised).toMatchObject({ authorKind: "manager", authorId: pix.id, level: "human", note: MONEY.title, moved: { kind: "ask", type: "money", targetId: g.id } });
    expect(raised.body).toContain("The fork found a picture would double the effect.");
    // nothing of it is a report, and it is not in the manager's own queue
    expect(world.docs.count("authorId = ? AND type = 'report'", [pix.id])).toBe(0);
    expect(openManagerEntries(world, b.id)).toEqual([]);
    // the human decides it in the queue: their words are an entry on the same thread, for the manager
    decideAsk(world, admin, r.askId, "Keep", "ship it plain");
    const [back] = openManagerEntries(world, b.id);
    expect(back).toMatchObject({ jobId: `jb_${g.id}`, authorKind: "human", level: "manager", answers: r.entryId });
    expect(back!.note).toContain("Keep. ship it plain");
  });

  it("ask with no target goes on the building's own thread; a card without structure is refused and nothing is filed; a do is request_human's; only the manager asks", async () => {
    const { world, b, pix } = lab();
    const policy = { type: "policy" as const, title: "Keep one banner per lab?", body: "Rule: a lab shows one banner.\nI applied it to the second banner.\nReversing it means two banners compete.", branches: [{ label: "Keep the rule" }, { label: "Change it" }], recommendation: "Keep the rule" };
    const r = await world.verbs.ask(pix, policy);
    expect(r.jobId).toBe(`jb_${b.id}`);
    const before = world.asks.count();
    await expect(world.verbs.ask(pix, { ...policy, title: "Another", branches: [{ label: "Keep" }], recommendation: "" })).rejects.toThrow(/lacks/);
    await expect(world.verbs.ask(pix, { ...policy, type: "do", title: "Photograph the gauge" })).rejects.toThrow(/request_human/);
    await expect(world.verbs.ask(pix, { ...MONEY })).rejects.toThrow(/money ask: name the grant or retainer/);
    await expect(world.verbs.ask(pix, { ...policy, title: "Third", jobId: "jb_carbon-cycle" })).rejects.toThrow(/another building's job/);
    expect(world.asks.count()).toBe(before);
    const fork = (() => { const a = buildingQueue(world, b.id)[0]!; const { fork } = forkManager(world, b.id, a.id); setAssignmentStatus(world, a.id, "active"); return world.agents.require(fork.id); })();
    await expect(world.verbs.ask(fork, policy)).rejects.toThrow(/Only a building's manager asks the humans/);
    retireFork(world, fork.id);
  });

  it("close_grant shipped: one shipped notice per item and the closed loop says what it bought; without it the closed loop says nothing was named", async () => {
    const one = lab();
    await one.world.verbs.close_grant(one.pix, { grantId: one.g.id, note: "Checked live: the banner shows.", shipped: [
      { title: "A banner on every lab", whatYoudSee: "Open any lab: the banner shows today's spend.", picture: "/api/media/mf_abc123.png" },
      { title: "A spend line", whatYoudSee: "API only: GET /api/buildings/:id has spendToday." },
    ] });
    const shipped = listNotices(one.world, { kind: "shipped", building: one.b.id });
    expect(shipped.map((n) => n.title).sort()).toEqual(["A banner on every lab", "A spend line"]);
    expect(shipped.every((n) => n.refs.includes(one.g.id))).toBe(true);
    expect(shipped.find((n) => n.title === "A banner on every lab")).toMatchObject({ picture: "mf_abc123", body: "Open any lab: the banner shows today's spend." });
    const [loop] = listNotices(one.world, { kind: "closed-loop", building: one.b.id });
    expect(loop!.body).toContain("Here is what it bought:");
    expect(loop!.body).toContain("- A banner on every lab: Open any lab: the banner shows today's spend.");
    expect(loop!.picture).toBe("mf_abc123");

    const two = lab();
    await two.world.verbs.close_grant(two.pix, { grantId: two.g.id, note: "Merged." });
    expect(listNotices(two.world, { kind: "shipped", building: two.b.id })).toEqual([]);
    expect(listNotices(two.world, { kind: "closed-loop", building: two.b.id })[0]!.body).toContain("Its manager named nothing shipped at the close");
  });

  it("boot repair: every rollup still pending leaves the Town Hall queue, answered by the town on its thread; its asks stay; a second run closes nothing (decision 21)", () => {
    const { world, b, pix } = lab();
    const old = (title: string) => createDoc(world, { type: "report", state: "building", title, body: "## Shipped\nNothing new.\n\n## Needs from Mitchell\n- Decide the colour.", verdict: "continue", decision: "pending", authorId: pix.id, authorKind: "agent", buildingId: b.id, tags: ["rollup"] });
    const r1 = old("Rollup 41"), r2 = old("Rollup 42");
    const plain = createDoc(world, { type: "report", state: "building", title: "A fork's report", body: "## What I need from you\nRead it.", verdict: "stop", decision: "pending", authorId: pix.id, authorKind: "agent", buildingId: b.id });
    const th = world.buildings.first("kind = 'town-hall'")!;
    expect(intrayOf(world, th.id).map((d) => d.id)).toEqual([r1.id, r2.id]);
    const asksBefore = world.asks.count("status IN ('open', 'deferred')");
    expect(retireRollups(world)).toEqual([r1.id, r2.id]);
    expect(world.docs.require(r1.id)).toMatchObject({ decision: "approve", decidedBy: "system" });
    expect(world.docs.require(r1.id).decisionNote).toContain("Rollups are retired");
    expect(townHallIntray(world).reports).toEqual([]);
    // a fork's own report is untouched, and no ask was closed
    expect(world.docs.require(plain.id).decision).toBe("pending");
    expect(world.asks.count("status IN ('open', 'deferred')")).toBe(asksBefore);
    expect(retireRollups(world)).toEqual([]);
  });

  it("the manager's prompts name no rollup rule: what shipped goes with close_grant, what a human must settle is an ask, the session ends by stopping", () => {
    const { world, b, pix } = lab();
    const system = managerSystemPrompt(pix, b, world.town.get());
    expect(system).toContain("There are no rollups");
    expect(system).toContain("give `shipped`");
    expect(system).toContain("Asks. File one card per thing only a human can do");
    expect(system).not.toMatch(/## Shipped|## Needs from|Roll up when|at least \d+ h since your last rollup/);
    const prompt = managePrompt(b, [], (id) => world.nameOf(id));
    expect(prompt).toContain("End the session by stopping");
    expect(prompt).not.toMatch(/rollup: true`? and the covered reports/);
  });
});
