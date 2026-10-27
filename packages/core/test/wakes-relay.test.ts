/** Wakes step 2 (docs/wakes.md §4): a tell that traces to a human wakes an idle resident with a directed assignment. */
import { describe, expect, it } from "vitest";
import { createAssignment, RELAY_MAX_AGE_MS } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

/** Mei has a running work session on an assignment from the admin (origin hops 0); Noor is an idle resident. */
function setup(origin?: { hops?: number; at?: string }) {
  const s = seededWorld();
  const mei = s.by("Mei"), noor = s.by("Noor");
  const userId = s.seed.admin.id;
  const a = createAssignment(s.world, { agentId: mei.id, title: "From the admin", description: "x", createdBy: { kind: "user", id: userId } });
  if (origin) s.world.assignments.upsert({ ...a, origin: { ...a.origin!, ...origin } });
  s.world.ops.startSession(mei.id, { purpose: "work", model: "m", assignmentId: a.id });
  s.world.setStatus(noor.id, "idle", "idle");
  const wakes = () => s.world.assignments.where("agentId = ? AND title LIKE 'Message from %'", [noor.id]);
  return { ...s, mei, noor, userId, wakes };
}

describe("relayed tells wake idle residents", () => {
  it("an idle recipient gets one pending directed assignment with the text and the human origin", async () => {
    const { world, mei, noor, userId, wakes } = setup();
    const r = await world.verbs.tell(mei, { to: noor.id, text: "Please pull SOCAT 2025\nand check 2010" });
    const [w] = wakes();
    expect(r).toMatchObject({ assignmentId: w.id });
    expect(w).toMatchObject({ status: "pending", lane: "directed", createdBy: mei.id, createdByKind: "agent" });
    expect(w.title).toBe(`Message from ${world.users.require(userId).name} (via Mei): Please pull SOCAT 2025`);
    expect(w.description).toContain("and check 2010");
    expect(w.origin).toMatchObject({ userId, hops: 1 });
    expect(w.sourceId).toBe(w.origin!.via);
    // the message is still in the inbox
    expect(world.messages.require(r.messageId).toId).toBe(noor.id);
  });

  it("a later tell for the same human merges into the pending one; replaying the event is a no-op", async () => {
    const { world, mei, noor, wakes } = setup();
    await world.verbs.tell(mei, { to: noor.id, text: "first" });
    const r2 = await world.verbs.tell(mei, { to: noor.id, text: "second" });
    expect(wakes()).toHaveLength(1);
    expect(wakes()[0].id).toBe(r2.assignmentId);
    expect(wakes()[0].description).toContain("Then Mei added:\n\nsecond");
    const told = world.events.list({ types: ["agent.told"], limit: 100 }).at(-1)!;
    const { relayWake } = await import("../src/index.ts");
    expect(relayWake(world, mei, told)).toBeNull();
    expect(wakes()[0].description.match(/Then Mei added/g)).toHaveLength(1);
  });

  it("inbox only: a busy recipient, a tell with no origin, past the hop cap, or older than 24 h", async () => {
    const busy = setup();
    busy.world.ops.startSession(busy.noor.id, { purpose: "work", model: "m" });
    const b = await busy.world.verbs.tell(busy.mei, { to: busy.noor.id, text: "busy" });
    expect(b.assignmentId).toBeUndefined();
    expect(busy.wakes()).toHaveLength(0);

    const none = setup();
    const r = await none.world.verbs.tell(none.noor, { to: none.mei.id, text: "no origin" });
    expect(none.world.messages.require(r.messageId).origin).toBeNull();
    // Noor (no session) tells an idle colleague: inbox only
    const tomas = none.by("Tomas");
    none.world.setStatus(tomas.id, "idle", "idle");
    const t = await none.world.verbs.tell(none.noor, { to: tomas.id, text: "no origin" });
    expect(t.assignmentId).toBeUndefined();
    expect(t.note).toContain("does not start work");

    const far = setup({ hops: 3 }); // the relay is hop 4
    expect((await far.world.verbs.tell(far.mei, { to: far.noor.id, text: "far" })).assignmentId).toBeUndefined();
    const edge = setup({ hops: 2 }); // the relay is hop 3: still wakes
    expect((await edge.world.verbs.tell(edge.mei, { to: edge.noor.id, text: "edge" })).assignmentId).toBeDefined();

    const old = setup({ at: new Date(Date.now() - RELAY_MAX_AGE_MS - 60_000).toISOString() });
    expect((await old.world.verbs.tell(old.mei, { to: old.noor.id, text: "old" })).assignmentId).toBeUndefined();
    expect(old.wakes()).toHaveLength(0);
  });
});
