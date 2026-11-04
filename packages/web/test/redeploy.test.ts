import { describe, expect, test } from "vitest";
import type { Event } from "@muster-town/schema";
import { blockedByRedeploy, cacheMissAlert, redeployLine, redeployStatus, SHOW_FINISHED_MS } from "../src/redeploy";

let id = 0;
const ev = (run: Record<string, unknown> | null, ts = "2026-10-20T18:00:00.000Z", text = "Redeploy: x"): Event =>
  ({ id: ++id, ts, type: "system", agentId: null, buildingId: null, text, payload: run ? { redeploy: true, run } : {} }) as Event;
const run = (state: string, o: Record<string, unknown> = {}) => ({ state, requestedBy: "Pix", commits: 3, working: [], blocked: [], ...o });
const at = Date.parse("2026-10-20T18:00:00.000Z");

describe("redeploy status", () => {
  test("reads the latest redeploy event's run; other events don't count", () => {
    const events = [ev(run("running")), ev(run("scheduled", { working: ["ag_1"], blocked: ["ag_2"] })), ev(null)];
    const s = redeployStatus(events, at)!;
    expect(s.state).toBe("scheduled");
    expect(redeployLine(s, (i) => (i === "ag_1" ? "Root" : i === "ag_2" ? "Lena" : i))).toBe("Redeploy scheduled: 3 changes waiting; restarts when 1 session finishes (Root); Lena waits for it");
    expect([...blockedByRedeploy(events)]).toEqual(["ag_2"]);
  });

  test("a finished redeploy shows for a while, then disappears; no agent is badged", () => {
    const events = [ev(run("scheduled", { blocked: ["ag_2"] })), ev(run("done"))];
    expect(redeployLine(redeployStatus(events, at)!, String)).toBe("Redeploy finished: 3 changes live");
    expect(redeployStatus(events, at + SHOW_FINISHED_MS + 1)).toBeNull();
    expect(blockedByRedeploy(events).size).toBe(0);
  });

  test("no redeploy events: nothing to show", () => {
    expect(redeployStatus([ev(null)], at)).toBeNull();
  });
});

describe("cache-miss alert in the HUD (gr_lwgus14rd2 step 2)", () => {
  const cm = (ts: string, payload: Record<string, unknown> = { alert: "cache-miss", purpose: "manage" }): Event =>
    ({ id: ++id, ts, type: "system", agentId: null, buildingId: null, text: "Cache miss: manage sessions on m wrote 31%…", payload }) as Event;
  test("the latest cache-miss of the last day shows; an older one or another alert does not", () => {
    expect(cacheMissAlert([cm("2026-10-20T10:00:00.000Z")], at)?.text).toMatch(/^Cache miss: manage/);
    expect(cacheMissAlert([cm("2026-10-19T10:00:00.000Z")], at)).toBeNull();
    expect(cacheMissAlert([cm("2026-10-20T10:00:00.000Z", { alert: "funding-mismatch" })], at)).toBeNull();
  });
});
