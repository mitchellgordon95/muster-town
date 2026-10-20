/** POST /api/agents/:id/message and GET /api/agents/:id/thread. */
import { afterEach, describe, expect, it } from "vitest";
import { json, seededApp } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

describe("talk to an agent", () => {
  it("message an idle agent → started + assignment; thread shows both directions", async () => {
    const s = await seededApp();
    cleanups.push(s.close);
    const { app, auth, by, world, seed } = s;
    const mei = by("Mei");
    expect((await json(app, "POST", `/api/agents/${mei.id}/message`, { body: { text: "hi" } })).status).toBe(401);
    expect((await json(app, "POST", `/api/agents/${mei.id}/message`, { headers: auth, body: { text: "  " } })).status).toBe(400);

    const r = await json(app, "POST", `/api/agents/${mei.id}/message`, { headers: auth, body: { text: "What's the 2010 sink?" } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ mode: "started", assignmentId: expect.stringMatching(/^as_/) });
    expect(world.assignments.require(r.body.assignmentId).title).toMatch(/^Message from .+: What's the 2010 sink\?$/);

    const avatar = world.ops.ensureAvatar(seed.admin.id);
    await world.verbs.tell(mei, { to: avatar.id, text: "About 2.5 GtC/yr." });
    const t = await json(app, "GET", `/api/agents/${mei.id}/thread`, { headers: auth });
    expect(t.status).toBe(200);
    expect(t.body.messages.map((m: any) => [m.mine, m.body])).toEqual([[true, "What's the 2010 sink?"], [false, "About 2.5 GtC/yr."]]);
    expect((await json(app, "GET", `/api/agents/${mei.id}/thread?userId=${seed.admin.id}`, { headers: auth })).body.messages).toHaveLength(2);
  });

  it("a working agent is interrupted (desk queue) by default, or just told with now=false", async () => {
    const s = await seededApp();
    cleanups.push(s.close);
    const { app, auth, by, world } = s;
    const mei = by("Mei");
    const se = world.ops.startSession(mei.id, { purpose: "work", model: "m", backend: "docker" });
    const r = await json(app, "POST", `/api/agents/${mei.id}/message`, { headers: auth, body: { text: "switch to 13C" } });
    expect(r.body.mode).toBe("interrupted");
    expect(world.ops.pendingInterrupts(mei.id, se.id)).toHaveLength(1);
    const q = await json(app, "POST", `/api/agents/${mei.id}/message`, { headers: auth, body: { text: "fyi", now: false } });
    expect(q.body.mode).toBe("queued");
    expect(world.ops.pendingInterrupts(mei.id, se.id)).toHaveLength(1);
  });
});
