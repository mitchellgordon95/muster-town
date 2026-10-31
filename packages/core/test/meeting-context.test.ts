/** Grant gr_jh0lu0w6yj step 1 (town hall mt_1u7mwyjrrz): meeting sessions run on the agent's full context. */
import { describe, expect, it, vi } from "vitest";
import { createBuilding, createResident, facilitateSystemPrompt, humanDecisionsBlock, meetingContextBlock, oneOnOnePrompt, sessionMemory, summaryPrompt, updateBuilding, workSystemPrompt } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

vi.setConfig({ testTimeout: 60_000 }); // seeding a world is slow on a loaded desk

function lab() {
  const s = seededWorld();
  const { world, seed } = s;
  const b = createBuilding(world, { name: "Ctx Lab", headcount: 3, dailyTokensPerAgent: 100_000, model: "claude-opus-5-5" }, seed.admin.id);
  const pix = createResident(world, { buildingId: b.id, name: "Pix" });
  const ann = createResident(world, { buildingId: b.id, name: "Ann" });
  updateBuilding(world, b.id, { managerAgentId: pix.id });
  const agent = (id: string) => world.agents.require(id);
  const write = (who: string, input: { title: string; body: string; topicOf?: string }) => world.verbs.write(agent(who), { type: "wiki", state: "draft", ...input });
  /** a meeting closed at `at`, so the order of "since the last one" doesn't hang on the clock */
  const closeAt = (id: string, at: string) => { world.ops.endMeeting(s.admin, id); world.meetings.upsert({ ...world.meetings.require(id), endedAt: at }); };
  return { ...s, b: world.buildings.require(b.id), pix: agent(pix.id), ann: agent(ann.id), agent, write, closeAt };
}

describe("meeting sessions load the full context", () => {
  it("a town-hall facilitator prompt carries a 1:1 decision made after the last town hall, with its meeting id, and the facilitator's wiki page", async () => {
    const { world, admin, b, pix, write, closeAt } = lab();
    await write(pix.id, { title: "Review deck", body: "The deck grant is funded." });
    const th1 = world.ops.createMeeting(admin, { kind: "town-hall", buildingId: null, startNow: true });
    world.ops.meetingDecide(null, th1.id, [{ text: "Old town-hall decision", assigneeId: null, assignmentId: null }]);
    closeAt(th1.id, "2026-10-28T17:00:00.000Z");
    const early = world.ops.openOneOnOne(admin, b.id);
    world.ops.meetingDecide(null, early.id, [{ text: "Decided before the town hall", assigneeId: null, assignmentId: null }]);
    closeAt(early.id, "2026-10-28T16:00:00.000Z");
    const oo = world.ops.openOneOnOne(admin, b.id);
    world.ops.meetingDecide(null, oo.id, [{ text: "Forks stay on for the Workshop", assigneeId: null, assignmentId: null }]);
    closeAt(oo.id, "2026-10-28T19:06:00.000Z");
    const th2 = world.ops.createMeeting(admin, { kind: "town-hall", buildingId: null, startNow: true });
    const sys = facilitateSystemPrompt(pix, undefined, world.town.get(), meetingContextBlock(world, pix, world.meetings.require(th2.id)));
    expect(sys).toContain("Forks stay on for the Workshop");
    expect(sys).toContain(`${oo.id} one-on-one 2026-10-28 19:06 UTC (Ctx Lab) #1`);
    expect(sys).toContain(`since the last town-hall (${th1.id}`);
    expect(sys).not.toContain("Decided before the town hall");
    expect(sys).not.toContain("Old town-hall decision");
    expect(sys).toContain("### Review deck");
  });

  it("an attendee's summary prompt carries its own wiki page, the building's topic pages (a cut one names its id)", async () => {
    const { world, admin, b, pix, ann, write } = lab();
    await write(ann.id, { title: "Carbon budget", body: "Ann's notes: 1.5 C budget is ~130 GtCO2." });
    const long = "x".repeat(4000);
    const { id: tp } = await write(pix.id, { title: "Meetings", body: long, topicOf: b.id });
    const m = world.meetings.require(world.ops.createMeeting(admin, { kind: "standup", buildingId: b.id, startNow: true }).id);
    const ctx = meetingContextBlock(world, ann, m);
    const p = summaryPrompt(m, undefined, [], undefined, null, ctx);
    expect(p).toContain("### Carbon budget");
    expect(p).toContain("1.5 C budget");
    expect(p).toContain("## Topic pages (the building's shared wiki");
    expect(p).toContain(`…(cut: page is 4000 chars; \`read\` ${tp} for the rest)`);
    expect(p).toContain("## Decisions from meetings with a human since the last standup\n(none)");
  });

  it("a 1:1 facilitator (the manager's session) carries the building's topic index, and its prompt the decisions since the last 1:1", async () => {
    const { world, admin, b, pix, write, closeAt } = lab();
    const { id: tp } = await write(pix.id, { title: "Live checks", body: "GET /api/health for the commit.", topicOf: b.id });
    const prev = world.ops.openOneOnOne(admin, b.id);
    closeAt(prev.id, "2026-10-28T10:00:00.000Z");
    const standup = world.ops.createMeeting(admin, { kind: "standup", buildingId: b.id, startNow: true });
    world.meetings.upsert({ ...world.meetings.require(standup.id), transcript: [{ speakerId: admin.id, speakerKind: "user", text: "Ship the deck first.", at: "2026-10-28T10:30:00.000Z" }] });
    world.ops.meetingDecide(null, standup.id, [{ text: "Deck before forms", assigneeId: null, assignmentId: null }]);
    closeAt(standup.id, "2026-10-28T11:00:00.000Z");
    const oo = world.ops.openOneOnOne(admin, b.id);
    const system = workSystemPrompt(pix, b, world.town.get(), sessionMemory(world, pix, b));
    expect(system).toContain(`"Live checks" (${tp}`);
    const prompt = oneOnOnePrompt(oo, (id) => world.nameOf(id), humanDecisionsBlock(world, oo));
    expect(prompt).toContain(`${standup.id} standup 2026-10-28 11:00 UTC #1: Deck before forms`);
  });

  it("topic page bodies share the wiki budget forks use (WIKI_TOTAL_CAP): a full wiki leaves room only for the index", async () => {
    const { world, admin, b, ann, pix, write } = lab();
    for (const t of ["A", "B", "C", "D"]) await write(ann.id, { title: `Notes ${t}`, body: "y".repeat(2400) });
    await write(pix.id, { title: "Deploys", body: "Drain then restart.", topicOf: b.id });
    const m = world.meetings.require(world.ops.createMeeting(admin, { kind: "standup", buildingId: b.id, startNow: true }).id);
    const ctx = meetingContextBlock(world, ann, m);
    expect(ctx).toContain(`"Deploys" (`);
    expect(ctx).not.toContain("### Deploys");
    expect(ctx).not.toContain("## Topic pages, newest first");
  });
});
