/**
 * Duplicate asks (Mitchell, 1:1 mt_dwsxo7oms8 decisions 2-3, 2026-11-15): one need, one ask. A card is written whole,
 * from its thread, by one author at one time; nothing appends to a card. A second ask on the same need is refused at the
 * door and its words go on the thread as an entry. A manager may write its own building's card again whole or withdraw
 * it with a note; the Secretary folds a dupe raised on another job, and the human's decision lands on both threads.
 */
import { describe, expect, it } from "vitest";
import { buildingRoleId, entryOf, jobThread, openManagerEntries, requestAccess } from "../src/index.ts";
import { decideAsk } from "../src/asks.ts";
import { renderNeed } from "../src/ask-verb.ts";
import { fileNeed, openNeedsOn, PROPOSAL_BRANCHES } from "../src/needs.ts";
import { creditBank, renderNeeds, seedAsk, seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const POLICY = { type: "policy" as const, title: "Keep one banner per lab?", body: "Rule: a lab shows one banner.\nI applied it to the second banner.\nReversing it means two banners compete.", branches: [{ label: "Keep the rule" }, { label: "Change it" }], recommendation: "Keep the rule" };
const CREDENTIAL = { type: "credential" as const, title: "Create the mail sending key", body: "The signup mail needs a sending key.\nScope: sending only, on mail.muster.town.\nIf you decline: the signup check stays manual.", branches: [{ label: "Key is set" }, { label: "Decline" }], recommendation: "Key is set" };

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
  return { ...s, world, manager, sec, proposal };
}

const refusedEntries = (world: ReturnType<typeof setup>["world"], jobId: string) => jobThread(world, jobId)!.entries.filter((e) => e.moved.kind === "ask-refused");

describe("one need, one ask: the door", () => {
  it("a second ask on the same need entry (no target) returns the first with folded: true, writes one thread entry and leaves the card as it was", () => {
    const { world } = setup();
    const first = seedAsk(world, { type: "click", buildingId: LAB, sourceDocId: null, by: "system", title: "Set up the mail service", body: "Two buildings wait on mail.", branches: [{ label: "Done" }, { label: "Decline" }], recommendation: "Done" });
    expect(first.folded).toBe(false);
    const card = world.asks.require(first.ask.id);
    const again = { type: "click" as const, buildingId: LAB, sourceDocId: null, by: "system", sourceEntryId: card.sourceEntryId!, title: "Set up Resend for mail", body: "Outreach also needs it.", branches: [{ label: "Done" }], recommendation: "Done" };
    expect(seedAsk(world, again)).toMatchObject({ folded: true, ask: { id: card.id } });
    seedAsk(world, again);
    const after = world.asks.require(card.id);
    expect(after).toMatchObject({ title: card.title, body: card.body, recommendation: card.recommendation, history: card.history });
    expect(world.asks.count("status IN ('open', 'deferred')")).toBe(1);
    const job = entryOf(world, card.sourceEntryId!)!.jobId;
    const refused = refusedEntries(world, job);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ level: "none", moved: { askId: card.id }, note: expect.stringContaining("Set up Resend for mail"), body: expect.stringContaining("Outreach also needs it.") });
  });

  it("the same need rendered twice (a target) is one card: the second render's words are an entry, the card is not glued", async () => {
    const { world, manager, proposal } = setup();
    const g = proposal();
    renderNeeds(world, manager.id);
    const [ask] = world.asks.where("targetId = ? AND status = 'open'", [g.id]);
    const r = await world.verbs.ask(manager, { type: "money", targetId: g.id, title: "Fund the banner again", body: "This is a new proposal. You have not decided on it before.\nNothing is spent yet. It has one step, and none is done yet.\nIf you fund: the banner ships.", branches: [{ label: "Fund" }, { label: "Reject" }], recommendation: "Fund", claims: [{ text: "The banner builds", check: { kind: "manual" } }] });
    expect(r).toMatchObject({ askId: ask!.id, folded: true });
    expect(world.asks.require(ask!.id)).toMatchObject({ title: ask!.title, body: ask!.body });
    expect(refusedEntries(world, `jb_${g.id}`)).toHaveLength(1);
    expect(world.asks.count("targetId = ? AND status = 'open'", [g.id])).toBe(1);
  }, 30_000);

  it("a grant can carry a credential need and the town's proposal need at once: two cards, and a newer need of another kind supersedes nothing", async () => {
    const { world, manager, proposal } = setup();
    const g = proposal();
    renderNeeds(world, manager.id);
    const money = world.asks.first("targetId = ? AND status = 'open'", [g.id])!;
    const cred = await world.verbs.ask(manager, { ...CREDENTIAL, targetKind: "grant", targetId: g.id });
    // a credential ask on the grant is its own need beside the proposal's: its own card, nothing folded
    expect(cred).toMatchObject({ folded: false });
    expect(cred.askId).not.toBe(money.id);
    expect(world.asks.require(money.id).status).toBe("open");
    // a policy need filed by code on the same grant beside the proposal: both stay open, each its own card
    const e = fileNeed(world, { need: "rule", targetKind: "grant", targetId: g.id, type: "policy", branches: [{ label: "Keep" }, { label: "Change" }], jobId: `jb_${g.id}`, note: "A rule on this grant", body: "" });
    expect(e).not.toBeNull();
    expect(openNeedsOn(world, "grant", g.id).map((n) => n.need).sort()).toEqual(["proposal", "rule"]);
    const rule = openNeedsOn(world, "grant", g.id).find((n) => n.need === "rule")!;
    expect(renderNeed(world, rule, POLICY, manager.id).folded).toBe(false);
    expect(world.asks.count("targetId = ? AND status = 'open'", [g.id])).toBe(3);
    // a newer proposal need supersedes only the older proposal need
    fileNeed(world, { need: "proposal", targetKind: "grant", targetId: g.id, type: "money", branches: PROPOSAL_BRANCHES, jobId: `jb_${g.id}`, note: "Proposed again", body: "" });
    expect(openNeedsOn(world, "grant", g.id).map((n) => n.need).sort()).toEqual(["proposal", "rule"]);
  }, 30_000);
});

