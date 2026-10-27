/** Wakes step 1 (docs/wakes.md): the human origin is stamped by the town, inherited by sessions, copied by relays. */
import { describe, expect, it } from "vitest";
import { createAssignment } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

function setup() {
  const s = seededWorld();
  const mei = s.by("Mei"), noor = s.by("Noor");
  s.world.ops.updateBuilding(s.admin, "carbon-cycle", { managerAgentId: mei.id });
  return { ...s, mei, noor, userId: s.seed.admin.id };
}

describe("origin", () => {
  it("a human's tell is stamped (hops 0, via its own message); its Message-from assignment and session inherit it", async () => {
    const { world, mei, userId, admin } = setup();
    world.ops.updateBuilding(admin, "carbon-cycle", { managerAgentId: null });
    const r = await world.ops.messageAgent(userId, mei.id, "Check 2010", { isWorking: () => false });
    const msg = world.messages.require(r.messageId);
    expect(msg.origin).toMatchObject({ userId, via: msg.id, hops: 0 });
    const a = world.assignments.require(r.assignmentId!);
    expect(a.origin).toEqual(msg.origin);
    const s = world.ops.startSession(mei.id, { purpose: "work", model: "m", assignmentId: a.id });
    expect(s.origin).toEqual(msg.origin);
    const told = world.events.recent({ limit: 20 }).find((e) => e.type === "agent.told")!;
    expect(told.payload.origin).toEqual(msg.origin);
    const started = world.events.recent({ limit: 20 }).find((e) => e.type === "session.started")!;
    expect(started.payload.origin).toEqual(msg.origin);
  });

  it("an agent relays its session's origin with hops + 1 through tell, assign and @mentions; without one it carries none", async () => {
    const { world, mei, noor, userId, by } = setup();
    const a = createAssignment(world, { agentId: mei.id, title: "From Mitchell", description: "x", createdBy: { kind: "user", id: userId } });
    expect(a.origin).toMatchObject({ userId, via: null, hops: 0 });
    // no running session: nothing to pass on
    const bare = await world.verbs.tell(mei, { to: noor.id, text: "hello" });
    expect(world.messages.require(bare.messageId).origin).toBeNull();
    world.ops.startSession(mei.id, { purpose: "work", model: "m", assignmentId: a.id });
    const t = await world.verbs.tell(mei, { to: noor.id, text: "Please pull SOCAT, cc @Tomas" });
    expect(world.messages.require(t.messageId).origin).toEqual({ ...a.origin, hops: 1 });
    const mention = world.messages.first("toId = ? AND kind = 'mention'", [by("Tomas").id], "ORDER BY createdAt DESC");
    expect(mention?.origin).toEqual({ ...a.origin, hops: 1 });
    const as = await world.verbs.assign(mei, { agentId: noor.id, title: "Pull SOCAT", description: "for Mitchell", lane: "exploration", gap: "SOCAT 2025 is missing" });
    expect(world.assignments.require(as.assignmentId).origin).toEqual({ ...a.origin, hops: 1 });
    // the inbox shows who it is for
    const inbox = (await world.verbs.inbox(noor, {})).messages.find((m) => m.id === t.messageId)!;
    expect(inbox).toMatchObject({ for: world.users.require(userId).name, origin: { hops: 1 } });
  });

  it("a flag, a 1:1 decision and a continuation carry the human; agent-made work without one carries none", async () => {
    const { world, mei, noor, userId, admin } = setup();
    const flag = world.ops.plantFlag(admin, "carbon-cycle", "Look at the ocean sink");
    const d = await world.verbs.review(mei, { docId: flag.id, decision: "continue", assigneeId: noor.id });
    expect(world.assignments.require(d.assignmentId!).origin).toMatchObject({ userId, via: flag.id, hops: 0 });

    const m = world.ops.openOneOnOne(admin, "carbon-cycle");
    world.ops.meetingSay(admin, m.id, "Noor should redo 2010");
    const manage = world.ops.startSession(mei.id, { purpose: "manage", model: "m", meetingId: m.id });
    expect(manage.origin).toMatchObject({ userId, via: m.id, hops: 0 });
    const dec = await world.verbs.meeting(mei, { meetingId: m.id, action: "decide", decisions: [{ text: "Noor: redo 2010", assigneeId: noor.id, assignmentId: null }] });
    const decided = world.assignments.require((dec as { decisions: { assignmentId: string }[] }).decisions[0].assignmentId);
    expect(decided.origin).toMatchObject({ userId, via: m.id, hops: 0 });

    const next = createAssignment(world, { agentId: noor.id, title: "Continue", description: "x", createdBy: world.holderOf(mei), fromAssignmentId: decided.id, lane: { lane: "directed", sourceId: m.id } });
    expect(next.origin).toEqual(decided.origin);
    const plain = createAssignment(world, { agentId: noor.id, title: "Chores", description: "x", createdBy: { kind: "system", id: "system" } });
    expect(plain.origin).toBeNull();
  });

  it("origin is not a verb input: an agent can't put it on its tell", async () => {
    const { world, mei, noor, userId } = setup();
    const t = await world.verbs.tell(mei, { to: noor.id, text: "hi", origin: { userId, via: null, hops: 0, at: new Date().toISOString() } } as never);
    expect(world.messages.require(t.messageId).origin).toBeNull();
  });
});
