import { describe, expect, it } from "vitest";
import { MEETING_PRESETS, REVIEW_DECK_ID } from "@muster-town/schema";
import { createDoc } from "../src/index.ts";
import { currentSlide } from "../src/meetings.ts";
import { facilitateMaterial } from "../src/prompts.ts";
import { seededWorld } from "./helpers.ts";

const BODY = "# Bank day\n\nOpening.\nNotes: say hello\n---\n## Spend\n\n400k today\n---\n## Next\n\nAsk for the grant";

// gr_jh0lu0w6yj step 5 (design dc_y7a8g257of §1/§3): Presentation with chat
describe("presentation mode", () => {
  const setup = () => {
    const f = seededWorld();
    const deck = createDoc(f.world, { type: "deck", title: "Bank day", body: BODY, authorId: f.by("Mei").id, authorKind: "agent", buildingId: "carbon-cycle", state: "building" });
    const m = f.world.ops.createMeeting(f.admin, { kind: "ad-hoc", buildingId: "carbon-cycle", startNow: true, brings: { mode: "nothing", text: "" } });
    return { ...f, deck, m };
  };

  it("the deck column round-trips; each slide move posts '— slide n: <title>' to the transcript once", () => {
    const { world, admin, deck, m } = setup();
    world.ops.meetingPresent(admin, m.id, deck.id, 1);
    world.ops.meetingPresent(admin, m.id, deck.id, 2);
    world.ops.meetingPresent(admin, m.id, deck.id, 2); // same slide: no second line
    world.ops.meetingPresent(admin, m.id, deck.id, 9); // clamped to the last
    const saved = world.meetings.require(m.id);
    expect(saved.deck).toEqual({ docId: deck.id, slide: 3, presenterId: world.holderOf(admin).id });
    const lines = saved.transcript.filter((u) => u.speakerKind === "system").map((u) => u.text);
    expect(lines).toEqual([`— ${admin.name} is presenting "Bank day" (3 slides)`, "— slide 1: Bank day", "— slide 2: Spend", "— slide 3: Next"]);
    expect(world.events.recent({ limit: 200 }).filter((e) => e.type === "meeting.slide")).toHaveLength(3);
    world.ops.meetingPresent(admin, m.id, null);
    expect(world.meetings.require(m.id).deck).toBeNull();
  });

  it("only a deck doc or the review deck; a resident who doesn't run the meeting can't move slides", () => {
    const { world, admin, by, m } = setup();
    const note = createDoc(world, { type: "note", title: "n", body: "x", authorId: by("Mei").id, authorKind: "agent", buildingId: "carbon-cycle", state: "building" });
    expect(() => world.ops.meetingPresent(admin, m.id, note.id, 1)).toThrow(/not a deck/);
    expect(() => world.ops.meetingPresent(by("Mei"), m.id, REVIEW_DECK_ID, 1)).toThrow(/facilitator or a human/);
    const r = world.ops.meetingPresent(admin, m.id, REVIEW_DECK_ID, 1);
    expect(r.deck?.docId).toBe(REVIEW_DECK_ID);
    expect(r.transcript.at(-1)?.text).toMatch(/^— slide 1/);
  });

  it("called as Presentation: the deck starts on slide 1; the facilitator's material and listen carry the current slide", async () => {
    const { world, admin, by, deck } = setup();
    const m = world.ops.createMeeting(admin, { kind: "ad-hoc", buildingId: "carbon-cycle", startNow: true, brings: { mode: "nothing", text: "" }, deck: { docId: deck.id } });
    expect(m.deck).toEqual({ docId: deck.id, slide: 1, presenterId: world.holderOf(admin).id });
    expect(currentSlide(world, m)).toMatchObject({ n: 1, count: 3, title: "Bank day", notes: "say hello", nextTitle: "Spend" });
    world.ops.meetingPresent(admin, m.id, deck.id, 2);
    const now = world.meetings.require(m.id);
    const material = facilitateMaterial(world, now);
    expect(material).toContain('Presenting: "Bank day", slide 2 of 3 "Spend"');
    expect(material).toContain("400k today");
    const heard = await world.verbs.meeting(by("Moss"), { meetingId: m.id, action: "listen" }) as { slide?: { n: number; title: string } };
    expect(heard.slide).toMatchObject({ n: 2, title: "Spend" });
    expect(() => world.ops.createMeeting(admin, { kind: "ad-hoc", buildingId: "carbon-cycle", deck: { docId: "dc_nope" } })).toThrow();
  });

  it("a decision made on a slide is also a meeting decision, naming the slide", () => {
    const { world, admin, deck, m } = setup();
    world.ops.meetingPresent(admin, m.id, deck.id, 2);
    const r = createDoc(world, { type: "report", title: "Prod rollup", body: "# r", authorId: world.agents.all()[0]!.id, authorKind: "agent", buildingId: "carbon-cycle", state: "building", decision: "pending" } as never);
    world.ops.archiveReport(admin, r.id, { deckSlide: 2 });
    world.ops.slideReplyDecision(admin, m.id, r.id, "");
    const d = world.meetings.require(m.id).decisions.at(-1);
    expect(d).toMatchObject({ text: `${admin.name} approved ${r.id} "Prod rollup" (on slide 2)`, assigneeId: null });
    const ev = world.events.recent({ limit: 200 }).find((e) => e.type === "meeting.decisions");
    expect(ev?.payload).toMatchObject({ meetingId: m.id, deckSlide: 2 });
    expect(world.events.recent({ limit: 200 }).find((e) => e.type === "doc.decision")?.payload).toMatchObject({ deckSlide: 2 });
  });

  it("the Review the in-tray preset is Presentation with the review deck", () => {
    expect(MEETING_PRESETS.find((p) => p.id === "in-tray-review")).toMatchObject({ deck: REVIEW_DECK_ID, brings: { mode: "nothing" }, askHumans: true });
    expect(MEETING_PRESETS.filter((p) => p.deck)).toHaveLength(1);
  });
});