describe("a manager's own card: rewrite whole, withdraw with a note", () => {
  it("rewrites its own building's ask whole (lint still runs) and is refused on another building's", async () => {
    const { world, manager } = setup();
    const r = await world.verbs.ask(manager, POLICY);
    const out = await world.verbs.ask(manager, { askId: r.askId, title: "Keep one banner per lab", body: "Rule: a lab shows one banner.\nA third lab now shows two; I applied it there too.\nReversing it means labs choose their own count.", recommendation: "Keep the rule; it held twice" });
    expect(out).toMatchObject({ askId: r.askId, status: "open" });
    const a = world.asks.require(r.askId);
    expect(a).toMatchObject({ title: "Keep one banner per lab", recommendation: "Keep the rule; it held twice", type: "policy", branches: POLICY.branches });
    expect(a.history.at(-1)?.action === "rewritten" || a.history.some((h) => h.action === "rewritten")).toBe(true);
    // a partial card is refused: it is written whole
    await expect(world.verbs.ask(manager, { askId: r.askId, title: "Only a title" })).rejects.toThrow(/whole card/);
    // a style warning on the rewrite is kept as a lint entry in its history
    await world.verbs.ask(manager, { askId: r.askId, title: "Keep the rule (see dc_abc123)", body: a.body, recommendation: a.recommendation });
    expect(world.asks.require(r.askId).history.at(-1)).toMatchObject({ action: "lint" });
    // another building's ask (the Town Hall's join request) is not this manager's to rewrite or withdraw
    const stranger = world.ops.createUser("Rando").user;
    const access = requestAccess(world, stranger.id, "I'd like to help");
    renderNeeds(world);
    const join = world.asks.first("targetId = ? AND status = 'open'", [access.id])!;
    await expect(world.verbs.ask(manager, { askId: join.id, title: "x", body: "y", recommendation: "z" })).rejects.toThrow(/not an ask of your building/);
    await expect(world.verbs.ask(manager, { askId: join.id, withdraw: true, note: "not mine" })).rejects.toThrow(/not an ask of your building/);
  }, 30_000);

  it("withdraw retires the ask with the note, answers its own entry and wakes nobody", async () => {
    const { world, manager } = setup();
    const r = await world.verbs.ask(manager, POLICY);
    expect(openManagerEntries(world, LAB).length).toBe(0);
    const out = await world.verbs.ask(manager, { askId: r.askId, withdraw: true, note: "The labs settled it between them." });
    expect(out).toMatchObject({ askId: r.askId, status: "retired" });
    const a = world.asks.require(r.askId);
    expect(a).toMatchObject({ status: "retired", retiredBy: expect.stringContaining("The labs settled it between them.") });
    expect(a.history.at(-1)).toMatchObject({ action: "withdraw" });
    const answer = jobThread(world, r.jobId)!.entries.find((e) => e.answers === r.entryId)!;
    expect(answer).toMatchObject({ level: "none", note: expect.stringContaining("The labs settled it between them.") });
    expect(openManagerEntries(world, LAB).length).toBe(0);
    expect(world.asks.count("id = ?", [r.askId])).toBe(1);
    await expect(world.verbs.ask(manager, { askId: r.askId, withdraw: true, note: "again" })).rejects.toThrow(/already retired/);
  });
});

describe("the Secretary folds a dupe raised on another job", () => {
  it("fold: the later ask goes folded into the survivor, its thread says so; the human's decision lands on both threads", async () => {
    const { world, admin, manager, sec } = setup();
    const a = await world.verbs.ask(manager, CREDENTIAL);
    const b = await world.verbs.ask(manager, { ...CREDENTIAL, title: "Set the Resend key", jobId: `jb_${LAB}` });
    expect(b.askId).not.toBe(a.askId);
    const out = await world.verbs.rank(sec, { fold: [{ askId: b.askId, into: a.askId, note: "Both ask for the one mail key." }] }) as unknown as { folded: string[] };
    expect(out.folded).toEqual([b.askId]);
    expect(world.asks.require(b.askId)).toMatchObject({ status: "folded", foldedInto: a.askId });
    expect(jobThread(world, b.jobId)!.entries.some((e) => e.moved.kind === "ask-folded" && e.moved.into === a.askId)).toBe(true);
    await expect(world.verbs.rank(manager, { fold: [{ askId: a.askId, into: b.askId, note: "x" }] })).rejects.toThrow(/Secretary/);
    decideAsk(world, admin, a.askId, "Key is set");
    expect(openManagerEntries(world, LAB).map((e) => e.answers).sort()).toEqual([a.entryId, b.entryId].sort());
  });
});
