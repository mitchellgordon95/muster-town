import { buildingRoleId, createDoc, townRoleId } from "@muster-town/core";
import { afterEach, describe, expect, it } from "vitest";
import { json, seededApp } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const LAB = "carbon-cycle";

/** Captain steering rights over HTTP (gr_zsm1piyqyx, kr_xx9wtfnwh8): captain of the lab's goal (yes), captain elsewhere and a plain member (no). */
describe("captain steering rights routes", () => {
  it("rollup decide + in-tray canDecide, 1:1, plant a flag: inside the subtree yes; outside and plain member no", async () => {
    const s = await seededApp();
    cleanups.push(s.close);
    const { world, app, seed, by } = s;
    const admin = world.ops.ensureAvatar(seed.admin.id);
    const mei = by("Mei");
    world.permissions.grant(mei, buildingRoleId(LAB, "manager"));
    world.buildings.upsert({ ...world.buildings.require(LAB), managerAgentId: mei.id });
    const member = (name: string) => {
      const { user, token } = world.ops.createUser(name);
      world.permissions.grant({ kind: "user", id: user.id }, townRoleId("member"));
      return { id: user.id, h: { authorization: `Bearer ${token}` } };
    };
    const cap = member("Cap");
    const out = member("Out");
    const plain = member("Plain");
    const top = world.goalTree.create(admin, { parentId: "gl_trust", text: "Funders see what every token bought" });
    const labGoal = world.goalTree.create(admin, { parentId: top.id, text: "The carbon lab's goal" });
    world.goalTree.attach(admin, LAB, labGoal.id);
    world.goalTree.update(admin, top.id, { ownerId: cap.id });
    const other = world.goalTree.create(admin, { parentId: "gl_trust", text: "Somewhere else" });
    world.goalTree.update(admin, other.id, { ownerId: out.id });
    const rollup = createDoc(world, { type: "report", state: "building", title: "Rollup 1", body: "## Shipped\nx", decision: "pending", authorId: mei.id, authorKind: "agent", buildingId: LAB, tags: ["rollup"] });

    // GET /api/me: captainOf names the lab for its captain only (the web's store.can reads it)
    const meOf = async (h: Record<string, string>) => (await json(app, "GET", "/api/me", { headers: h })).body;
    expect((await meOf(cap.h)).captainOf).toContain(LAB);
    expect((await meOf(cap.h)).captainOf).not.toContain("town-hall");
    expect((await meOf(out.h)).captainOf).not.toContain(LAB);
    expect((await meOf(plain.h)).captainOf).toEqual([]);

    // in-tray: Mine + canDecide for the captain only
    const tray = async (h: Record<string, string>) => (await json(app, "GET", "/api/buildings/town-hall/intray", { headers: h })).body;
    expect((await tray(cap.h)).routes[rollup.id]).toMatchObject({ mine: true, canDecide: true });
    expect((await tray(cap.h)).defaultView).toBe("mine");
    expect((await tray(out.h)).routes[rollup.id]).toMatchObject({ mine: false, canDecide: false });
    expect((await tray(plain.h)).routes[rollup.id]).toMatchObject({ mine: false, canDecide: false });

    // 1:1: a captain directs work inside (canDirect); outside the subtree, or a plain member, no 1:1 (403)
    const one = (h: Record<string, string>, body: object = {}) => json(app, "POST", `/api/buildings/${LAB}/one-on-one`, { headers: h, body });
    expect((await one(cap.h, { agentId: mei.id })).status).toBe(200);
    expect((await one(out.h, { agentId: mei.id })).status).toBe(403);
    expect((await one(plain.h, { agentId: mei.id })).status).toBe(403);
    expect((await one(cap.h)).status).toBe(200);
    expect((await one(out.h)).status).toBe(403);
    expect((await one(plain.h)).status).toBe(403);

    // flags: 201 inside, 403 outside
    const flag = (h: Record<string, string>) => json(app, "POST", `/api/buildings/${LAB}/flags`, { headers: h, body: { text: "Look at the banner" } });
    expect((await flag(out.h)).status).toBe(403);
    expect((await flag(plain.h)).status).toBe(403);
    expect((await flag(cap.h)).status).toBe(201);

    // decide the rollup: 403 outside, 200 for the captain
    const review = (h: Record<string, string>) => json(app, "POST", `/api/docs/${rollup.id}/review`, { headers: h, body: { decision: "approve", note: "" } });
    expect((await review(out.h)).status).toBe(403);
    expect((await review(plain.h)).status).toBe(403);
    expect((await json(app, "POST", `/api/docs/${rollup.id}/archive`, { headers: plain.h, body: {} })).status).toBe(403);
    const ok = await review(cap.h);
    expect(ok.status).toBe(200);
    expect(world.docs.require(rollup.id, "doc").decision).toBe("approve");
  });
});
