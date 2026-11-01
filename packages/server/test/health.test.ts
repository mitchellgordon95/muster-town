import { afterEach, describe, expect, it } from "vitest";
import { json, seededApp } from "./helpers.ts";

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
