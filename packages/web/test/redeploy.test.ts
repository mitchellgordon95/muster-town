import { describe, expect, test } from "vitest";
import type { Event } from "@muster-town/schema";
import { blockedByRedeploy, cacheMissAlert, redeployChanges, redeployLine, redeployStatus, SHOW_FINISHED_MS } from "../src/redeploy";

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
    ({ id: ++id, ts, type: "system", agentId: null, buildingId: null, text: "Cache miss: manage sessions on m wrote 31%…", payload: { busting: 3, ...payload } }) as Event;
  test("the latest cache-miss of the last day shows; an older one or another alert does not", () => {
    expect(cacheMissAlert([cm("2026-10-20T10:00:00.000Z")], at)?.text).toMatch(/^Cache miss: manage/);
    expect(cacheMissAlert([cm("2026-10-19T10:00:00.000Z")], at)).toBeNull();
    expect(cacheMissAlert([cm("2026-10-20T10:00:00.000Z", { alert: "funding-mismatch" })], at)).toBeNull();
  });
  test("an alert read from the server shows after it scrolled out of the client's events; the newest of both wins", () => {
    const early = cm("2026-10-20T00:05:00.000Z");
    const recent = [ev(null), ev(null)];
    expect(cacheMissAlert(recent, at)).toBeNull();
    expect(cacheMissAlert(recent, at, [early])?.id).toBe(early.id);
    const later = cm("2026-10-20T12:00:00.000Z");
    expect(cacheMissAlert([...recent, later], at, [early])?.id).toBe(later.id);
    expect(cacheMissAlert(recent, at, [cm("2026-10-19T10:00:00.000Z")])).toBeNull();
  });
  test("an old-format alert (cache-write share: `reasons`, no `busting`) never shows", () => {
    const old = { ...cm("2026-10-20T00:00:30.000Z"), payload: { alert: "cache-miss", reasons: ["share"], sessions: 1 } } as Event;
    expect(cacheMissAlert([old], at)).toBeNull();
    expect(cacheMissAlert([], at, [old])).toBeNull();
  });
});

describe("redeploy changes on the HUD card (1:1 mt_db6itzy2br)", () => {
  const changes = [{ sha: "327109b", subject: "Hydrant: one stream (#414)" }, { sha: "aacc9fe", subject: "Schema image (#247)" }];
  test("a finished run lists its changes, each linked to its commit", () => {
    const s = redeployStatus([ev(run("done", { commits: 5, changes, repoUrl: "https://github.com/o/r" }))], at)!;
    expect(redeployChanges(s)).toEqual([
      { sha: "327109b", subject: "Hydrant: one stream (#414)", href: "https://github.com/o/r/commit/327109b" },
      { sha: "aacc9fe", subject: "Schema image (#247)", href: "https://github.com/o/r/commit/aacc9fe" },
    ]);
  });
  test("no repo: lines without links; failed or interrupted: no lines (the steps come first); old events: none", () => {
    expect(redeployChanges(redeployStatus([ev(run("restarting", { changes }))], at)!).map((c) => c.href)).toEqual([undefined, undefined]);
    expect(redeployChanges(redeployStatus([ev(run("failed", { changes, repoUrl: "https://github.com/o/r" }))], at)!)).toEqual([]);
    expect(redeployChanges(redeployStatus([ev(run("aborted", { changes }))], at)!)).toEqual([]);
    expect(redeployChanges(redeployStatus([ev(run("done"))], at)!)).toEqual([]);
  });
});
