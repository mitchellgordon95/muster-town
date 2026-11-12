/**
 * An ask is a stored snapshot of a job's thread (plan dc_uwx045472m step 6; Mitchell, 2026-11-12: asks are "data ...
 * rendered from a thread at a given snapshot of its state"). Every ask points at the entry that raised it; a card the
 * town writes from its object is written again when the thread moves; a card with an author's words is marked as
 * behind its thread, and the Secretary may write it again.
 */
import { describe, expect, it } from "vitest";
import { appendEntry, buildingRoleId, entryOf, jobThread, openManagerEntries, requestAccess } from "../src/index.ts";
import { decideAsk, entriesSinceCard, rerenderAsks } from "../src/asks.ts";
import { threadSeq } from "../src/jobs.ts";
import { creditBank, seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const POLICY = { type: "policy" as const, title: "Keep one banner per lab?", body: "Rule: a lab shows one banner.\nI applied it to the second banner.\nReversing it means two banners compete.", branches: [{ label: "Keep the rule" }, { label: "Change it" }], recommendation: "Keep the rule" };

function setup() {
  const s = seededWorld();
  const { world } = s;
  creditBank(world, 10_000_000);
  const manager = world.agents.first("homeBuildingId = ? AND kind != 'human'", [LAB])!;
  world.permissions.grant(manager, buildingRoleId(LAB, "manager"));
  world.buildings.patch(LAB, { managerAgentId: manager.id });
  const sec = world.secretary.ensure()!;
  const proposal = () => world.grantDesk.propose(manager, world.grantDesk.create(manager, LAB, {
    keyResults: [{ text: "Banner shows Usage", howToCheck: "Open the lab banner" }], objective: "A banner", approach: "a banner line", steps: [{ size: "M", title: "Step 1", description: "Do the work" }], stopCondition: "two failed tries", askTokens: 300_000,
  }).id);
  const askOn = (kind: string, id: string) => world.asks.first("targetKind = ? AND targetId = ? AND status IN ('open', 'deferred')", [kind, id])!;
  return { ...s, world, manager, sec, proposal, askOn };
}

describe("every ask points at the entry that raised it", () => {
  it("a proposal's ask: the propose entry on the grant's job; a request's: its do entry; a retainer's and a join request's: an entry on the building's or the Town Hall's thread", async () => {
    const { world, manager, proposal, askOn } = setup();
    const g = proposal();
    const money = askOn("grant", g.id);
    const propose = jobThread(world, g.id)!.entries.find((e) => e.moved.action === "propose")!;
    expect(money.sourceEntryId).toBe(propose.id);
    expect(money.sources[0]).toMatchObject({ docId: g.id, entryId: propose.id });

    const req = await world.verbs.request_human(manager, { title: "Photograph the gauge", body: "From the north side.", worth: "Only a human can stand at the gauge; the calibration waits on it." });
    const doAsk = askOn("request", req.id);
    expect(doAsk.sourceEntryId).toBe(`en_${req.id}`);
    expect(entryOf(world, doAsk.sourceEntryId!)).toMatchObject({ level: "human", moved: { kind: "do" } });

    const sc = (await world.verbs.schedule(manager, { title: "Weekly check", description: "d", tokensPerRun: 1000, repeat: { everyHours: 168 } })).scheduleId;
    const retainer = askOn("retainer", sc);
    expect(entryOf(world, retainer.sourceEntryId!)).toMatchObject({ jobId: `jb_${LAB}`, level: "human", moved: { kind: "ask", type: "money", targetId: sc } });

    const stranger = world.ops.createUser("Rando").user;
    const access = requestAccess(world, stranger.id, "I'd like to help");
    const join = askOn("access", access.id);
    expect(entryOf(world, join.sourceEntryId!)).toMatchObject({ jobId: "jb_town-hall", authorKind: "human", authorId: stranger.id, level: "human" });
    // each card records the thread's length when it was written
    for (const a of [doAsk, retainer, join].map((x) => world.asks.require(x.id))) expect(a.renderedSeq).toBe(threadSeq(world, entryOf(world, a.sourceEntryId!)!.jobId));
    // no live ask is without one
    expect(world.asks.count("status IN ('open', 'deferred') AND sourceEntryId IS NULL")).toBe(0);
  });

  it("a manager's ask that folds into the item's live ask keeps its words on it: a source line naming its entry, a fold in the history; the decision answers every entry that raised it", async () => {
    const { world, admin, manager } = setup();
    const first = await world.verbs.ask(manager, { ...POLICY, targetKind: "rule", targetId: "one-banner" });
    const again = await world.verbs.ask(manager, { ...POLICY, title: "Still: one banner per lab?", targetKind: "rule", targetId: "one-banner", note: "The second lab asked again." });
    expect(again).toMatchObject({ askId: first.askId, folded: true });
    expect(again.entryId).not.toBe(first.entryId);
    const ask = world.asks.require(first.askId);
    expect(ask.sourceEntryId).toBe(first.entryId);
    expect(ask.sources.map((s) => s.entryId)).toEqual([first.entryId, again.entryId]);
    expect(ask.sources[1]!.line).toBe("The second lab asked again.");
    expect(ask.history.map((h) => h.action)).toContain("fold");
    decideAsk(world, admin, ask.id, "Keep the rule");
    expect(openManagerEntries(world, LAB).map((e) => e.answers).sort()).toEqual([first.entryId, again.entryId].sort());
  });
});

describe("a card follows its thread", () => {
  it("a town card is written again from its object when an entry lands on its thread, and its renderedSeq moves with the thread", async () => {
    const { world, manager, askOn } = setup();
    const req = await world.verbs.request_human(manager, { title: "Photograph the gauge", body: "From the north side.", worth: "Only a human can stand at the gauge; the calibration waits on it." });
    const before = askOn("request", req.id);
    const jobId = entryOf(world, before.sourceEntryId!)!.jobId;
    // the request changes, and the thread moves
    world.docs.patch(req.id, { title: "Photograph the gauge at dusk" });
    appendEntry(world, { jobId, authorKind: "manager", authorId: manager.id, level: "none", note: "Dusk is when the light shows the scale." });
    const after = world.asks.require(before.id);
    expect(after.title).toBe("Photograph the gauge at dusk");
    expect(after.renderedSeq).toBe(threadSeq(world, jobId));
    expect(after.renderedSeq).toBeGreaterThan(before.renderedSeq!);
    expect(after.history.at(-1)).toMatchObject({ action: "retitled", by: "system" });
    // nothing else about it changed, and a second pass changes nothing
    expect(after).toMatchObject({ id: before.id, status: "open", type: before.type, branches: before.branches });
    expect(rerenderAsks(world)).toBe(0);
  });

  it("an author's card keeps its words and is marked behind its thread; the Secretary's read says so, and rewrite writes it again", async () => {
    const { world, manager, sec } = setup();
    const r = await world.verbs.ask(manager, POLICY);
    expect(entriesSinceCard(world, world.asks.require(r.askId))).toBe(0);
    appendEntry(world, { jobId: r.jobId, authorKind: "manager", authorId: manager.id, level: "none", note: "A third lab now shows two banners." });
    const stale = world.asks.require(r.askId);
    expect(stale.title).toBe(POLICY.title);
    expect(entriesSinceCard(world, stale)).toBe(1);
    const read = await world.verbs.rank(sec, {}) as { inputs: string };
    expect(read.inputs).toMatch(new RegExp(`${r.askId} · policy .* THREAD MOVED: 1 entry on its thread since this card was written`));
    await expect(world.verbs.rank(manager, { rewrite: [{ askId: r.askId, body: "x" }] })).rejects.toThrow(/Secretary/);
    const out = await world.verbs.rank(sec, { rewrite: [{ askId: r.askId, body: "Rule: a lab shows one banner.\nI applied it twice; a third lab now shows two.\nReversing it means labs choose their own count." }] }) as unknown as { rewritten: string[] };
    expect(out.rewritten).toEqual([r.askId]);
    const fresh = world.asks.require(r.askId);
    expect(fresh.body).toContain("a third lab now shows two");
    expect(fresh).toMatchObject({ title: POLICY.title, type: "policy", branches: stale.branches, recommendation: POLICY.recommendation });
    expect(fresh.history.at(-1)!.action === "rewritten" || fresh.history.some((h) => h.action === "rewritten")).toBe(true);
    expect(entriesSinceCard(world, fresh)).toBe(0);
    const again = await world.verbs.rank(sec, {}) as { inputs: string };
    expect(again.inputs).not.toContain("THREAD MOVED");
  });

  it("boot: a live ask filed before migration 115 gets the entry it came from, once", async () => {
    const { world, manager, proposal, askOn } = setup();
    const g = proposal();
    const req = await world.verbs.request_human(manager, { title: "Photograph the gauge", body: "From the north side.", worth: "Only a human can stand at the gauge; the calibration waits on it." });
    for (const a of [askOn("grant", g.id), askOn("request", req.id)]) world.asks.upsert({ ...a, sourceEntryId: null, renderedSeq: null });
    rerenderAsks(world);
    expect(askOn("grant", g.id).sourceEntryId).toBe(jobThread(world, g.id)!.entries.find((e) => e.moved.action === "propose")!.id);
    expect(askOn("request", req.id)).toMatchObject({ sourceEntryId: `en_${req.id}`, renderedSeq: expect.any(Number) });
    expect(rerenderAsks(world)).toBe(0);
  });
});
