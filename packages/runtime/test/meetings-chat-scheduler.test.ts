import { describe, expect, test } from "vitest";
import { COLLECTING_MS, MEETING_REPLIES_MAX, SUMMARY_MODEL } from "../src/index.ts";
import { callVerb, deferred, init, result, setup, text, type FakeSession } from "./helpers.ts";

const systemOf = (s: FakeSession) => String(s.options.systemPrompt ?? "");

describe("meetings", () => {
  test("a failed summary call records an error, not its error text as the summary", async () => {
    const { world, runtime, lab } = setup(async function* (s) {
      if (!s.agentId) {
        yield text("Not logged in · Please run /login");
        yield { ...result(0, 0, "Not logged in · Please run /login"), subtype: "error_during_execution", is_error: true };
      }
    });
    const m = world.ops.createMeeting(null, { kind: "standup", buildingId: lab.id, startNow: true });
    await runtime.onMeetingStart(m.id);
    await runtime.whenIdle();
    expect(world.meetings.require(m.id).summaries).toEqual({});
    expect(world.sessions.count("purpose = 'summary' AND status = 'error'")).toBe(m.attendeeIds.length);
  });

  test("collecting → summaries → discussing (as soon as all are in) → decisions create assignments → notes doc", async () => {
    let mossId = "", noorId = "";
    const { world, runtime, sdk, clock, by, lab } = setup(async function* (s) {
      if (!s.agentId) { // one-shot summary (no tools)
        const summary = "Did: read the board.\nFound: growth 2.4 ± 0.1 ppm/yr.\nNeed: 13C data.";
        yield text(summary);
        yield result(80, 0.001, summary);
        return;
      }
      if (s.agentId === mossId) {
        const meetingId = /meeting (mt_[\w-]+)/.exec(s.received[0])![1];
        yield init();
        yield* callVerb(s, "meeting", { meetingId, action: "speak", text: "Agenda: growth rate, then 13C." });
        yield* callVerb(s, "meeting", { meetingId, action: "listen" });
        yield* callVerb(s, "meeting", { meetingId, action: "listen" });
        yield* callVerb(s, "meeting", { meetingId, action: "decide", decisions: [{ text: "Pull the 13C record from NOAA", assigneeId: noorId }, { text: "Keep the board tidy", assigneeId: null }] });
        yield* callVerb(s, "meeting", { meetingId, action: "end", text: "Thanks all." });
        yield result(500, 0.05);
      }
    });
    mossId = by("Moss").id;
    noorId = by("Noor").id;
    const m = world.ops.createMeeting(null, { kind: "standup", buildingId: lab.id, startNow: true });
    expect(m.phase).toBe("collecting");
    await expect(world.verbs.meeting(by("Noor").id, { meetingId: m.id, action: "speak", text: "early" })).rejects.toMatchObject({ code: "conflict" });
    await runtime.onMeetingStart(m.id);
    await runtime.whenIdle();
    const cur = world.meetings.require(m.id);
    expect(Object.keys(cur.summaries).sort()).toEqual([...cur.attendeeIds].sort());
    expect(cur.summaries[noorId]).toBe("Did: read the board.\nFound: growth 2.4 ± 0.1 ppm/yr.\nNeed: 13C data.");
    const summarySession = sdk.sessions.find((s) => !s.agentId)!;
    expect(summarySession.options.model).toBe(SUMMARY_MODEL); // not the building's cheapModel (that stays for the proxy chat)
    expect(SUMMARY_MODEL).not.toBe(lab.cheapModel);
    expect(summarySession.options.tools).toEqual([]);
    expect(world.sessions.count("purpose = 'summary' AND status = 'done'")).toBe(cur.attendeeIds.length);
    expect(sdk.sessions.filter((s) => !s.agentId)).toHaveLength(cur.attendeeIds.length); // no double summaries

    // the last summary started the discussion without waiting out COLLECTING_MS; the facilitator ran and ended it
    expect(cur.phase).toBe("done");
    expect(cur.transcript.some((u) => u.text === "early")).toBe(false);
    expect(sdk.sessions.filter((s) => s.agentId === mossId)).toHaveLength(1);
    expect(cur.transcript.map((u) => u.text)).toContain("Agenda: growth rate, then 13C.");
    expect(cur.decisions).toHaveLength(2);
    const asg = world.assignments.require(cur.decisions[0].assignmentId!);
    expect(asg).toMatchObject({ agentId: noorId, fromMeetingId: m.id, status: "pending" });
    const notes = world.docs.require(cur.notesDocId!);
    expect(notes).toMatchObject({ type: "meeting-notes", state: "building", buildingId: lab.id });
    expect(notes.body).toContain("Pull the 13C record from NOAA");
    expect(world.sessions.first("agentId = ? AND purpose = 'facilitate'", [mossId])).toMatchObject({ status: "done", meetingId: m.id });
    for (const id of cur.attendeeIds) expect(world.agents.require(id).status).not.toBe("in-meeting");
  });

  test("the runtime closes a meeting the facilitator didn't end", async () => {
    const { world, runtime, lab } = setup(async function* () { yield init(); yield result(10, 0); });
    const m = world.ops.createMeeting(null, { kind: "retro", buildingId: lab.id, startNow: true });
    world.ops.startMeeting(null, m.id);
    await runtime.whenIdle();
    const cur = world.meetings.require(m.id);
    expect(cur.phase).toBe("done");
    expect(world.docs.require(cur.notesDocId!).body).toContain("closed by the town");
  });
});

