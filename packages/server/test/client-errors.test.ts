/** Browser errors (grant gr_cyqzweu6ed step 1): POST /api/client-errors from anyone, rate-limited per IP; GET lists by kind. */
import { describe, expect, it } from "vitest";
import { json, seededApp } from "./helpers.ts";

const crash = { source: "panel", message: "crash test: this panel throws on purpose", stack: "Error: crash test\n    at CrashTestPanel (https://muster.town/workshop/assets/index-Bx9_k2Qa.js:1:2)", panel: "crash-test", route: "#/crash-test" };

describe("client errors routes", () => {
  it("records a guest's sendBeacon post (text/plain) with the live commit; a repeat counts, no new kind; GET is public", async () => {
    const t = await seededApp();
    try {
      t.world.host.commit = "e6b53093abc";
      const beacon = await t.app.inject({ method: "POST", url: "/api/client-errors", headers: { "content-type": "text/plain;charset=UTF-8" }, payload: JSON.stringify(crash) });
      expect(beacon.statusCode).toBe(200);
      expect(beacon.json()).toEqual({ recorded: true, new: true });
      expect((await json(t.app, "POST", "/api/client-errors", { body: crash })).body).toEqual({ recorded: true, new: false });
      const v = await json(t.app, "GET", "/api/client-errors");
      expect(v.status).toBe(200);
      expect(v.body.kinds).toHaveLength(1);
      expect(v.body.kinds[0]).toMatchObject({ source: "panel", panel: "crash-test", message: "crash test: this panel throws on purpose", frame: "CrashTestPanel (index.js)", firstCommit: "e6b53093abc", lastCommit: "e6b53093abc", count: 2 });
      expect(JSON.stringify(v.body)).not.toMatch(/us_|127\.0\.0\.1/);
      expect((await json(t.app, "POST", "/api/client-errors", { body: { source: "panel" } })).status).toBe(400);
      expect((await t.app.inject({ method: "POST", url: "/api/client-errors", headers: { "content-type": "text/plain" }, payload: "not json" })).statusCode).toBe(400);
    } finally { await t.close(); }
  });

  it("a signed-in visitor not yet let in may post; past 30 posts an hour from one IP it is 429", async () => {
    const t = await seededApp();
    try {
      const stranger = t.world.ops.createUser("Stranger").token;
      expect((await json(t.app, "POST", "/api/client-errors", { headers: { authorization: `Bearer ${stranger}` }, body: { source: "error", message: "x" } })).status).toBe(200);
      for (let i = 1; i < 30; i++) await json(t.app, "POST", "/api/client-errors", { body: { source: "error", message: "x" } });
      const over = await json(t.app, "POST", "/api/client-errors", { body: { source: "error", message: "x" } });
      expect(over.status).toBe(429);
      expect((await json(t.app, "GET", "/api/client-errors")).body.kinds[0].count).toBe(30);
    } finally { await t.close(); }
  });
});
