/** Talk to an agent: a human's message is a `tell` that wakes an idle agent or interrupts a working one. */
import { describe, expect, it } from "vitest";
import { seededWorld } from "./helpers.ts";

function setup() {
  const s = seededWorld();
  return { ...s, mei: s.by("Mei"), userId: s.seed.admin.id, userName: s.world.users.require(s.seed.admin.id).name };
}

describe("ops.messageAgent", () => {
  it("idle agent: inbox tell from the avatar + a Message-from assignment; a second message merges into it", async () => {
    const { world, admin, mei, userId, userName } = setup();
    const r = await world.ops.messageAgent(userId, mei.id, "Can you check the 2010 numbers?\nThanks.", { isWorking: () => false });
    expect(r.mode).toBe("started");
    const a = world.assignments.require(r.assignmentId!);
    expect(a).toMatchObject({ agentId: mei.id, status: "pending", title: `Message from ${userName}: Can you check the 2010 numbers?`, createdBy: userId });
    expect(a.description).toContain(`${userName} messaged you:\n\nCan you check the 2010 numbers?\nThanks.`);
    expect(a.description).toContain(`their avatar id is ${admin.id}`);
    expect(a.description).toContain('"Nothing needed"');
    const inbox = (await world.verbs.inbox(mei, {})).messages;
    expect(inbox).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "tell", fromId: admin.id, from: userName, body: "Can you check the 2010 numbers?\nThanks." })]));
    const ev = world.events.recent({ agentId: admin.id, limit: 5 }).find((e) => e.type === "agent.told")!;
    expect(ev.payload).toMatchObject({ toId: mei.id, fromUser: userId });

    const r2 = await world.ops.messageAgent(userId, mei.id, "Also 2011.", { isWorking: () => false });
    expect(r2.assignmentId).toBe(r.assignmentId);
    const merged = world.assignments.require(r.assignmentId!).description;
    expect(merged).toContain("Then they added:\n\nAlso 2011.");
    expect(merged.match(/Reply to them first/g)).toHaveLength(1);
    expect(world.assignments.count("agentId = ? AND status = 'pending'", [mei.id])).toBe(1);
  });

  it("working agent: now → interrupt; now=false → inbox only", async () => {
    const { world, mei, userId } = setup();
    const calls: [string, string, string, boolean][] = [];
    const r = await world.ops.messageAgent(userId, mei.id, "Stop and look at 13C", { isWorking: () => true, interrupt: (...a) => { calls.push(a); return true; } });
    expect(r).toEqual({ mode: "interrupted", messageId: expect.any(String) });
    expect(calls[0][0]).toBe(mei.id);
    expect(calls[0][1]).toContain("Stop and look at 13C");
    expect(calls[0][3]).toBe(true);
    expect(world.interrupts.count("agentId = ?", [mei.id])).toBe(0);

    const q = await world.ops.messageAgent(userId, mei.id, "later is fine", { now: false, isWorking: () => true, interrupt: () => { throw new Error("no"); } });
    expect(q.mode).toBe("queued");
    expect(q.assignmentId).toBeUndefined();
    expect(world.assignments.count("agentId = ? AND title LIKE 'Message from%'", [mei.id])).toBe(0);
  });

  it("working on a desk (not in-process): the interrupt is queued for the desk to poll", async () => {
    const { world, mei, userId } = setup();
    const s = world.ops.startSession(mei.id, { purpose: "work", model: "m", backend: "docker" });
    const r = await world.ops.messageAgent(userId, mei.id, "hi there");
    expect(r.mode).toBe("interrupted");
    const [it] = world.ops.pendingInterrupts(mei.id, s.id);
    expect(it).toMatchObject({ sessionId: s.id, now: true });
    expect(it.text).toContain("hi there");
  });

  it("stopped agent is revived", async () => {
    const { world, admin, mei, userId } = setup();
    world.ops.stopAgent(admin, mei.id);
    const r = await world.ops.messageAgent(userId, mei.id, "wake up", { isWorking: () => false });
    expect(r.mode).toBe("started");
    expect(world.agents.require(mei.id).status).toBe("idle");
  });

  it("out of budget: queued, but the assignment exists", async () => {
    const { world, mei, userId } = setup();
    const b = world.buildings.require(mei.homeBuildingId!);
    world.agents.patch(mei.id, { spentTokensToday: b.dailyTokensPerAgent });
    const r = await world.ops.messageAgent(userId, mei.id, "when you can", { isWorking: () => false });
    expect(r.mode).toBe("queued");
    expect(world.assignments.require(r.assignmentId!).status).toBe("pending");
  });

  it("thread: tells both ways, oldest first; retired agents refuse", async () => {
    const { world, admin, mei, userId } = setup();
    await world.ops.messageAgent(userId, mei.id, "hello", { isWorking: () => false });
    await world.verbs.tell(mei, { to: admin.id, text: "hi! on it" });
    const t = world.ops.thread(mei.id, userId);
    expect(t.map((m) => [m.mine, m.body])).toEqual([[true, "hello"], [false, "hi! on it"]]);
    world.ops.dismissAgent(null, mei.id);
    await expect(world.ops.messageAgent(userId, mei.id, "x")).rejects.toThrow(/dismissed/);
  });
});
