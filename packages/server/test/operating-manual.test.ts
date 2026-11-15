/** GET /api/operating-manual (1:1 mt_t65exni4et): the Town Hall doc tagged operating-manual, public; 404 before it exists. */
import { afterEach, describe, expect, it } from "vitest";
import { json, seededApp } from "./helpers.ts";
import { createDoc } from "@muster-town/core";

let close: (() => Promise<void>) | null = null;
afterEach(async () => { await close?.(); close = null; });

describe("GET /api/operating-manual", () => {
  it("404 before the manual exists, then its id, title and body, signed out", async () => {
    const s = await seededApp();
    close = s.close;
    expect((await json(s.app, "GET", "/api/operating-manual")).status).toBe(404);
    const sec = s.world.secretary.ensure()!;
    const d = createDoc(s.world, { type: "article", state: "library", buildingId: "town-hall", title: "Operating manual", tags: ["operating-manual"], authorId: sec.id, authorKind: "agent", body: "## Jobs\nEvery piece of work is a job." });
    const r = await json(s.app, "GET", "/api/operating-manual");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: d.id, title: "Operating manual", body: "## Jobs\nEvery piece of work is a job." });
  });
});