describe("questioning attendees", () => {
  const replyScript = (seen: string[]) => async function* (s: FakeSession) {
    const sys = systemOf(s);
    if (!s.agentId && sys.includes("addressed you")) { // one-shot meeting reply (no tools)
      const name = /^You are (\w+)/.exec(sys)![1];
      seen.push(s.received[0]);
      const reply = name === "Noor" ? "Growth is 2.4 ± 0.1 ppm/yr; Tomas has the 13C side." : `${name} here.`;
      yield text(reply);
      yield result(60, 0.002, reply);
      return;
    }
    yield init();
    yield result(10, 0);
  };

  test("a facilitator's @mention gets the attendee's reply in the meeting; an attendee's mention wakes no one", async () => {
    const prompts: string[] = [];
    const { world, runtime, sdk, by, lab } = setup(replyScript(prompts));
    const noor = by("Noor"), tomas = by("Tomas");
    world.agents.patch(noor.id, { model: "claude-sonnet-5-5" }); // the resident's own model, not the building's
    const m = world.ops.createMeeting(null, { kind: "standup", buildingId: lab.id, attendeeIds: [noor.id, tomas.id] });
    world.meetings.upsert({ ...world.meetings.require(m.id), phase: "discussing" }); // no facilitation session
    const fac = world.meetings.require(m.id).facilitatorId!;
    await world.verbs.meeting(fac, { meetingId: m.id, action: "speak", text: "@Noor where is the growth rate?" });
    await runtime.whenIdle();
    let cur = world.meetings.require(m.id);
    expect(cur.transcript.at(-1)).toMatchObject({ speakerId: noor.id, text: "Growth is 2.4 ± 0.1 ppm/yr; Tomas has the 13C side." });
    expect(prompts[0]).toContain("@Noor where is the growth rate?");
    expect(prompts[0]).toContain("My latest report:");
    const reply = sdk.sessions.find((s) => systemOf(s).includes("addressed you"))!;
    expect(reply.options.tools).toEqual([]);
    expect(reply.options.model).toBe("claude-sonnet-5-5"); // @-replies run on the resident's configured model
    expect(world.sessions.first("agentId = ? AND purpose = 'meeting-reply'", [noor.id])).toMatchObject({ status: "done", meetingId: m.id, model: "claude-sonnet-5-5" });

    // Noor's reply named Tomas without "@"; an attendee's @mention doesn't wake anyone either
    await world.verbs.meeting(noor.id, { meetingId: m.id, action: "speak", text: "@Tomas can you add the 13C numbers?" });
    await runtime.whenIdle();
    cur = world.meetings.require(m.id);
    expect(cur.transcript.at(-1)!.speakerId).toBe(noor.id);
    expect(prompts).toHaveLength(1);
  });

  test("a human's @mention wakes the attendee; replies stop at the cap", async () => {
    const prompts: string[] = [];
    const { world, runtime, seed, by, lab } = setup(replyScript(prompts));
    const tomas = by("Tomas");
    const human = world.ops.ensureAvatar(seed.admin.id);
    const m = world.ops.createMeeting(null, { kind: "standup", buildingId: lab.id, attendeeIds: [tomas.id] });
    world.meetings.upsert({ ...world.meetings.require(m.id), phase: "discussing" });
    for (let i = 0; i < MEETING_REPLIES_MAX + 2; i++) {
      await world.verbs.meeting(human.id, { meetingId: m.id, action: "speak", text: `@Tomas question ${i}?` });
      await runtime.whenIdle();
    }
    const replies = world.meetings.require(m.id).transcript.filter((u) => u.speakerId === tomas.id);
    expect(replies).toHaveLength(MEETING_REPLIES_MAX);
    expect(replies[0].text).toBe("Tomas here.");
    expect(prompts).toHaveLength(MEETING_REPLIES_MAX);
  });
});

