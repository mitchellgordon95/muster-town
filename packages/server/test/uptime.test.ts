/** Public uptime (gr_hbz0twkfp9): UptimeRobot's ratios mapped to days, its down logs as outages, a 5-min cache, no number without a key, restart gaps; the probe POST is gone. */
import { World } from "@muster-town/core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Uptime } from "../src/uptime.ts";
import { json, seededApp } from "./helpers.ts";

const NOW = Date.parse("2026-11-10T12:00:30Z");
const sec = (isoStr: string) => Date.parse(isoStr) / 1000;

/** a getMonitors answer: 30 day ratios (oldest first) plus the 30-day total */
function robot(days: number[], total: number, extra: Record<string, unknown> = {}) {
  return { stat: "ok", monitors: [{ url: "https://muster.town/api/health", create_datetime: sec("2026-09-01T00:00:00Z"), custom_uptime_ranges: [...days, total].map((x) => x.toFixed(3)).join("-"), logs: [], ...extra }] };
}
function fakeFetch(answer: unknown, status = 200) {
  return vi.fn(async (_url: string, _init: { body: string }) => ({ ok: status < 400, status, json: async () => answer }));
}

describe("Uptime", () => {
  let world: World;
  let secrets: Record<string, string>;
  const up = (fetch: ReturnType<typeof fakeFetch>, now = () => NOW) => new Uptime(world, { now, fetch: fetch as never });
  beforeAll(() => {
    world = World.open(":memory:");
    vi.spyOn(world.secrets, "value").mockImplementation((name: string) => secrets[name] ?? null);
  });
  afterEach(() => { world.db.exec("DELETE FROM events"); });
  afterAll(() => world.close());

  it("maps each day's ratio into the strip and the 30-day total into pct; sends 31 ranges with the key", async () => {
    secrets = { UPTIMEROBOT_API_KEY: "ur-test-key", UPTIMEROBOT_STATUS_URL: "https://stats.uptimerobot.com/abc" };
    const days = Array.from({ length: 30 }, () => 100);
    days[28] = 99.5;
    const f = fakeFetch(robot(days, 99.98));
    const s = await up(f).summary();
    expect(s.source).toBe("uptimerobot");
    expect(s.statusUrl).toBe("https://stats.uptimerobot.com/abc");
    expect(s.pct).toBe(99.98);
    expect(s.error).toBeNull();
    expect(s.byDay).toHaveLength(30);
    expect(s.byDay[0]).toEqual({ date: "2026-10-12", up: 1440, down: 0, unknown: 0, pct: 100 });
    expect(s.byDay[28]).toEqual({ date: "2026-11-09", up: 1433, down: 7, unknown: 0, pct: 99.5 });
    // 00:00 .. 12:00 = 720 whole minutes so far today
    expect(s.byDay[29]).toMatchObject({ date: "2026-11-10", up: 720, down: 0, pct: 100 });
    const body = new URLSearchParams(f.mock.calls[0][1].body);
    expect(body.get("api_key")).toBe("ur-test-key");
    const ranges = body.get("custom_uptime_ranges")!.split("-");
    expect(ranges).toHaveLength(31);
    expect(ranges[0]).toBe(`${sec("2026-10-12T00:00:00Z")}_${sec("2026-10-13T00:00:00Z")}`);
    expect(ranges[30]).toBe(`${sec("2026-10-12T00:00:00Z")}_${Math.floor(NOW / 1000)}`);
  });

  it("days before the monitor existed are unknown; its down logs are the outages", async () => {
    secrets = { UPTIMEROBOT_API_KEY: "k" };
    const days: number[] = Array.from({ length: 30 }, (_, i) => (i < 27 ? 0 : 100));
    days[28] = 99;
    const logs = [
      { type: 2, datetime: sec("2026-11-09T03:20:00Z"), duration: 600 },
      { type: 1, datetime: sec("2026-11-09T03:00:00Z"), duration: 1200 },
      { type: 1, datetime: sec("2026-01-01T00:00:00Z"), duration: 60 },
    ];
    const s = await up(fakeFetch(robot(days, 99.6, { create_datetime: sec("2026-11-08T12:00:00Z"), logs }))).summary();
    expect(s.byDay[26]).toEqual({ date: "2026-11-07", up: 0, down: 0, unknown: 1440, pct: null });
    expect(s.byDay[27]).toEqual({ date: "2026-11-08", up: 720, down: 0, unknown: 720, pct: 100 });
    expect(s.byDay[28]).toMatchObject({ date: "2026-11-09", down: 14, pct: 99 });
    expect(s.pct).toBe(99.6);
    expect(s.coverage).toBeLessThan(10);
    expect(s.outages).toEqual([{ from: "2026-11-09T03:00:00.000Z", to: "2026-11-09T03:20:00.000Z", minutes: 20 }]);
    expect(s.statusUrl).toBeNull();
  });

  it("keeps a reading 5 minutes; a failed read is retried after 1 minute", async () => {
    secrets = { UPTIMEROBOT_API_KEY: "k" };
    let now = NOW;
    const f = fakeFetch(robot(Array(30).fill(100), 100));
    const u = up(f, () => now);
    await u.summary(); await u.summary();
    now += 4 * 60_000; await u.summary();
    expect(f).toHaveBeenCalledTimes(1);
    now += 2 * 60_000; await u.summary();
    expect(f).toHaveBeenCalledTimes(2);

    const bad = fakeFetch({}, 500);
    const v = up(bad, () => now);
    expect((await v.summary()).error).toBe("UptimeRobot answered HTTP 500");
    now += 30_000; await v.summary();
    expect(bad).toHaveBeenCalledTimes(1);
    now += 40_000; await v.summary();
    expect(bad).toHaveBeenCalledTimes(2);
  });

  it("no key, an API error or a throw: no number, source unknown, the status page still linked", async () => {
    secrets = { UPTIMEROBOT_STATUS_URL: "https://stats.uptimerobot.com/abc" };
    const f = fakeFetch(robot(Array(30).fill(100), 100));
    const none = await up(f).summary();
    expect(f).not.toHaveBeenCalled();
    expect(none).toMatchObject({ pct: null, source: "unknown", statusUrl: "https://stats.uptimerobot.com/abc", error: "no UPTIMEROBOT_API_KEY secret", outages: [] });
    expect(none.byDay.every((d) => d.pct === null)).toBe(true);

    secrets = { UPTIME_STATUS_URL: "https://stats.uptimerobot.com/live" };
    expect((await up(fakeFetch(robot(Array(30).fill(100), 100))).summary()).statusUrl).toBe("https://stats.uptimerobot.com/live");

    secrets = { UPTIMEROBOT_API_KEY: "k" };
    const fail = await up(fakeFetch({ stat: "fail", error: { type: "invalid_parameter", message: "api_key is wrong" } })).summary();
    expect(fail).toMatchObject({ pct: null, source: "unknown", error: "UptimeRobot: api_key is wrong" });
    expect(JSON.stringify(fail)).not.toContain("\"k\"");
    const thrown = vi.fn(async () => { throw new TypeError("fetch failed"); });
    expect(await up(thrown as never).summary()).toMatchObject({ pct: null, source: "unknown", error: "UptimeRobot unreachable: TypeError" });
  });

  it("restart gaps: last event before each boot marker → the boot; a redeploy's restarting event names it", async () => {
    secrets = {};
    world.events.append({ type: "system", text: "Redeploy: restarting", payload: { redeploy: true, run: { state: "restarting" }, terminal: true } });
    world.events.append({ type: "system", text: "Server started", payload: { boot: true } });
    world.events.append({ type: "system", text: "something else" });
    world.events.append({ type: "system", text: "Server started", payload: { boot: true } });
    const rows = world.db.prepare("SELECT id FROM events ORDER BY id").all() as { id: number }[];
    const set = world.db.prepare("UPDATE events SET ts = ? WHERE id = ?");
    ["2026-11-10T06:00:00.000Z", "2026-11-10T06:00:42.000Z", "2026-11-10T07:00:00.000Z", "2026-11-10T07:03:00.000Z"].forEach((ts, i) => set.run(ts, rows[i].id));
    expect((await up(fakeFetch({})).summary()).restarts).toEqual([
      { from: "2026-11-10T06:00:00.000Z", to: "2026-11-10T06:00:42.000Z", seconds: 42, kind: "redeploy" },
      { from: "2026-11-10T07:00:00.000Z", to: "2026-11-10T07:03:00.000Z", seconds: 180, kind: "unclean" },
    ]);
  });
});

describe("/api/uptime routes", () => {
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => { await close?.(); close = null; });

  it("GET is public and answers 200 with no key; the probe POST is gone", async () => {
    const t = await seededApp();
    close = t.close;
    const noor = t.by("Noor");
    const agentAuth = { authorization: `Bearer ${t.world.tokens.getOrCreate("agent", noor.id)}` };
    const body = { probes: [{ at: new Date(Date.now() - 60_000).toISOString(), ok: true, ms: 80 }] };
    expect((await json(t.app, "POST", "/api/uptime/probes", { headers: agentAuth, body })).status).toBe(404);
    expect(t.world.db.prepare("SELECT 1 FROM roles WHERE id = 'role:prober'").get()).toBeUndefined();

    const pub = await json(t.app, "GET", "/api/uptime");
    expect(pub.status).toBe(200);
    expect(pub.body.byDay).toHaveLength(30);
    expect(pub.body.pct).toBeNull();
    expect(pub.body.source).toBe("unknown");
    expect(pub.body.restarts).toEqual(expect.any(Array));
  });
});
