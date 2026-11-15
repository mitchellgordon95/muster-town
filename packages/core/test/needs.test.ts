/**
 * Needs and asks (Mitchell, 1:1 mt_t65exni4et 2026-11-15 decision 2): a grant proposed, a grant at its gate and an outbox
 * request write a need (a fact on the job's thread) and no card. The need waits in its manager's in-tray until the
 * manager renders it with `ask`; past an hour the Secretary renders it and the manager is told. A boot repair takes back
 * the template cards still in the queue. The human's decision keeps the card they saw on the thread.
 */
import { describe, expect, it } from "vitest";
import { buildingRoleId, decideRetainer, intrayCounts, jobThread, managerQueue, managerStateBlock } from "../src/index.ts";
import { asksFor, decideAsk } from "../src/asks.ts";
import { NEED_BACKSTOP_MS, openNeedsOn, overdueNeeds, unrenderedNeeds } from "../src/needs.ts";
import { templateCardsToNeeds } from "../src/asks.ts";
import { askAt, creditBank, seededWorld, seedAsk } from "./helpers.ts";

const LAB = "carbon-cycle";
const FUND_CARD = {
  type: "money" as const, title: "Fund the banner grant at 300k",
  body: "This is a new proposal. You have not decided on it before.\nIt asks for 300,000 tokens. Nothing is spent yet.\nIt has one step, and none is done yet.\nIf you fund: step 1 starts.",
  branches: [{ label: "Yes" }, { label: "No" }], recommendation: "Fund it: the banner is the lab's next step.",
};

function setup() {
  const s = seededWorld();
  const { world, admin, by } = s;
  creditBank(world, 10_000_000);
  const mei = by("Mei");
  world.ops.updateBuilding(admin, LAB, { managerAgentId: mei.id });
  world.permissions.grant({ kind: "agent", id: mei.id }, buildingRoleId(LAB, "manager"));
  const sec = world.secretary.ensure()!;
  const propose = (askTokens = 300_000) => askAt(world, world.grantDesk.propose(mei, world.grantDesk.create(mei, LAB, {
    keyResults: [{ text: "A guest sees the banner", howToCheck: "Open the lab" }], objective: "A banner", steps: [{ size: "M", title: "Step 1", description: "Do the work" }], stopCondition: "s", askTokens,
  }).id), askTokens);
  return { ...s, mei, sec, propose };
}

