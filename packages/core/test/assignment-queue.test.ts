/** The assignment queue: position order, move to front, reorder, resume, start next, cancel, retry; messages go first. */
import Database from "better-sqlite3";
import { copyFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/db.ts";
import { buildingRoleId, nextPending, pendingQueue, setAssignmentStatus } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

function setup() {
  const s = seededWorld();
  const mei = s.by("Mei");
  const add = (title: string) => s.world.ops.createWork(null, mei.id, { title });
  return { ...s, mei, add, userId: s.seed.admin.id, titles: () => pendingQueue(s.world, mei.id).map((a) => a.title) };
}

describe("assignment queue", () => {
  it("new assignments get epoch-ms positions; the next pending orders by position, then createdAt, rowid", () => {
    const { world, mei, add, titles } = setup();
    const before = Date.now();
    const a = add("A"), b = add("B"), c = add("C");
    expect(a.position).toBeGreaterThanOrEqual(before);
    expect(a.fromAssignmentId).toBeNull();
    expect(titles()).toEqual(["A", "B", "C"]);
    // position wins over createdAt
    world.assignments.patch(c.id, { position: a.position - 10 });
    expect(nextPending(world, mei.id)!.id).toBe(c.id);
    // equal positions fall back to createdAt, rowid
    world.assignments.patch(c.id, { position: b.position });
    world.assignments.patch(a.id, { position: b.position });
    expect(titles()).toEqual(["A", "B", "C"]);
  });

  it("moveToFront puts a pending assignment first; non-pending refuse", () => {
    const { world, add, titles } = setup();
    add("A"); add("B"); const c = add("C");
    world.ops.moveToFront(c.id);
    expect(titles()).toEqual(["C", "A", "B"]);
    const again = world.ops.moveToFront(c.id); // already first: unchanged
    expect(again.position).toBe(world.assignments.require(c.id).position);
    setAssignmentStatus(world, c.id, "cancelled");
    expect(() => world.ops.moveToFront(c.id)).toThrow(expect.objectContaining({ code: "conflict" }));
  });

  it("reorderQueue: listed ids first in order, unlisted keep their order after; validates ids", () => {
    const { world, admin, by, mei, add, titles } = setup();
    const a = add("A"), b = add("B"), c = add("C"), d = add("D");
    const out = world.ops.reorderQueue(admin, mei.id, [d.id, b.id]);
    expect(out.map((x) => x.title)).toEqual(["D", "B", "A", "C"]);
    expect(titles()).toEqual(["D", "B", "A", "C"]);
    expect(() => world.ops.reorderQueue(admin, mei.id, [a.id, a.id])).toThrow(/twice/);
    const other = world.ops.createWork(null, by("Noor").id, { title: "Noor's" });
    expect(() => world.ops.reorderQueue(admin, mei.id, [other.id])).toThrow(expect.objectContaining({ code: "bad_request" }));
    setAssignmentStatus(world, c.id, "cancelled");
    expect(() => world.ops.reorderQueue(admin, mei.id, [c.id])).toThrow(/queued/);
    expect(titles()).toEqual(["D", "B", "A"]);
  });

  it("resumeAgent: stopped → idle with no new assignment", () => {
    const { world, admin, mei, add } = setup();
    add("A");
    world.ops.stopAgent(admin, mei.id);
    const n = world.assignments.count("agentId = ?", [mei.id]);
    expect(world.ops.resumeAgent(admin, mei.id).status).toBe("idle");
    expect(world.assignments.count("agentId = ?", [mei.id])).toBe(n);
  });

  it("startNext: stopped → resumed and first ('now'); working → first, runs after the current session", () => {
    const { world, admin, mei, add, titles } = setup();
    add("A"); const b = add("B");
    world.ops.stopAgent(admin, mei.id);
    const r = world.ops.startNext(admin, b.id);
    expect(r.when).toBe("now");
    expect(r.agent.status).toBe("idle");
    expect(titles()).toEqual(["B", "A"]);

    const run = add("Running");
    world.ops.moveToFront(run.id);
    world.ops.startSession(mei.id, { purpose: "work", model: "m", assignmentId: run.id });
    expect(world.agents.require(mei.id).status).toBe("working");
    const later = add("Later");
    const r2 = world.ops.startNext(admin, later.id);
    expect(r2).toMatchObject({ when: "after-current", agent: { status: "working" } });
    expect(titles()).toEqual(["Later", "B", "A"]);
    expect(() => world.ops.startNext(admin, run.id)).toThrow(expect.objectContaining({ code: "conflict" }));
  });

  it("cancelAssignment: pending only; active, done and cancelled refuse", () => {
    const { world, admin, mei, add, titles } = setup();
    const a = add("A"); add("B");
    expect(world.ops.cancelAssignment(admin, a.id).status).toBe("cancelled");
    expect(titles()).toEqual(["B"]);
    expect(() => world.ops.cancelAssignment(admin, a.id)).toThrow(/already cancelled/);
    const act = add("Act");
    world.ops.startSession(mei.id, { purpose: "work", model: "m", assignmentId: act.id });
    expect(() => world.ops.cancelAssignment(admin, act.id)).toThrow(/running/);
    const done = add("Done");
    setAssignmentStatus(world, done.id, "done");
    expect(() => world.ops.cancelAssignment(admin, done.id)).toThrow(expect.objectContaining({ code: "conflict" }));
  });

  it("retryAssignment: cancelled/done → a new pending clone with fromAssignmentId, at the front when asked; originals stay terminal", () => {
    const { world, admin, add, titles } = setup();
    const a = add("A"); add("B"); add("C");
    world.ops.cancelAssignment(admin, a.id);
    const r = world.ops.retryAssignment(admin, a.id, { front: true });
    expect(r).toMatchObject({ status: "pending", title: "A", description: a.description, fromAssignmentId: a.id, createdBy: admin.ownerUserId });
    expect(r.id).not.toBe(a.id);
    expect(titles()).toEqual(["A", "B", "C"]);
    expect(world.assignments.require(a.id).status).toBe("cancelled");

    const c = world.assignments.first("title = 'C'")!;
    setAssignmentStatus(world, c.id, "done");
    const back = world.ops.retryAssignment(admin, c.id, {});
    expect(back.fromAssignmentId).toBe(c.id);
    expect(titles()).toEqual(["A", "B", "C"]); // not front: the back of the queue
    expect(world.assignments.require(c.id).status).toBe("done");
    const b = world.assignments.first("title = 'B'")!;
    expect(() => world.ops.retryAssignment(admin, b.id)).toThrow(/Only cancelled or done/);
  });

  it("delegateAssignment: a queued one moves to another resident's queue (front) and the original is cancelled; not for active, self, or visitors", () => {
    const { world, admin, mei, add, titles } = setup();
    const a = add("A"), b = add("B");
    const noor = world.agents.first("name = 'Noor'")!;
    const theirs = world.ops.createWork(null, noor.id, { title: "N1" });
    const r = world.ops.delegateAssignment(admin, b.id, noor.id, { front: true });
    expect(r.from).toMatchObject({ id: b.id, status: "cancelled" });
    expect(r.assignment).toMatchObject({ status: "pending", agentId: noor.id, title: "B", description: b.description, fromAssignmentId: b.id, buildingId: b.buildingId });
    expect(titles()).toEqual(["A"]);
    expect(pendingQueue(world, noor.id).map((x) => x.title)).toEqual(["B", "N1"]);
    expect(theirs.status).toBe("pending");
    const ev = world.events.recent({ limit: 5 }).find((e) => e.type === "assignment.delegated")!;
    expect(ev.text).toBe(`${admin.name} delegated "B" from Mei to Noor`);
    expect(ev.payload).toMatchObject({ assignmentId: r.assignment.id, fromAssignmentId: b.id, fromAgentId: mei.id, toAgentId: noor.id });

    expect(() => world.ops.delegateAssignment(admin, b.id, noor.id)).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(() => world.ops.delegateAssignment(admin, a.id, mei.id)).toThrow(/already Mei's/);
    expect(() => world.ops.delegateAssignment(admin, a.id, admin.id)).toThrow(/only residents/);
    const nobody = world.ops.ensureAvatar(world.ops.createUser("Nobody").user.id);
    expect(() => world.ops.delegateAssignment(nobody, a.id, noor.id)).toThrow(expect.objectContaining({ code: "forbidden" }));
    expect(titles()).toEqual(["A"]);
  });

  it("permissions: owner, building.assign on the building, or admin; anyone else is refused", () => {
    const { world, admin, mei, add } = setup();
    const a = add("A"), b = add("B");
    const nobody = world.ops.ensureAvatar(world.ops.createUser("Nobody").user.id);
    for (const f of [
      () => world.ops.startNext(nobody, a.id), () => world.ops.cancelAssignment(nobody, a.id),
      () => world.ops.reorderQueue(nobody, mei.id, [b.id]), () => world.ops.resumeAgent(nobody, mei.id),
    ]) expect(f).toThrow(expect.objectContaining({ code: "forbidden" }));
    const done = add("D"); setAssignmentStatus(world, done.id, "done");
    expect(() => world.ops.retryAssignment(nobody, done.id)).toThrow(expect.objectContaining({ code: "forbidden" }));

    const owner = world.ops.ensureAvatar(world.ops.createUser("Owner").user.id);
    world.agents.patch(mei.id, { ownerUserId: owner.ownerUserId });
    expect(world.ops.reorderQueue(owner, mei.id, [b.id])[0].id).toBe(b.id);

    const rev = world.ops.ensureAvatar(world.ops.createUser("Rev").user.id);
    world.ops.assignRole(admin, { roleId: buildingRoleId(mei.homeBuildingId!, "reviewer"), holderKind: "user", holderId: rev.ownerUserId! });
    expect(world.ops.startNext(rev, a.id).assignment.id).toBe(a.id);
    expect(world.ops.cancelAssignment(admin, b.id).status).toBe("cancelled");
  });

  it("a message to a stopped agent with a backlog goes to the front and runs next", async () => {
    const { world, admin, mei, add, userId, titles } = setup();
    add("Old 1"); add("Old 2");
    world.ops.stopAgent(admin, mei.id);
    const r = await world.ops.messageAgent(userId, mei.id, "Do this first", { isWorking: () => false });
    expect(nextPending(world, mei.id)!.id).toBe(r.assignmentId);
    expect(titles().slice(1)).toEqual(["Old 1", "Old 2"]);
    expect(world.agents.require(mei.id).status).toBe("idle");
    // a follow-up merges into it and it stays first, even after something else jumped ahead
    const jump = add("Jumper"); world.ops.moveToFront(jump.id);
    const r2 = await world.ops.messageAgent(userId, mei.id, "and this", { isWorking: () => false });
    expect(r2.assignmentId).toBe(r.assignmentId);
    expect(nextPending(world, mei.id)!.id).toBe(r.assignmentId);
  });

  it("migration 011 backfills position from createdAt (epoch ms)", () => {
    const all = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
    const dir = mkdtempSync(join(tmpdir(), "mig-q-"));
    for (const f of readdirSync(all)) if (Number(/^(\d+)/.exec(f)?.[1]) < 11) copyFileSync(join(all, f), join(dir, f));
    const db = new Database(":memory:");
    migrate(db, dir);
    const ins = db.prepare("INSERT INTO assignments (id, agentId, buildingId, title, description, status, createdBy, createdByKind, createdAt, updatedAt) VALUES (?, 'ag', 'b', 't', 'd', 'pending', 'u', 'user', ?, ?)");
    ins.run("as_1", "2026-10-19T10:00:00.123Z", "2026-10-19T10:00:00.123Z");
    ins.run("as_2", "2025-01-02T03:04:05.000Z", "2025-01-02T03:04:05.000Z");
    copyFileSync(join(all, "011_assignment_queue.sql"), join(dir, "011_assignment_queue.sql"));
    migrate(db, dir);
    const rows = db.prepare("SELECT id, position, fromAssignmentId FROM assignments ORDER BY id").all();
    expect(rows).toEqual([
      { id: "as_1", position: Date.parse("2026-10-19T10:00:00.123Z"), fromAssignmentId: null },
      { id: "as_2", position: Date.parse("2025-01-02T03:04:05.000Z"), fromAssignmentId: null },
    ]);
  });
});
