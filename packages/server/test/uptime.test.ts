/** Public uptime from outside probes (grant gr_rcj8nkbkbt, kr_6ofa7wf812): ingest, unknown vs down, outages, restart gaps, auth. */
import { townRoleId, World } from "@muster-town/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { outagesOf, Uptime } from "../src/uptime.ts";
import { json, seededApp } from "./helpers.ts";

const NOW = Date.parse("2026-11-10T12:00:30Z");
const at = (iso: string) => `${iso}:15.000Z`;
const minutes = (from: string, n: number, ok: boolean) =>
  Array.from({ length: n }, (_, i) => ({ at: new Date(Date.parse(`${from}:20Z`) + i * 60_000).toISOString(), ok, ms: ok ? 120 : null }));

describe("Uptime", () => {
  let world: World;
  const up = () => new Uptime(world, { now: () => NOW });
  beforeAll(() => { world = World.open(":memory:"); });
  afterEach(() => { world.db.exec("DELETE FROM uptime_probes; DELETE FROM events"); });
  afterAll(() => world.close());

  it("a repeat of a minute is ignored, from the same source; another source counts on its own", () => {
    const u = up();
    expect(u.ingest({ source: "pinger", probes: [{ at: at("2026-11-10T11:00"), ok: true, ms: 90 }, { at: "2026-11-10T11:00:50Z", ok: false }] })).toEqual({ accepted: 1, ignored: 1 });
    expect(u.ingest({ source: "pinger", probes: [{ at: at("2026-11-10T11:00"), ok: true }] })).toEqual({ accepted: 0, ignored: 1 });
    expect(u.ingest({ source: "other", probes: [{ at: at("2026-11-10T11:00"), ok: true }] })).toEqual({ accepted: 1, ignored: 0 });
    expect(world.db.prepare("SELECT COUNT(*) AS n FROM uptime_probes").get()).toEqual({ n: 2 });
  });

  it("probes from the future or older than 35 days are dropped", () => {
    expect(up().ingest({ source: "pinger", probes: [{ at: "2026-11-10T12:10:00Z", ok: true }, { at: "2026-10-01T00:00:00Z", ok: true }] })).toEqual({ accepted: 0, ignored: 2 });
  });

  it("a minute with no probe is unknown, never up; a failed probe is down", () => {
    const u = up();
    u.ingest({ source: "pinger", probes: [...minutes("2026-11-10T10:00", 50, true), ...minutes("2026-11-10T10:50", 3, false)] });
    const s = u.summary();
    expect(s.byDay).toHaveLength(30);
    expect(s.byDay[0].date).toBe("2026-10-12");
    const today = s.byDay[29];
    expect(today.date).toBe("2026-11-10");
    // 00:00 .. 12:00 inclusive = 721 minutes so far today
    expect(today).toEqual({ date: "2026-11-10", up: 50, down: 3, unknown: 721 - 53, pct: 94.3 });
    expect(s.byDay[28]).toEqual({ date: "2026-11-09", up: 0, down: 0, unknown: 1440, pct: null });
    expect(s.pct).toBe(94.3);
    expect(s.up + s.down + s.unknown).toBe(29 * 1440 + 721);
    expect(s.sources).toEqual(["pinger"]);
    expect(s.lastProbeAt).toBe("2026-11-10T10:52:00.000Z");
  });

  it("before any probe: pct null, everything unknown", () => {
    const s = up().summary();
    expect(s.pct).toBeNull();
    expect(s.up + s.down).toBe(0);
    expect(s.coverage).toBe(0);
    expect(s.outages).toEqual([]);
  });

  it("outages: ≥ 2 failed minutes; one unknown minute joins a run, an up minute splits it; a single failure is no outage", () => {
    const u = up();
    u.ingest({ source: "pinger", probes: [
      ...minutes("2026-11-10T09:00", 1, false),                                    // lone failure
      ...minutes("2026-11-10T09:01", 1, true),
      ...minutes("2026-11-10T09:10", 3, false), /* 09:13 unknown */ ...minutes("2026-11-10T09:14", 2, false),
      ...minutes("2026-11-10T09:16", 1, true),
      ...minutes("2026-11-10T09:17", 2, false), ...minutes("2026-11-10T09:19", 1, true), ...minutes("2026-11-10T09:20", 2, false),
      ...minutes("2026-11-10T09:30", 2, false), /* 09:32, 09:33 unknown */ ...minutes("2026-11-10T09:34", 2, false),
    ] });
    expect(u.summary().outages).toEqual([
      { from: "2026-11-10T09:10:00.000Z", to: "2026-11-10T09:16:00.000Z", minutes: 6 },
      { from: "2026-11-10T09:17:00.000Z", to: "2026-11-10T09:19:00.000Z", minutes: 2 },
      { from: "2026-11-10T09:20:00.000Z", to: "2026-11-10T09:22:00.000Z", minutes: 2 },
      { from: "2026-11-10T09:30:00.000Z", to: "2026-11-10T09:32:00.000Z", minutes: 2 },
      { from: "2026-11-10T09:34:00.000Z", to: "2026-11-10T09:36:00.000Z", minutes: 2 },
    ]);
    expect(outagesOf(new Map())).toEqual([]);
  });

  it("a minute is down when any source saw it fail", () => {
    const u = up();
    u.ingest({ source: "pinger", probes: [{ at: at("2026-11-10T08:00"), ok: true }] });
    u.ingest({ source: "second", probes: [{ at: at("2026-11-10T08:00"), ok: false }] });
    expect(u.summary().byDay[29]).toMatchObject({ up: 0, down: 1 });
  });

  it("restart gaps: last event before each boot marker → the boot; a redeploy's restarting event names it", () => {
    world.events.append({ type: "system", text: "Redeploy: restarting", payload: { redeploy: true, run: { state: "restarting" }, terminal: true } });
    world.events.append({ type: "system", text: "Server started", payload: { boot: true } });
    world.events.append({ type: "system", text: "something else" });
    world.events.append({ type: "system", text: "Server started", payload: { boot: true } });
    const rows = world.db.prepare("SELECT id FROM events ORDER BY id").all() as { id: number }[];
    const set = world.db.prepare("UPDATE events SET ts = ? WHERE id = ?");
    ["2026-11-10T06:00:00.000Z", "2026-11-10T06:00:42.000Z", "2026-11-10T07:00:00.000Z", "2026-11-10T07:03:00.000Z"].forEach((ts, i) => set.run(ts, rows[i].id));
    expect(up().summary().restarts).toEqual([
      { from: "2026-11-10T06:00:00.000Z", to: "2026-11-10T06:00:42.000Z", seconds: 42, kind: "redeploy" },
      { from: "2026-11-10T07:00:00.000Z", to: "2026-11-10T07:03:00.000Z", seconds: 180, kind: "unclean" },
    ]);
  });
});

