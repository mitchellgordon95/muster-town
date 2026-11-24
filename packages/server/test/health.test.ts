import { afterEach, describe, expect, it, vi } from "vitest";
import { json, seededApp } from "./helpers.ts";
import { World } from "@muster-town/core";
import type { RuntimeHooks, TickStat } from "../src/context.ts";
import { bootCause, CapacityProbe, markBoot, markStop, p95 } from "../src/capacity.ts";

let close: (() => Promise<void>) | null = null;
afterEach(async () => { await close?.(); close = null; });

describe("GET /api/health answers from memory (503 post-mortem 2026-10-31, follow-up A)", () => {
  it("with a refresh period, a request never touches the database; the keys the pinger and the morning check read stay", async () => {
    const s = await seededApp({ healthRefreshMs: 60_000 });
    close = s.close;
    const first = await json(s.app, "GET", "/api/health");
    expect(first.status).toBe(200);
    const db = s.world.db;
    const prepare = db.prepare.bind(db);
    let queries = 0;
    (db as { prepare: typeof db.prepare }).prepare = ((sql: string) => { queries++; throw new Error(`health queried the database: ${sql}`); }) as typeof db.prepare;
    try {
      const again = await json(s.app, "GET", "/api/health");
      expect(again.status).toBe(200);
      expect(queries).toBe(0);
      expect(again.body).toMatchObject({ ok: true, figuresAt: first.body.figuresAt });
      for (const k of ["ok", "runtime", "commit", "startedAt", "time", "accounting", "load", "budgets", "backup", "monitor", "desks", "figuresAt"]) expect(again.body).toHaveProperty(k);
    } finally {
      (db as { prepare: typeof db.prepare }).prepare = prepare;
    }
  });

  it("load carries the Machine's memAvailableMb, swapMb and swapUsedMb (numbers on Linux, null elsewhere; gr_xgr8j2f9ao)", async () => {
    const s = await seededApp();
    close = s.close;
    const { load } = (await json(s.app, "GET", "/api/health")).body as { load: Record<string, unknown> };
    for (const k of ["memAvailableMb", "swapMb", "swapUsedMb"]) {
      expect(load).toHaveProperty(k);
      expect(typeof load[k]).toBe(process.platform === "linux" ? "number" : "object");
    }
  });

  it("without one (tests, the default) each request computes the figures afresh", async () => {
    const s = await seededApp();
    close = s.close;
    const a = await json(s.app, "GET", "/api/health");
    await new Promise((r) => setTimeout(r, 5));
    const b = await json(s.app, "GET", "/api/health");
    expect(b.body.figuresAt > a.body.figuresAt).toBe(true);
  });
});

describe("GET /api/health capacity (gr_n0p3ast5pp step 3, docs/scaling.md \"How to check headroom live\")", () => {
  it("carries the four figures, non-null, with the doc's ceilings", async () => {
    const s = await seededApp();
    close = s.close;
    const { body } = await json(s.app, "GET", "/api/health");
    const c = body.capacity;
    expect(c.wsClients).toEqual({ now: 0, ceiling: 1200 });
    expect(c.tick).toMatchObject({ slowMs: 500, samples: 0 });
    expect(c.db.mb).not.toBeNull();
    expect(c.db.volumeGb).toBeGreaterThan(0);
    expect(c.restarts24h).toBe(0);
    expect(typeof c.at).toBe("string");
  });

  it("p95 of the last distinct ticks (deduped on at, last 100 kept)", async () => {
    let i = 0;
    let stat: TickStat = { at: "t0", ms: 0, phase: null, phaseMs: 0, phases: {} };
    const s = await seededApp({ runtime: { tickStats: () => ({ last: stat, slow: null }) } as RuntimeHooks });
    close = s.close;
    // 120 ticks of 1..120 ms, each health call twice: the duplicate is ignored, the first 20 fall out of the ring
    let last: any;
    for (i = 1; i <= 120; i++) {
      stat = { at: `t${i}`, ms: i, phase: null, phaseMs: 0, phases: {} };
      await json(s.app, "GET", "/api/health");
      last = (await json(s.app, "GET", "/api/health")).body.capacity;
    }
    expect(last.tick.samples).toBe(100);
    expect(last.tick.p95Ms).toBe(115); // 21..120: the 95th of 100 sorted
    expect(p95([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 1000])).toBe(19);
    expect(p95([])).toBeNull();
  });

  it("restarts24h counts the boot markers of the last day only", async () => {
    const world = World.open(":memory:");
    const now = Date.now();
    await markBoot(world, { env: {} });
    await markBoot(world, { env: {} });
    world.events.append({ type: "system", text: "Redeploy finished", payload: {} });
    world.db.prepare("UPDATE events SET ts = ? WHERE id = (SELECT MIN(id) FROM events WHERE json_extract(payload, '$.boot') IS NOT NULL)").run(new Date(now - 25 * 3600_000).toISOString());
    const probe = new CapacityProbe(world, { ws: () => 3, tick: () => null });
    expect(probe.compute()).toMatchObject({ restarts24h: 1, wsClients: { now: 3, ceiling: 1200 }, tick: { p95Ms: null, samples: 0 } });
    let t = now;
    const later = new CapacityProbe(world, { ws: () => 0, tick: () => null, now: () => t });
    t = now + 24 * 3600_000 + 1000;
    expect(later.compute().restarts24h).toBe(0);
    world.close?.();
  });
});

