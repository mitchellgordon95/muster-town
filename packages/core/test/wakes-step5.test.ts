/** Wakes step 5 (docs/wakes.md §4): request_human answers, decisions amending an active assignment, human-origin @mentions. */
import { describe, expect, it } from "vitest";
import { createAssignment, decisionWakes, mentionWake, requestAnswerWake, RELAY_MAX_AGE_MS, setAssignmentStatus } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const queued = (world: ReturnType<typeof seededWorld>["world"], agentId: string, prefix: string) =>
  world.assignments.where("agentId = ? AND title LIKE ?", [agentId, `${prefix}%`]);
const interruptsFor = (world: ReturnType<typeof seededWorld>["world"], agentId: string) => world.interrupts.where("agentId = ?", [agentId]);

/** Ingrid asks for a photo; a human answers it. */
async function answered(working: boolean) {
  const s = seededWorld();
  const ingrid = s.by("Ingrid");
  s.world.setStatus(ingrid.id, "idle", "idle");
  if (working) s.world.ops.startSession(ingrid.id, { purpose: "work", model: "m" });
  const { id } = await s.world.verbs.request_human(ingrid, { title: "Photograph thaw slump", body: "If you're near...", location: "Yukon" });
  const human = s.world.ops.createUser("Rando").user;
  const avatar = s.world.ops.ensureAvatar(human.id);
  s.world.ops.requestAction(s.by("Moss"), id, "approve");
  s.world.ops.requestAction(avatar, id, "claim");
  const { request, humanReport } = s.world.ops.requestAction(avatar, id, "done", "Photos attached; slump is 40 m wide.\nMore later.");
  const done = s.world.events.list({ types: ["doc.updated"], limit: 1000 }).at(-1)!;
  return { ...s, ingrid, human, request, answer: humanReport!, done };
}

describe("rule request-answer", () => {
  it("an idle requester gets one pending directed assignment with the answer; a replay writes nothing", async () => {
    const { world, ingrid, human, request, answer, done } = await answered(false);
    const [w] = queued(world, ingrid.id, "Answer to your request");
    expect(w).toMatchObject({ status: "pending", lane: "directed", sourceId: answer.id, createdBy: human.id, createdByKind: "user" });
    expect(w.title).toBe("Answer to your request Photograph thaw slump: Photos attached; slump is 40 m wide.");
    expect(w.description).toContain("More later.");
    expect(w.origin).toMatchObject({ userId: human.id, via: answer.id, hops: 0 });
    expect(requestAnswerWake(world, request, answer, done)).toBeNull();
    expect(queued(world, ingrid.id, "Answer to your request")).toHaveLength(1);
    // the inbox line stays
    expect((await world.verbs.inbox(ingrid, {})).messages.some((m) => m.body.includes(answer.id))).toBe(true);
  });

  it("a requester with a running session is interrupted instead, once", async () => {
    const { world, ingrid, request, answer, done } = await answered(true);
    expect(queued(world, ingrid.id, "Answer to your request")).toHaveLength(0);
    const [it] = interruptsFor(world, ingrid.id);
    expect(it).toMatchObject({ now: true, from: "Rando" });
    expect(it.text).toContain("slump is 40 m wide");
    expect(requestAnswerWake(world, request, answer, done)).toBeNull();
    expect(interruptsFor(world, ingrid.id)).toHaveLength(1);
  });
});

