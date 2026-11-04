import { afterEach, describe, expect, it } from "vitest";
import { json, seededApp } from "./helpers.ts";
import { World } from "@muster-town/core";
import type { RuntimeHooks, TickStat } from "../src/context.ts";
import { CapacityProbe, markBoot, p95 } from "../src/capacity.ts";

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

  it("restarts24h counts the boot markers of the last day only", () => {
    const world = World.open(":memory:");
    const now = Date.now();
    markBoot(world);
    markBoot(world);
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
