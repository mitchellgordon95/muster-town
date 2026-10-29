import { describe, expect, it } from "vitest";
import { MEETING_PRESETS } from "@muster-town/schema";
import { facilitatePrompt, summarySystemPrompt } from "../src/prompts.ts";
import { agendaText } from "../src/meetings.ts";
import { seededWorld } from "./helpers.ts";

// gr_jh0lu0w6yj step 2: one "Call a meeting" form (Lena's dc_tcoy1plt2r): agenda items, what attendees bring, the "ask the humans" opener
describe("Call a meeting form", () => {
  it("stores agenda items as numbered lines, brings and askHumans (default: kind is town-hall)", async () => {
    const { world, by, admin } = seededWorld();
    const m = world.ops.createMeeting(admin, { kind: "retro", buildingId: "carbon-cycle", startNow: true, agenda: ["Why the land sink run failed", " ", "Next week's order"], brings: { mode: "custom", text: "What went worst and why" } });
    expect(m.agenda).toBe("1. Why the land sink run failed\n2. Next week's order");
    expect(m.brings).toEqual({ mode: "custom", text: "What went worst and why" });
    expect(m.askHumans).toBe(false);
    expect(m.phase).toBe("collecting");
    const invite = (await world.verbs.inbox(by("Mei"), {})).messages.find((x) => x.kind === "meeting" && x.meetingId === m.id);
    expect(invite?.body).toContain("Bring: What went worst and why");
    expect(world.meetings.require(m.id)).toMatchObject({ brings: { mode: "custom" }, askHumans: false });
    const hall = world.ops.createMeeting(admin, { kind: "town-hall", buildingId: null });
    expect(world.meetings.require(hall.id)).toMatchObject({ askHumans: true, brings: { mode: "status", text: "" }, agenda: "" });
    expect(world.ops.createMeeting(admin, { kind: "standup", buildingId: "carbon-cycle", askHumans: true }).askHumans).toBe(true);
  });

  it("brings nothing: straight into discussing, no summary round; custom needs its text", () => {
    const { world, by, admin } = seededWorld();
    const m = world.ops.createMeeting(admin, { kind: "in-tray-review", buildingId: "carbon-cycle", startNow: true, brings: { mode: "nothing", text: "" } });
    expect(m.phase).toBe("discussing");
    expect(world.agents.require(by("Mei").id).status).toBe("in-meeting");
    expect(() => world.ops.createMeeting(admin, { kind: "retro", buildingId: "carbon-cycle", brings: { mode: "custom", text: "  " } })).toThrow(/custom/);
  });

  it("the notes say what attendees brought and whether it opened with the humans' decisions", async () => {
    const { world, by, admin } = seededWorld();
    const m = world.ops.createMeeting(admin, { kind: "planning", buildingId: "carbon-cycle", startNow: true, agenda: ["Pick the next KR"], brings: { mode: "nothing", text: "" }, askHumans: true });
    world.meetings.upsert({ ...world.meetings.require(m.id), transcript: [] });
    const end = await world.verbs.meeting(by("Moss"), { meetingId: m.id, action: "end" });
    const notes = world.docs.require((end as { notesDocId: string }).notesDocId);
    expect(notes.body).toContain("Attendees brought: nothing");
    expect(notes.body).toContain("Opened with decisions needed from the humans.");
    expect(notes.body).toContain("1. Pick the next KR");
  });

  it("facilitator prompt: agenda items in order, the opener follows askHumans not kind, brings shapes the attendee list", () => {
    const { world, admin } = seededWorld();
    const base = world.ops.createMeeting(admin, { kind: "town-hall", buildingId: null, agenda: ["Fund the deck grant?", "Hosted checklist"], askHumans: false, brings: { mode: "nothing", text: "" } });
    const p = facilitatePrompt(base, (id) => world.nameOf(id));
    expect(p).toContain("Cover these, in order, before your own items:\n1. Fund the deck grant?\n2. Hosted checklist");
    expect(p).not.toContain("Decisions needed from the humans");
    expect(p).toContain("asked to bring nothing");
    const asking = facilitatePrompt({ ...base, kind: "standup", askHumans: true }, (id) => world.nameOf(id));
    expect(asking).toContain("Decisions needed from the humans");
    expect(asking).toContain("then the agenda above, in its order");
    const custom = facilitatePrompt({ ...base, agenda: "", brings: { mode: "custom", text: "Your proposed next work" } }, (id) => world.nameOf(id));
    expect(custom).toContain("Attendees were asked to bring: \"Your proposed next work\"");
    expect(custom).toContain("propose 2-4 items");
  });

  it("summary prompt: custom brings replaces Did/Next/Need; status keeps it", () => {
    const { by } = seededWorld();
    expect(summarySystemPrompt(by("Mei"))).toContain("Did:");
    const custom = summarySystemPrompt(by("Mei"), { mode: "custom", text: "The work you propose next and its cost in tokens" });
    expect(custom).toContain("The work you propose next and its cost in tokens");
    expect(custom).not.toContain("Did:");
  });

  it("presets: six, each kind a valid label; agendaText keeps a string as written", () => {
    expect(MEETING_PRESETS.map((p) => p.label)).toEqual(["Standup", "Town hall", "Review the in-tray", "Retro", "Planning", "Blank"]);
    expect(MEETING_PRESETS.find((p) => p.id === "town-hall")?.askHumans).toBe(true);
    expect(agendaText("Free text")).toBe("Free text");
    expect(agendaText(undefined)).toBe("");
  });
});
