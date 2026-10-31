import { describe, expect, it } from "vitest";
import { REVIEW_DECK_ID } from "@muster-town/schema";
import { buildingRoleId, createAssignment, createDoc, newId, nowIso, presentedReviewDeck, reviewDeck } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const KRS = [
  { text: "A visitor can see today's spend on the banner", howToCheck: "Open the lab banner, read Usage" },
  { text: "The board shows the lab's goal first", howToCheck: "Open the lab board" },
];
const rollupBody = (calls: string[]) => `## Shipped\n${calls.map((c, i) => `**${i + 1}. Item ${i + 1}**\n**What it is:** thing ${i + 1}\n**What you'd see:** the board\n![shot](/api/media/mf_x${i}.png)\n**Your call:** ${c}\n`).join("\n")}\n## Decided\n- none\n## Key results\n(none)\n## Needs from Mitchell\nNothing needed.`;
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

function setup() {
  const s = seededWorld();
  const { world, admin } = s;
  const manager = world.agents.first("homeBuildingId = ? AND kind != 'human'", [LAB])!;
  world.permissions.grant(manager, buildingRoleId(LAB, "manager"));
  const krs = KRS.map((k) => world.grantDesk.createKeyResult(admin, LAB, k));
  const proposal = (kr = krs[0]!.id, extra: { picture?: string; whatYoudSee?: string } = {}) => world.grantDesk.propose(manager, world.grantDesk.create(manager, LAB, {
    keyResultId: kr, objective: `Plan for ${kr}`, approach: "a banner line", stopCondition: "two failed tries", askTokens: 1_000_000,
    testingPlan: [{ text: "Banner shows Usage", howToCheck: "Open the lab banner" }], ...extra,
  }).id);
  const rollup = (calls: string[], createdAt: string, decided?: { decision: "approve"; note: string }) => createDoc(world, {
    type: "report", title: `Rollup ${createdAt.slice(11, 16)}`, body: rollupBody(calls), authorId: manager.id, authorKind: "agent", buildingId: LAB, state: "building",
    tags: ["rollup"], decision: decided ? decided.decision : "pending", decisionNote: decided?.note, decidedBy: decided ? admin.id : undefined, decidedAt: decided ? createdAt : undefined, createdAt,
  } as never);
  const park = (decision: string) => createAssignment(world, { agentId: manager.id, title: "parked", description: "x", createdBy: world.holderOf(admin), waitFor: { decision } });
  return { ...s, manager, krs, proposal, rollup, park };
}

const ours = (d: ReturnType<typeof reviewDeck>) => d.slides.filter((s) => s.kind !== "blocked");