describe("proxy chat", () => {
  test("resident answers in first person with cheapModel and no tools", async () => {
    const { world, runtime, sdk, by, lab } = setup(async function* () {
      yield text("I'm measuring the CO2 growth rate.");
      yield result(40, 0.0005, "I'm measuring the CO2 growth rate.");
    });
    const noor = by("Noor");
    const r = await runtime.chat(noor.id, { message: "What are you doing?", history: [{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }] });
    expect(r.reply).toBe("I'm measuring the CO2 growth rate.");
    const s = sdk.sessions[0];
    expect(systemOf(s)).toContain("Noor's desk assistant");
    expect(s.options.model).toBe(lab.cheapModel);
    expect(s.options.tools).toEqual([]);
    expect(s.options.maxTurns).toBe(1);
    expect(s.received[0]).toContain("Visitor: What are you doing?");
    expect(world.agents.require(noor.id).spentTokensToday).toBe(40);
  });

  test("the proxy sees the agent's recent work and wiki", async () => {
    const { world, runtime, sdk, by } = setup(async function* () { yield result(10, 0.0001, "ok"); });
    const noor = by("Noor");
    await world.verbs.write(noor.id, { type: "wiki", title: "Airborne fraction", body: "Picked the 10-year mean.", state: "draft" });
    await world.verbs.write(noor.id, { type: "note", title: "Dashboard number", body: "0.44 ± 0.03", state: "building" });
    await runtime.chat(noor.id, { message: "Which number did you pick?" });
    const ctx = sdk.sessions[0].received[0];
    expect(ctx).toContain("## Your recent work");
    expect(ctx).toContain('note "Dashboard number"');
    expect(ctx).toContain("## Noor's wiki (private working notes)");
    expect(ctx).toContain("### Airborne fraction");
    expect(ctx).toContain("Picked the 10-year mean.");
  });

  test("librarian answers from the library index and search hits", async () => {
    const { world, runtime, sdk, seed } = setup(async function* () {
      yield result(40, 0.0005, "See the Global Carbon Budget source card.");
    });
    const lib = world.docs.first("state = 'library'")!;
    const r = await runtime.chat(seed.ada!.id, { message: lib.title });
    expect(r.reply).toBe("See the Global Carbon Budget source card.");
    expect(systemOf(sdk.sessions[0])).toContain("librarian");
    expect(sdk.sessions[0].received[0]).toContain("Library index:");
    expect(sdk.sessions[0].received[0]).toContain(lib.id);
    expect(world.events.list({ types: ["budget.exhausted"] })).toHaveLength(0);
  });
});

describe("ask about a report", () => {
  test("answers from the report, the author's events and the building goal with cheapModel, not as the author", async () => {
    const { world, runtime, sdk, by, lab, seed } = setup(async function* () {
      yield result(30, 0.0003, "The report says growth is 2.4 ppm/yr.");
    });
    const noor = by("Noor");
    const report = world.docs.upsert({ ...world.docs.first("type = 'report'")!, id: "dc_ask", authorId: noor.id, buildingId: lab.id, title: "Growth rate", body: "## Findings\nGrowth 2.4 ppm/yr." });
    const r = await runtime.askAbout(report.id, "What growth did they find?", seed.admin.id);
    expect(r.reply).toBe("The report says growth is 2.4 ppm/yr.");
    const s = sdk.sessions[0];
    expect(s.options.model).toBe(lab.cheapModel);
    expect(s.options.tools).toEqual([]);
    expect(systemOf(s)).toContain("You are not Noor");
    expect(s.received[0]).toContain("Growth 2.4 ppm/yr.");
    expect(s.received[0]).toContain(`Goal: ${lab.goal || "(none)"}`);
    expect(s.received[0]).toContain("Visitor: What growth did they find?");
  });
});

describe("scheduler", () => {
  test("tickOnce starts a session for an idle resident with a pending assignment, once", async () => {
    const gate = deferred();
    const { world, runtime, sdk, by } = setup(async function* (s) {
      yield init();
      await gate.promise;
      yield* callVerb(s, "submit_report", { title: "t", body: "## Summary\nx", verdict: "continue" });
      yield result(10, 0);
    });
    const tomas = by("Tomas");
    world.ops.createWork(null, tomas.id, { title: "Soil carbon" });
    await runtime.tickOnce();
    expect(runtime.isWorking(tomas.id)).toBe(true);
    expect(world.agents.require(tomas.id).status).toBe("working");
    await runtime.tickOnce();
    await runtime.tickOnce();
    await new Promise((r) => setImmediate(r));
    expect(sdk.sessions).toHaveLength(1);
    expect(world.sessions.count("agentId = ? AND purpose = 'work'", [tomas.id])).toBe(1);
    gate.resolve();
    await runtime.whenIdle();
    expect(world.agents.require(tomas.id).status).toBe("idle");
    expect(runtime.isWorking(tomas.id)).toBe(false);
  });

  test("cadence creates a meeting when due and midnight resets daily spend", async () => {
    // summaries come back empty, so the meeting stays live (collecting) and the next tick must not call another
    const { world, runtime, clock, by, lab } = setup(async function* () { yield result(1, 0, ""); });
    world.ops.updateBuilding(null, lab.id, { meetings: [{ kind: "standup", everyMinutes: 60 }] });
    await runtime.tickOnce();
    expect(world.meetings.count("buildingId = ?", [lab.id])).toBe(0);
    world.agents.patch(by("Mei").id, { spentTokensToday: 999 });
    clock.t += 24 * 3_600_000;
    await runtime.tickOnce();
    await runtime.whenIdle();
    expect(world.meetings.count("buildingId = ? AND kind = 'standup'", [lab.id])).toBe(1);
    expect(world.agents.require(by("Mei").id).spentTokensToday).toBeLessThan(999);
    await runtime.tickOnce();
    expect(world.meetings.count("buildingId = ? AND kind = 'standup'", [lab.id])).toBe(1);
  });
});