describe("rule decision", () => {
  async function amend(working: boolean) {
    const s = seededWorld();
    const m = s.world.ops.createMeeting(s.admin, { kind: "standup", buildingId: "carbon-cycle", startNow: true });
    s.world.ops.startMeeting(s.admin, m.id);
    const noor = s.by("Noor");
    const decide = (decisions: { text: string; assigneeId: string | null; supersedes?: number }[]) =>
      s.world.verbs.meeting(s.by("Moss"), { meetingId: m.id, action: "decide", decisions: decisions.map((d) => ({ assignmentId: null, ...d })) }) as Promise<{ decisions: { assignmentId: string | null }[] }>;
    const first = await decide([{ text: "Noor: reconcile growth rates", assigneeId: noor.id }]);
    const a = first.decisions[0].assignmentId!;
    setAssignmentStatus(s.world, a, "active");
    if (working) s.world.ops.startSession(noor.id, { purpose: "work", model: "m", assignmentId: a });
    else s.world.setStatus(noor.id, "idle", "idle");
    await decide([{ text: "Noor: reconcile growth rates, NOAA only", assigneeId: noor.id, supersedes: 1 }]);
    const decided = s.world.events.list({ types: ["meeting.decisions"], limit: 100 }).at(-1)!;
    return { ...s, noor, a, decided, decide };
  }

  it("a running session gets the amended decision as an interrupt, once", async () => {
    const { world, noor, decided } = await amend(true);
    const [it] = interruptsFor(world, noor.id);
    expect(it.text).toContain("NOAA only");
    expect(queued(world, noor.id, "Amended in meeting")).toHaveLength(0);
    expect(decisionWakes(world, decided)).toEqual([]);
    expect(interruptsFor(world, noor.id)).toHaveLength(1);
  });

  it("an idle assignee with no session gets a pending assignment carrying the lane; a fresh (non-amending) decision adds none", async () => {
    const { world, noor, a, decided, decide } = await amend(false);
    const [w] = queued(world, noor.id, "Amended in meeting");
    const amended = world.assignments.require(a);
    expect(w).toMatchObject({ status: "pending", lane: amended.lane, fromMeetingId: decided.payload.meetingId });
    expect(w.description).toContain("NOAA only");
    expect(interruptsFor(world, noor.id)).toHaveLength(0);
    expect(decisionWakes(world, decided)).toEqual([]);
    await decide([{ text: "Noor: also the SOCAT check", assigneeId: noor.id }]);
    expect(queued(world, noor.id, "Amended in meeting")).toHaveLength(1);
  });
});

describe("rule mention", () => {
  /** Mei works on an assignment from the admin (origin hops 0); Noor is idle. */
  function setup(origin?: { hops?: number; at?: string } | null) {
    const s = seededWorld();
    const mei = s.by("Mei"), noor = s.by("Noor");
    const a = createAssignment(s.world, { agentId: mei.id, title: "From the admin", description: "x", createdBy: { kind: "user", id: s.seed.admin.id } });
    if (origin === null) s.world.assignments.upsert({ ...a, origin: null });
    else if (origin) s.world.assignments.upsert({ ...a, origin: { ...a.origin!, ...origin } });
    s.world.ops.startSession(mei.id, { purpose: "work", model: "m", assignmentId: a.id });
    s.world.setStatus(noor.id, "idle", "idle");
    return { ...s, mei, noor, wakes: () => queued(s.world, noor.id, "Mentioned by ") };
  }

  it("a relayed @mention with a human origin queues one directed assignment; a second merges; a replay is a no-op", async () => {
    const { world, mei, noor, seed, wakes } = setup();
    await world.verbs.write(mei, { type: "note", title: "Plan", body: "@Noor please check the SOCAT numbers", state: "building" });
    const [w] = wakes();
    expect(w).toMatchObject({ status: "pending", lane: "directed", createdBy: mei.id });
    expect(w.title).toMatch(/^Mentioned by Mei for .+: /);
    expect(w.origin).toMatchObject({ userId: seed.admin.id, hops: 1 });
    expect(w.sourceId).toBe(w.origin!.via);
    const ev = world.events.list({ types: ["agent.mentioned"], limit: 100 }).at(-1)!;
    expect(mentionWake(world, mei, ev, "x")).toBeNull();
    await world.verbs.say(mei, { text: "@Noor and the 2010 row too" });
    expect(wakes()).toHaveLength(1);
    expect(wakes()[0].description).toContain("mentioned you again");
  });

  it("a human's own @mention in a doc wakes an idle resident (hops 0)", async () => {
    const { world, noor, admin, seed, wakes } = setup();
    await world.verbs.write(admin, { type: "note", title: "Ask", body: "@Noor can you look at this?", state: "building" });
    const [w] = wakes();
    expect(w).toMatchObject({ lane: "directed", createdBy: seed.admin.id, createdByKind: "user" });
    expect(w.origin).toMatchObject({ userId: seed.admin.id, hops: 0 });
    expect(w.agentId).toBe(noor.id);
  });

  it("inbox only: no origin, past the hop cap, older than 24 h, or a busy target", async () => {
    for (const o of [null, { hops: 3 }, { at: new Date(Date.now() - RELAY_MAX_AGE_MS - 60_000).toISOString() }]) {
      const { world, mei, noor, wakes } = setup(o);
      await world.verbs.write(mei, { type: "note", title: "Plan", body: "@Noor look", state: "building" });
      expect(wakes()).toHaveLength(0);
      expect(world.messages.where("toId = ? AND kind = 'mention'", [noor.id])).toHaveLength(1);
    }
    const busy = setup();
    busy.world.ops.startSession(busy.noor.id, { purpose: "work", model: "m" });
    await busy.world.verbs.write(busy.mei, { type: "note", title: "Plan", body: "@Noor look", state: "building" });
    expect(busy.wakes()).toHaveLength(0);
  });
});
