/** GET /api/jobs/:id (plan dc_uwx045472m step 3, read only): a job and its thread, by job id or what it tracks; 404 for none. */
import { describe, expect, it } from "vitest";
import { json, seededApp } from "./helpers.ts";

describe("GET /api/jobs/:id", () => {
  it("reads a building's job by its id or the building's, pages its thread, and 404s an unknown id", async () => {
    const { app, world, close } = await seededApp();
    try {
      const b = (world.db.prepare("SELECT id FROM buildings LIMIT 1").get() as { id: string }).id;
      const byBuilding = await json(app, "GET", `/api/jobs/${b}`);
      expect(byBuilding.status).toBe(200);
      expect(byBuilding.body.job).toMatchObject({ id: `jb_${b}`, rule: "building", status: "open", buildingId: b });
      expect(Array.isArray(byBuilding.body.entries)).toBe(true);
      expect((await json(app, "GET", `/api/jobs/jb_${b}?from=1&limit=5`)).body.job.id).toBe(`jb_${b}`);
      expect((await json(app, "GET", "/api/jobs/jb_nothing")).status).toBe(404);
      expect((await json(app, "GET", `/api/jobs/jb_${b}?limit=500`)).status).toBe(400);
    } finally { await close(); }
  });
});
