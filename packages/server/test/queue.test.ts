/** The assignment queue routes: resume, reorder, start next, cancel, retry; GET /api/agents/:id orders them. */
import { afterEach, describe, expect, it } from "vitest";
import { json, seededApp } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function setup() {
  const s = await seededApp();
  cleanups.push(s.close);
  const mei = s.by("Mei");
  const add = (title: string) => s.world.ops.createWork(null, mei.id, { title });
  const queue = () => s.world.assignments.where("agentId = ? AND status = 'pending'", [mei.id], "ORDER BY position, createdAt, rowid").map((a) => a.title);
  return { ...s, mei, add, queue };
}

describe("assignment queue routes", () => {
  it("stopped agent with a queue: start-next resumes it with that one first; resume takes the queue as is", async () => {
    const { app, auth, world, mei, add, queue } = await setup();
    add("A"); const b = add("B");
    world.ops.stopAgent(null, mei.id);
    const r = await json(app, "POST", `/api/assignments/${b.id}/start-next`, { headers: auth });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ when: "now", assignment: { id: b.id, status: "pending" }, agent: { id: mei.id, status: "idle" } });
    expect(queue()).toEqual(["B", "A"]);

    world.ops.stopAgent(null, mei.id);
    const res = await json(app, "POST", `/api/agents/${mei.id}/resume`, { headers: auth });
    expect(res.body.agent.status).toBe("idle");
    expect(queue()).toEqual(["B", "A"]);
  });

  it("start-next on a working agent runs after the current session", async () => {
    const { app, auth, world, mei, add } = await setup();
    const run = add("Run");
    world.ops.startSession(mei.id, { purpose: "work", model: "m", assignmentId: run.id });
    const next = add("Next");
    const r = await json(app, "POST", `/api/assignments/${next.id}/start-next`, { headers: auth });
    expect(r.body).toMatchObject({ when: "after-current", agent: { status: "working" } });
    expect((await json(app, "POST", `/api/assignments/${run.id}/start-next`, { headers: auth })).status).toBe(409);
  });

  it("queue reorders; bad ids are 400", async () => {
    const { app, auth, mei, add, queue } = await setup();
    const a = add("A"), b = add("B"), c = add("C");
    const r = await json(app, "POST", `/api/agents/${mei.id}/queue`, { headers: auth, body: { order: [c.id, a.id] } });
    expect(r.status).toBe(200);
    expect(r.body.assignments.map((x: any) => x.title)).toEqual(["C", "A", "B"]);
    expect(r.body.agent.id).toBe(mei.id);
    expect(queue()).toEqual(["C", "A", "B"]);
    expect((await json(app, "POST", `/api/agents/${mei.id}/queue`, { headers: auth, body: { order: ["as_nope"] } })).status).toBe(400);
    expect((await json(app, "POST", `/api/agents/${mei.id}/queue`, { headers: auth, body: {} })).status).toBe(400);
    expect(b.id).toBeTruthy();
  });

  it("cancel (pending only) and retry (front by default, or the back); GET orders active, queue, history", async () => {
    const { app, auth, world, mei, add, queue } = await setup();
    const a = add("A"); add("B");
    const c = await json(app, "POST", `/api/assignments/${a.id}/cancel`, { headers: auth });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ assignment: { id: a.id, status: "cancelled" }, agent: { id: mei.id } });
    expect((await json(app, "POST", `/api/assignments/${a.id}/cancel`, { headers: auth })).status).toBe(409);

    const r = await json(app, "POST", `/api/assignments/${a.id}/retry`, { headers: auth });
    expect(r.status).toBe(201);
    expect(r.body.assignment).toMatchObject({ title: "A", status: "pending", fromAssignmentId: a.id });
    expect(queue()).toEqual(["A", "B"]);
    const back = await json(app, "POST", `/api/assignments/${a.id}/retry`, { headers: auth, body: { front: false } });
    expect(back.status).toBe(201);
    expect(queue()).toEqual(["A", "B", "A"]);
    const pending = world.assignments.first("title = 'B'")!;
    expect((await json(app, "POST", `/api/assignments/${pending.id}/retry`, { headers: auth })).status).toBe(409);

    const run = add("Run");
    world.ops.startSession(mei.id, { purpose: "work", model: "m", assignmentId: run.id });
    const d = await json(app, "GET", `/api/agents/${mei.id}`, { headers: auth });
    expect(d.body.assignments.map((x: any) => [x.title, x.status])).toEqual([
      ["Run", "active"], ["A", "pending"], ["B", "pending"], ["A", "pending"], ["A", "cancelled"],
    ]);
  });

  it("permissions: a user who neither owns the agent nor holds building.assign gets 403; admin works", async () => {
    const { app, auth, world, mei, add } = await setup();
    const a = add("A"), b = add("B");
    const done = add("D"); world.ops.cancelAssignment(null, done.id);
    const { token } = world.ops.createUser("Guest");
    const guest = { authorization: `Bearer ${token}` };
    for (const [url, body] of [
      [`/api/assignments/${a.id}/start-next`, undefined], [`/api/assignments/${a.id}/cancel`, undefined],
      [`/api/assignments/${done.id}/retry`, undefined], [`/api/agents/${mei.id}/queue`, { order: [b.id] }],
      [`/api/agents/${mei.id}/resume`, undefined],
    ] as const) {
      expect((await json(app, "POST", url, { headers: guest, body })).status, url).toBe(403);
      expect((await json(app, "POST", url, { body })).status, url).toBe(401);
    }
    expect((await json(app, "POST", `/api/agents/${mei.id}/queue`, { headers: auth, body: { order: [b.id] } })).status).toBe(200);
    expect((await json(app, "POST", "/api/assignments/as_missing/cancel", { headers: auth })).status).toBe(404);
  });

  it("GET /api/assignments/:id: a guest reads the card (title, lane, agent, sessions) without its creator or origin; unknown is 404", async () => {
    const { app, world, mei, add } = await setup();
    const run = add("Run it");
    world.ops.startSession(mei.id, { purpose: "work", model: "m", assignmentId: run.id });
    const r = await json(app, "GET", `/api/assignments/${run.id}`);
    expect(r.status).toBe(200);
    expect(r.body.assignment).toMatchObject({ id: run.id, title: "Run it", agentId: mei.id, agentName: "Mei", status: "active" });
    expect(r.body.assignment.sessions).toHaveLength(1);
    expect(r.body.assignment.sessions[0]).toMatchObject({ status: "running", endedAt: null });
    expect(r.body.assignment).not.toHaveProperty("createdBy");
    expect(r.body.assignment).not.toHaveProperty("origin");
    expect((await json(app, "GET", "/api/assignments/as_zzzzzzzzzz")).status).toBe(404);
  });
});
