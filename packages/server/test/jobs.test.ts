import { afterEach, describe, expect, it } from "vitest";
import { json, seededApp } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const LAB = "carbon-cycle";

describe("GET /api/jobs/:id (the job abstraction, step 1: read only)", () => {
  it("a funded grant's id reads its ceiling job and thread, signed out; a building id reads its building job; unknown is 404", async () => {
    const s = await seededApp();
    cleanups.push(s.close);
    const { world, app } = s;
    const plan = { title: "Lab banner for visitors", objective: "Visitors can tell what the lab is for", steps: [{ size: "M" as const, title: "Ship the banner", description: "One PR" }], stopCondition: "two failed tries", askTokens: 100_000, keyResults: [{ text: "A banner", howToCheck: "Open the lab" }] };
    const g = world.grantDesk.propose(null, world.grantDesk.create(null, LAB, plan).id);
    expect((await json(app, "POST", `/api/grants/${g.id}/decide`, { headers: s.auth, body: { action: "fund" } })).status).toBe(200);

    const got = await json(app, "GET", `/api/jobs/${g.id}`);
    expect(got.status).toBe(200);
    expect(got.body.job).toMatchObject({ rule: "ceiling", pocketRef: g.id, buildingId: LAB, status: "open" });
    expect(got.body.entries.map((e: { moved: { action?: string } }) => e.moved.action)).toEqual(["propose", "fund"]);
    // the job's own id reads the same job
    expect((await json(app, "GET", `/api/jobs/${got.body.job.id}`)).body.job.id).toBe(got.body.job.id);

    const b = await json(app, "GET", `/api/jobs/${LAB}`);
    expect(b.body.job).toMatchObject({ rule: "building", buildingId: LAB });
    expect((await json(app, "GET", "/api/jobs/jb_nope")).status).toBe(404);
  });
});
