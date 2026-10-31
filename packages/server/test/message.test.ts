/** GET /api/agents/:id/thread: the `tell`s between an agent and the caller's avatar (the Talk tab's thread). */
import { afterEach, describe, expect, it } from "vitest";
import { json, seededApp } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

describe("talk to an agent", () => {
  it("thread shows the tells both ways; guests get 401", async () => {
    const s = await seededApp();
    cleanups.push(s.close);
    const { app, auth, by, world, seed } = s;
    const mei = by("Mei");
    const avatar = world.ops.ensureAvatar(seed.admin.id);
    await world.verbs.tell(avatar, { to: mei.id, text: "What's the 2010 sink?" });
    await world.verbs.tell(mei, { to: avatar.id, text: "About 2.5 GtC/yr." });
    expect((await json(app, "GET", `/api/agents/${mei.id}/thread`)).status).toBe(401);
    const t = await json(app, "GET", `/api/agents/${mei.id}/thread`, { headers: auth });
    expect(t.status).toBe(200);
    expect(t.body.messages.map((m: any) => [m.mine, m.body])).toEqual([[true, "What's the 2010 sink?"], [false, "About 2.5 GtC/yr."]]);
    expect((await json(app, "GET", `/api/agents/${mei.id}/thread?userId=${seed.admin.id}`, { headers: auth })).body.messages).toHaveLength(2);
  });
});