describe("why each server boot happened (gr_zsglqgxpew, kr_q82dyp154n)", () => {
  const fly = { FLY_MACHINE_ID: "m1", FLY_APP_NAME: "muster-town" };
  const lastBoot = (w: World) => w.events.list({ types: ["system"], payloadKey: "boot", desc: true, limit: 1 })[0]!;
  const withToken = (w: World) => { vi.spyOn(w.secrets, "value").mockImplementation((n: string) => (n === "FLY_LOGS_TOKEN" ? "tok" : null)); };
  const redeployRestart = (w: World) => w.events.append({ type: "system", text: "Redeploy: restarting server; 1 desk session(s) keep running and are adopted after it", payload: { redeploy: true, terminal: true } });

  it("redeploy: the redeploy's restart event since the last marker wins, even with a stop marker after it", async () => {
    const world = World.open(":memory:");
    await markBoot(world, { env: {} });
    redeployRestart(world);
    markStop(world, "SIGTERM");
    const fetch = vi.fn();
    await markBoot(world, { env: fly, fetch });
    expect(lastBoot(world).payload).toMatchObject({ boot: true, cause: "redeploy", exitCode: null, oomKilled: null });
    expect(fetch).not.toHaveBeenCalled();
    const c = new CapacityProbe(world, { ws: () => 0, tick: () => null }).compute();
    expect(c.lastBoot).toMatchObject({ at: lastBoot(world).ts, cause: "redeploy" });
    expect(c.restartsByCause24h).toEqual({ redeploy: 1, stopped: 0, unplanned: 1, unknown: 0 });
    world.close?.();
  });

  it("stopped: the signal handler's marker alone", async () => {
    const world = World.open(":memory:");
    await markBoot(world, { env: {} });
    markStop(world, "SIGINT");
    expect(bootCause(world)).toBe("stopped");
    await markBoot(world, { env: {} });
    expect(lastBoot(world).payload.cause).toBe("stopped");
    expect(bootCause(world)).toBe("unplanned"); // a marker before the last boot no longer counts
    world.close?.();
  });

  it("unplanned on Fly: the newest exit event after the last boot gives the exit code and OOM flag", async () => {
    const world = World.open(":memory:");
    await markBoot(world, { env: {} });
    withToken(world);
    const prevAt = Date.parse(lastBoot(world).ts);
    const now = prevAt + 60_000;
    const events = [
      { type: "start", timestamp: now - 1000 },
      { type: "exit", timestamp: now - 2000, request: { exit_event: { exit_code: 137, oom_killed: true, requested_stop: false } } },
      { type: "exit", timestamp: now - 5000, request: { exit_event: { exit_code: 1, oom_killed: false } } },
      { type: "exit", timestamp: prevAt - 5000, request: { exit_event: { exit_code: 2, oom_killed: false } } },
    ];
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => events }));
    await markBoot(world, { env: fly, fetch, now: () => now });
    expect(fetch).toHaveBeenCalledWith("https://api.machines.dev/v1/apps/muster-town/machines/m1/events", expect.objectContaining({ headers: { Authorization: "Bearer tok" } }));
    expect(lastBoot(world).payload).toMatchObject({ cause: "unplanned", exitCode: 137, oomKilled: true });
    expect(new CapacityProbe(world, { ws: () => 0, tick: () => null }).compute().lastBoot).toMatchObject({ cause: "unplanned", exitCode: 137, oomKilled: true });
    world.close?.();
  });

  it("unplanned with a failed Fly read: logs, and the marker is written without an exit code", async () => {
    const world = World.open(":memory:");
    withToken(world);
    const log = vi.fn();
    await markBoot(world, { env: fly, fetch: async () => { throw new Error("timeout"); }, log });
    expect(lastBoot(world).payload).toMatchObject({ boot: true, cause: "unplanned", exitCode: null, oomKilled: null });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("timeout"));
    await markBoot(world, { env: fly, fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }), log });
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("401"));
    world.close?.();
  });

  it("unplanned without the token or off Fly: no fetch; old markers count as unknown", async () => {
    const world = World.open(":memory:");
    world.events.append({ type: "system", text: "Server started", payload: { boot: true } });
    const fetch = vi.fn();
    await markBoot(world, { env: fly, fetch });
    withToken(world);
    await markBoot(world, { env: {}, fetch });
    expect(fetch).not.toHaveBeenCalled();
    expect(new CapacityProbe(world, { ws: () => 0, tick: () => null }).compute().restartsByCause24h).toEqual({ redeploy: 0, stopped: 0, unplanned: 2, unknown: 1 });
    world.close?.();
  });
});

describe("GET /api/health main (gr_7op2v8fjcl, kr_mvj61meiwx)", () => {
  it("null without a runtime read; then main's CI state from the runtime's hook, from memory", async () => {
    const s = await seededApp();
    close = s.close;
    expect((await json(s.app, "GET", "/api/health")).body.main).toBeNull();
    s.world.host.mainCi = () => ({ state: "red", sha: "abc1234", failedStep: "check", since: "2026-11-04T18:00:00.000Z", fixer: null, checkedAt: "2026-11-04T18:05:00.000Z" });
    expect((await json(s.app, "GET", "/api/health")).body.main).toEqual({ state: "red", sha: "abc1234", failedStep: "check", since: "2026-11-04T18:00:00.000Z", fixer: null, checkedAt: "2026-11-04T18:05:00.000Z" });
  });
});