describe("/api/uptime routes", () => {
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => { await close?.(); close = null; });

  it("POST needs town.uptime (role prober); GET is public", async () => {
    const t = await seededApp();
    close = t.close;
    const noor = t.by("Noor");
    const agentAuth = { authorization: `Bearer ${t.world.tokens.getOrCreate("agent", noor.id)}` };
    const body = { probes: [{ at: new Date(Date.now() - 60_000).toISOString(), ok: true, ms: 80 }] };

    expect((await json(t.app, "POST", "/api/uptime/probes", { body })).status).toBe(401);
    const denied = await json(t.app, "POST", "/api/uptime/probes", { headers: agentAuth, body });
    expect(denied.status).toBe(403);
    expect(t.world.db.prepare("SELECT COUNT(*) AS n FROM uptime_probes").get()).toEqual({ n: 0 });

    t.world.permissions.grant(noor, townRoleId("prober"));
    const ok = await json(t.app, "POST", "/api/uptime/probes", { headers: agentAuth, body });
    expect(ok).toEqual({ status: 200, body: { accepted: 1, ignored: 0 } });
    expect((await json(t.app, "POST", "/api/uptime/probes", { headers: agentAuth, body: { probes: [{ at: "nope", ok: true }] } })).status).toBe(400);

    const pub = await json(t.app, "GET", "/api/uptime");
    expect(pub.status).toBe(200);
    expect(pub.body.byDay).toHaveLength(30);
    expect(pub.body.up).toBe(1);
    expect(pub.body.sources).toEqual(["pinger"]);
    expect(pub.body.restarts).toEqual(expect.any(Array));
  });
});