describe("review deck (GET /api/review-deck)", () => {
  it("slide 1 is the state of the town; proposals oldest first; rollup items with a real call one slide each; None-only rollups collapse into For the record", () => {
    const { world, proposal, rollup } = setup();
    const g1 = proposal();
    const g2 = proposal(world.grantDesk.keyResults(LAB)[1]!.id, { whatYoudSee: "The board shows Usage", picture: undefined });
    const r1 = rollup(["Fund the next step?", "None"], ago(3));
    const r2 = rollup(["None", "**None.**"], ago(2));
    const deck = reviewDeck(world);
    expect(deck.slides[0]).toMatchObject({ kind: "town", key: "town", group: 0 });
    expect(deck.slides[0]!.text).toMatch(/# Review deck: the state of the town/);
    expect(deck.slides[0]!.text).toMatch(/\*\*Bank:\*\*/);
    expect(deck.slides[0]!.text).toMatch(/4 decisions below, oldest waiting/);
    expect(deck.slides[0]!.text).toMatch(/\| .* \| [🟢🟡🔴] \| .*on track|not started/);
    const rest = ours(deck).slice(1);
    expect(rest.map((s) => s.key)).toEqual([`proposal:${g1.id}`, `proposal:${g2.id}`, `rollup:${r1.id}:1`, "record"]);
    expect(rest[0]!.text).toMatch(/\*\*What it is:\*\* Plan for/);
    expect(rest[0]!.text).toMatch(/\*\*What you'd see:\*\* Open the lab banner/); // testing plan howToCheck
    expect(rest[0]!.text).toMatch(/_no picture_/);
    expect(rest[0]!.text).toMatch(/\*\*Your call:\*\* Fund 1M adjusted tokens, counter or reject. Stops when: two failed tries/);
    expect(rest[1]!.text).toMatch(/\*\*What you'd see:\*\* The board shows Usage/); // propose_grant whatYoudSee wins
    expect(rest[2]).toMatchObject({ kind: "rollup", docIds: [r1.id], itemId: r1.id });
    expect(rest[2]!.pictures).toEqual([{ alt: "shot", src: "/api/media/mf_x0.png" }]);
    expect(rest[2]!.text).toMatch(/Fund the next step\?/);
    expect(rest[3]).toMatchObject({ kind: "record", docIds: [r2.id] });
    expect(rest[0]!.text).toMatch(/^_Waiting \d/);
  });

  it("held checkpoints come first, then items work is parked on (most waiters first), with the waiter count on the slide", () => {
    const { world, admin, proposal, rollup, park, krs } = setup();
    const p1 = proposal();
    const r1 = rollup(["Merge it?"], ago(5));
    const r2 = rollup(["Pick A or B?"], ago(4));
    // a funded grant held at its checkpoint
    const held = proposal(krs[1]!.id);
    world.grantDesk.decide(admin, held.id, { action: "fund", tokens: 1_000_000 });
    world.grants.patch(held.id, { status: "checkpoint", history: [...world.grants.require(held.id).history, { at: nowIso(), byId: "system", byKind: "agent", action: "checkpoint", tokens: null, note: "" }] });
    park(r2.id); park(r2.id); park(p1.id);
    const rest = ours(reviewDeck(world)).slice(1);
    expect(rest.map((s) => s.key)).toEqual([`checkpoint:${held.id}`, `rollup:${r2.id}:1`, `proposal:${p1.id}`, `rollup:${r1.id}:1`]);
    expect(rest.map((s) => s.group)).toEqual([1, 3, 3, 5]);
    expect(rest[1]).toMatchObject({ waiters: 2 });
    expect(rest[1]!.text).toMatch(/2 assignments parked on this/);
    expect(rest[2]!.text).toMatch(/1 assignment parked on this/);
    expect(rest[3]!.waiters).toBe(0);
    // the checkpoint's history line is its last human entry (the funding)
    expect(rest[0]!.history).toMatch(/funded .* ago/);
    expect(rest[0]!.text).toMatch(/_History: .*funded/);
  });

  it("history lines: a grant's last human entry; the building's previous rollup decision; a 1:1 its provenance names; none when nothing applies", () => {
    const { world, admin, manager, proposal, rollup } = setup();
    const g = proposal();
    world.grantDesk.decide(admin, g.id, { action: "counter", note: "halve the ask" });
    world.grantDesk.update(manager, g.id, { askTokens: 500_000 });
    world.grantDesk.propose(manager, g.id);
    rollup(["None"], ago(30), { decision: "approve", note: "ship the deck first" });
    const r = rollup(["Go?"], ago(1));
    const deck = ours(reviewDeck(world)).slice(1);
    const gs = deck.find((s) => s.grantId === g.id)!;
    expect(gs.history).toMatch(/countered .* ago: "halve the ask"/);
    const rs = deck.find((s) => s.itemId === r.id)!;
    expect(rs.history).toMatch(/replied to the previous rollup "Rollup .*" .* ago: "ship the deck first"/);

    // a plain report citing a 1:1 with a human decision
    const m = world.meetings.upsert({ id: newId("mt"), kind: "one-on-one", buildingId: LAB, title: "1:1", scheduledAt: nowIso(), phase: "done", facilitatorId: manager.id, attendeeIds: [manager.id], agenda: "", brings: {}, askHumans: false, summaries: {}, transcript: [], decisions: [{ text: "Build the review deck", assigneeId: null, assignmentId: null }], notesDocId: null, withUserId: admin.id, createdAt: nowIso(), startedAt: nowIso(), endedAt: nowIso() } as never);
    const other = createDoc(world, { type: "report", title: "Visitor report", body: "# Visitor report\nhello", authorId: manager.id, authorKind: "agent", buildingId: "town-hall", state: "building", tags: ["visitor"], decision: "pending", provenance: { sourceIds: [m.id], urls: [] } } as never);
    const os = ours(reviewDeck(world)).find((s) => s.itemId === other.id)!;
    expect(os).toMatchObject({ kind: "report", docIds: [other.id] });
    expect(os.history).toBe(`In 1:1 ${m.id}: "Build the review deck"`);
    // a fresh proposal with no human entry has no history line
    const fresh = proposal(world.grantDesk.keyResults(LAB)[1]!.id);
    const fs = ours(reviewDeck(world)).find((s) => s.grantId === fresh.id)!;
    expect(fs.history).toBe("");
    expect(fs.text).not.toMatch(/History:/);
  });

  it("a decision made on a slide carries payload.deckSlide (grant decide and report archive)", () => {
    const { world, admin, proposal, rollup } = setup();
    const g = proposal();
    world.grantDesk.decide(admin, g.id, { action: "reject", deckSlide: 3 });
    expect(world.events.list({ types: ["grant.rejected"] }).at(-1)!.payload).toMatchObject({ grantId: g.id, deckSlide: 3 });
    const r = rollup(["Go?"], ago(1));
    world.ops.archiveReport(admin, r.id, { deckSlide: 4 });
    expect(world.events.list({ types: ["doc.decision"] }).at(-1)!.payload).toMatchObject({ docId: r.id, deckSlide: 4 });
    const r2 = rollup(["Go?"], ago(1));
    world.ops.archiveReport(admin, r2.id);
    expect(world.events.list({ types: ["doc.decision"] }).at(-1)!.payload).not.toHaveProperty("deckSlide");
  });

  it("the proposal slide shows a long approach whole (no-truncation rule)", async () => {
    const { world, manager, krs } = setup();
    const approach = `${"Step one adds a Goals tab next to Tab. ".repeat(24)}The last words stay.`;
    expect(approach.length).toBeGreaterThan(900);
    const r = await world.verbs.propose_grant(manager, { keyResultId: krs[0]!.id, objective: "Long approach", stopCondition: "done", askTokens: 100_000, testingPlan: [], findingsDocIds: [], approach, note: "" });
    const s = ours(reviewDeck(world)).find((x) => x.grantId === r.grantId)!;
    expect(s.text).toContain(approach.trim());
    expect(s.text).not.toMatch(/…/);
  });

  it("propose_grant stores picture and whatYoudSee; the proposal slide shows the picture when the media exists", async () => {
    const { world, manager, krs } = setup();
    const media = world.media.put(manager.id, "image/png", Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
    const r = await world.verbs.propose_grant(manager, { keyResultId: krs[0]!.id, objective: "With a picture", stopCondition: "done", askTokens: 100_000, picture: media.id, whatYoudSee: "The in-tray shows it", testingPlan: [], findingsDocIds: [], approach: "", note: "" });
    expect(world.grants.require(r.grantId)).toMatchObject({ picture: media.id, whatYoudSee: "The in-tray shows it" });
    const s = ours(reviewDeck(world)).find((x) => x.grantId === r.grantId)!;
    expect(s.pictures[0]!.src).toBe(media.url);
  });

  it("a findings doc's example picture (`mf_….png`, no such media) is skipped; the first real one is shown, else no picture (mt_xywhisvdcm)", () => {
    const { world, manager, krs } = setup();
    const media = world.media.put(manager.id, "image/png", Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
    const design = createDoc(world, { type: "note", title: "design", body: "Paste gives `![alt](/api/media/mf_….png)`:\n![alt](/api/media/mf_….png)\n![gone](/api/media/mf_nope.png)", authorId: manager.id, authorKind: "agent", buildingId: LAB, state: "building" });
    const shot = createDoc(world, { type: "note", title: "shot", body: `![the deck](${media.url})`, authorId: manager.id, authorKind: "agent", buildingId: LAB, state: "building" });
    const plan = (findingsDocIds: string[]) => world.grantDesk.propose(manager, world.grantDesk.create(manager, LAB, { keyResultId: krs[0]!.id, objective: `Plan ${findingsDocIds.length}`, approach: "", stopCondition: "done", askTokens: 1000, testingPlan: [], findingsDocIds }).id);
    const without = plan([design.id]);
    const withShot = plan([design.id, shot.id]);
    const slides = reviewDeck(world).slides;
    const a = slides.find((x) => x.grantId === without.id)!;
    expect(a.pictures).toEqual([]);
    expect(a.text).toContain("_no picture_");
    expect(slides.find((x) => x.grantId === withShot.id)!.pictures).toEqual([{ alt: "the deck", src: media.url }]);
  });

  it("presented in a meeting, the slide list is pinned: a decided item's slide keeps its number, marked decided; new items append (mt_xywhisvdcm)", () => {
    const { world, admin, proposal, rollup } = setup();
    const g1 = proposal();
    const g2 = proposal(undefined);
    const m = world.ops.createMeeting(admin, { kind: "in-tray-review", buildingId: null, startNow: true, deck: { docId: REVIEW_DECK_ID } });
    expect(m.deck?.pinned?.length).toBe(reviewDeck(world).slides.length);
    const before = presentedReviewDeck(world, m.deck!.pinned).slides;
    const at = before.findIndex((s) => s.grantId === g1.id);
    world.ops.meetingPresent(admin, m.id, REVIEW_DECK_ID, at + 1);
    world.grantDesk.decide(admin, g1.id, { action: "reject", deckSlide: at + 1 });
    const r = rollup(["Go?"], ago(0.1));
    expect(reviewDeck(world).slides.some((s) => s.grantId === g1.id)).toBe(false); // the live deck dropped it
    const pinned = world.meetings.require(m.id).deck!.pinned;
    const after = presentedReviewDeck(world, pinned).slides;
    expect(after.slice(0, before.length).map((s) => s.key)).toEqual(before.map((s) => s.key));
    expect(after[at]).toMatchObject({ grantId: g1.id, decided: "rejected" });
    expect(after[at]!.text).toMatch(/^_Decided: rejected_/);
    expect(after.find((s) => s.grantId === g2.id)!.decided).toBeUndefined();
    expect(after.at(-1)!.docIds).toEqual([r.id]);
    // moving on keeps the numbering, and the transcript line names the pinned slide
    const moved = world.ops.meetingPresent(admin, m.id, REVIEW_DECK_ID, after.length);
    expect(moved.transcript.at(-1)!.text).toBe(`— slide ${after.length}: ${after.at(-1)!.title}`);
    expect(moved.deck!.pinned!.map((p) => p.key)).toEqual(after.map((s) => s.key));
  });
});
