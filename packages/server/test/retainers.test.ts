import { townRoleId } from "@muster-town/core";
import { afterEach, describe, expect, it } from "vitest";
import { json, seededApp } from "./helpers.ts";

// Retainers (1:1 mt_cyd2t5ioob decision 2): a schedule with tokensPerRun asks in the Town Hall in-tray; a human approves,
// counters or rejects it over POST /api/schedules/:id/retainer; a funded one is the Bank's "Retainers" claim.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

describe("retainers over HTTP", () => {
  it("create with tokensPerRun → in-tray row → member 403 → admin approves → schedule card and GET /api/bank show the claim", async () => {
    const s = await seededApp();
    cleanups.push(s.close);
    const { app, auth, world } = s;
    const lab = world.buildings.first("kind = 'lab'")!;
    const th = world.buildings.first("kind = 'town-hall'")!;
    const t0 = Date.now();
    const made = await json(app, "POST", `/api/buildings/${lab.id}/schedules`, { headers: auth, body: {
      title: "Daily sweep", description: "d", runsAt: new Date(t0 + 3_600_000).toISOString(), repeat: { everyHours: 24, until: new Date(t0 + 4.5 * 86_400_000).toISOString() }, tokensPerRun: 3_000,
    } });
    expect(made.status).toBe(201);
    const id = made.body.schedule.id;
    expect(made.body.schedule).toMatchObject({ lane: "retainer", retainer: "asked", tokensPerRun: 3_000, runsLeft: 5, askTokens: 15_000 });

    const tray = await json(app, "GET", `/api/buildings/${th.id}/intray`, { headers: auth });
    expect(tray.body.retainers).toEqual([expect.objectContaining({ id, askTokens: 15_000 })]);
    expect(tray.body.routes[id]).toMatchObject({ canDecide: true });
    expect((await json(app, "GET", "/api/review-deck", { headers: auth })).body.slides.some((x: { kind: string }) => x.kind === "retainer")).toBe(true);

    const { token } = (() => { const u = world.ops.createUser("Ana"); world.permissions.grant({ kind: "user", id: u.user.id }, townRoleId("member")); return u; })();
    const url = `/api/schedules/${id}/retainer`;
    expect((await json(app, "POST", url, { headers: { authorization: `Bearer ${token}` }, body: { action: "approve" } })).status).toBe(403);
    expect((await json(app, "POST", url, { headers: auth, body: { action: "nope" } })).status).toBe(400);
    world.town.set({ operatingReserveTokens: 1_000_000_000 });
    expect((await json(app, "POST", url, { headers: auth, body: { action: "approve" } })).status).toBe(409);
    world.town.set({ operatingReserveTokens: 0 });
    const inp = world.bank.subscriptionInput()!;
    world.db.prepare("INSERT INTO bank_credits (id, inputId, output, tokens, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?)").run("bc_retainer_test", inp.id, 1_000_000, 1_000_000, new Date().toISOString(), "2099-01-01T00:00:00.000Z");
    const ok = await json(app, "POST", url, { headers: auth, body: { action: "approve", note: "fine" } });
    expect(ok.status).toBe(200);
    // approved for 5 daily runs; within the 6 h lookahead only the first (+1 h) is due, so it claims one run
    expect(ok.body.schedule).toMatchObject({ retainer: "funded", retainerTokens: 15_000, claimTokens: 3_000 });
    expect((await json(app, "POST", url, { headers: auth, body: { action: "approve" } })).status).toBe(409);

    const card = (await json(app, "GET", `/api/buildings/${lab.id}/schedules`)).body.schedules.find((x: { id: string }) => x.id === id);
    expect(card).toMatchObject({ tokensPerRun: 3_000, runsLeft: 5, drawnTokens: 0, retainer: "funded" });
    const bank = (await json(app, "GET", "/api/bank")).body;
    expect(bank.free).toMatchObject({ retainerTokens: 3_000, retainerJobs: 1 });
  });
});