describe("needs and asks", () => {
  it("a proposal writes a need and no card; it waits in the manager's in-tray and prompt until the manager renders it with ask", async () => {
    const { world, mei, propose } = setup();
    const g = propose();
    expect(asksFor(world, { kind: "grant", id: g.id })).toEqual([]);
    const [need] = unrenderedNeeds(world, LAB);
    expect(need).toMatchObject({ need: "proposal", targetKind: "grant", targetId: g.id, type: "money", buildingId: LAB });
    expect(need!.entry).toMatchObject({ jobId: `jb_${g.id}`, level: "human", note: expect.stringMatching(new RegExp(`^Grant ${g.id} ".+" wants funding: [0-9,]+ tokens, 1 step\\.$`)) });
    expect(managerQueue(world, LAB).map((x) => x.id)).toContain(need!.entry.id);
    expect(intrayCounts(world).get(LAB)).toBeGreaterThanOrEqual(1);
    expect(managerStateBlock(world, mei, world.buildings.require(LAB))).toContain(`${need!.entry.id} NEED TO RENDER on jb_${g.id}`);
    // the manager renders it: the need's type and branches win over the card's; no second entry is written
    const before = jobThread(world, g.id)!.total;
    const r = await world.verbs.ask(mei, { ...FUND_CARD, targetId: g.id });
    const ask = world.asks.require(r.askId);
    expect(r).toMatchObject({ entryId: need!.entry.id, jobId: `jb_${g.id}`, folded: false });
    expect(ask).toMatchObject({ type: "money", title: FUND_CARD.title, body: FUND_CARD.body, recommendation: FUND_CARD.recommendation, sourceEntryId: need!.entry.id, status: "open" });
    expect(ask.branches.map((b) => b.label)).toEqual(["Fund", "Counter", "Reject"]);
    expect(jobThread(world, g.id)!.total).toBe(before);
    expect(unrenderedNeeds(world, LAB)).toEqual([]);
    expect(managerQueue(world, LAB).map((x) => x.id)).not.toContain(need!.entry.id);
    // a card that lacks the money structure is refused
    const g2 = propose(100_000);
    await expect(world.verbs.ask(mei, { ...FUND_CARD, targetId: g2.id, body: "Please fund it." })).rejects.toThrow(/lacks/);
  });

  it("a request writes a need on the asking job; another building's manager can't render it", async () => {
    const { world, mei, by } = setup();
    const noor = by("Noor");
    const req = await world.verbs.request_human(noor, { worth: "Only a human can do this; the work waits on it.", title: "Reissue the test account's PAT", body: "The token expired.", kind: "other" });
    const [need] = openNeedsOn(world, "request", req.id);
    expect(need).toMatchObject({ need: "request", type: "credential", entry: { id: `en_${req.id}`, docId: req.id } });
    expect(asksFor(world, { kind: "request", id: req.id })).toEqual([]);
    const r = await world.verbs.ask(mei, { type: "credential", targetId: req.id, title: "Reissue the test account's token", body: "Scope: repo on the test account.\nIf you decline: the live checks stay manual.", branches: [{ label: "Done" }, { label: "Decline" }], recommendation: "Press Done after you reissue it." });
    expect(world.asks.require(r.askId)).toMatchObject({ type: "credential", sourceEntryId: `en_${req.id}`, branches: [{ label: "Done", action: "done" }, { label: "Decline", action: "decline" }] });
  });

  it("the human's decision on a rendered request keeps the card they saw on the thread, beside their words", async () => {
    const { world, admin, mei } = setup();
    const req = await world.verbs.request_human(mei, { worth: "Only a human can do this; the work waits on it.", title: "Photograph the slump", body: "From the north side.", kind: "observation" });
    const r = await world.verbs.ask(mei, { type: "do", targetId: req.id, title: "Photograph the slump from the north", body: "Worth leaving the queue: only a human can stand there.\nIf you decline: the survey stays unchecked.", branches: [{ label: "Done" }, { label: "Decline" }], recommendation: "Press Done after the photo." }).catch(() => null);
    // `ask` refuses a do card with no need behind it, but this one renders the request's need
    expect(r).not.toBeNull();
    decideAsk(world, admin, r!.askId, "Decline", "No camera today.");
    const answer = jobThread(world, `jb_${LAB}`)!.entries.find((e) => e.answers === `en_${req.id}`)!;
    expect(answer.moved).toMatchObject({ decision: "ask-decided", said: "Decline. No camera today.", card: { askId: r!.askId, title: "Photograph the slump from the north", branches: ["Done", "Decline"], recommendation: "Press Done after the photo." } });
    expect(answer.body).toContain("# Photograph the slump from the north");
  });

  it("backstop: a need unrendered for an hour is listed in the Secretary read; rank render files the card and tells the manager", async () => {
    const { world, mei, sec, propose } = setup();
    const g = propose();
    const [need] = unrenderedNeeds(world);
    expect(overdueNeeds(world, Date.now())).toEqual([]);
    const later = new Date(Date.parse(need!.entry.createdAt) + NEED_BACKSTOP_MS + 1000);
    expect(overdueNeeds(world, later.getTime()).map((n) => n.entry.id)).toEqual([need!.entry.id]);
    // the read lists it
    const read = await world.verbs.rank(sec, {}) as { inputs: string };
    expect(read.inputs).not.toContain("Needs waiting");
    world.db.prepare("UPDATE entries SET createdAt = ? WHERE id = ?").run(new Date(Date.now() - NEED_BACKSTOP_MS - 1000).toISOString(), need!.entry.id);
    expect((await world.verbs.rank(sec, {}) as { inputs: string }).inputs).toContain(`Needs waiting more than an hour for their manager`);
    // only the Secretary renders through rank; a need that is not open is refused
    await expect(world.verbs.rank(mei, { render: [{ needId: need!.entry.id, title: "t", body: "b", recommendation: "r" }] })).rejects.toThrow(/Secretary/);
    await expect(world.verbs.rank(sec, { render: [{ needId: "en_nothere", title: "t", body: "b", recommendation: "r" }] })).rejects.toThrow(/not an open need/);
    const out = await world.verbs.rank(sec, { render: [{ needId: need!.entry.id, title: FUND_CARD.title, body: FUND_CARD.body, recommendation: FUND_CARD.recommendation }] }) as unknown as { rendered: string[] };
    expect(out.rendered).toHaveLength(1);
    expect(world.asks.require(out.rendered[0]!)).toMatchObject({ targetId: g.id, sourceEntryId: need!.entry.id, history: expect.arrayContaining([expect.objectContaining({ action: "create", by: sec.id })]) });
    expect(world.messages.where("toId = ?", [mei.id]).map((m) => m.body).at(-1)).toContain(`rendered your need ${need!.entry.id}`);
    expect(unrenderedNeeds(world)).toEqual([]);
  });

  it("backstop: the tick queues one Secretary run on the ranking retainer once a need is an hour old, never two at once", () => {
    const { world, admin, sec, propose } = setup();
    propose();
    const [need] = unrenderedNeeds(world);
    const later = new Date(Date.parse(need!.entry.createdAt) + NEED_BACKSTOP_MS + 1000);
    const sched = world.secretary.ensureRankSchedule()!;
    expect(world.secretary.needsOverdue(later)).toBeNull(); // the retainer is not approved yet
    decideRetainer(world, admin, sched.id, { action: "approve", note: "" });
    expect(world.secretary.needsOverdue(new Date(Date.parse(need!.entry.createdAt) + 1000))).toBeNull(); // not an hour yet
    const run = world.secretary.needsOverdue(later)!;
    expect(run).toMatchObject({ agentId: sec.id, title: "Render the needs no manager rendered", lane: "retainer" });
    expect(run.description).toContain(need!.entry.id);
    expect(world.secretary.needsOverdue(later)).toBeNull();
  });

  it("boot migration: a live template card leaves the queue and its need waits for the manager; a rewritten card or an author's keeps its words; idempotent", () => {
    const { world, sec, propose } = setup();
    const tpl = propose();
    const kept = propose(100_000);
    const authored = propose(50_000);
    // the cards as the town's templates left them (before needs), plus one the Secretary rewrote and one an explorer wrote
    const card = (g: { id: string }, recommendation: string, history: { at: string; action: string; by: string; note: string }[] = []) => {
      // a card filed before needs views the grant's propose entry (asks.ts knownEntryOf), not a need
      const g2 = world.grants.require(g.id);
      const a = seedAsk(world, { sourceEntryId: `en_${g.id}_h${g2.history.map((h) => h.action).lastIndexOf("propose")}`, type: "money", targetKind: "grant", targetId: g.id, buildingId: LAB, sourceDocId: g.id, title: `Fund ${g.id}`, body: "This is a new proposal.", branches: [{ label: "Fund", action: "fund" }, { label: "Counter", action: "counter" }, { label: "Reject", action: "reject" }], recommendation }).ask;
      return world.asks.upsert({ ...a, history: [...a.history, ...history] as never });
    };
    const t = card(tpl, "Fund it: the building proposed it as its next piece of work.");
    const k = card(kept, "Fund it: the building proposed it as its next piece of work.", [{ at: new Date().toISOString(), action: "rewritten", by: sec.id, note: "was" }]);
    const a = card(authored, "Fund it: it is the cheapest path.");
    expect(templateCardsToNeeds(world)).toBe(1);
    expect(world.asks.require(t.id)).toMatchObject({ status: "retired" });
    expect(world.asks.require(k.id).status).toBe("open");
    expect(world.asks.require(a.id).status).toBe("open");
    expect(unrenderedNeeds(world).map((n) => n.targetId)).toEqual([tpl.id]);
    expect(templateCardsToNeeds(world)).toBe(0);
  });
});
