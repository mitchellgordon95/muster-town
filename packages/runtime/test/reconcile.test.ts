import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { World } from "@muster-town/core";
import { reconcileDue } from "../src/reconcile.ts";
import type { Ctx } from "../src/session.ts";

describe("reconcileDue (once per UTC day, for the day before; the Bank checks only itself)", () => {
  it("a fresh town with no sessions yesterday stays quiet; a day with a session is reconciled once", async () => {
    const world = World.open(":memory:");
    const seed = world.seedDefaults({ adminName: "T", importDir: new URL("../../../buildings/carbon-cycle", import.meta.url).pathname });
    const ctx = { world } as unknown as Ctx;
    const now = new Date();
    expect(await reconcileDue(ctx, now)).toBeNull();
    expect(world.events.list({ types: ["system"], textLike: "Bank reconciliation%" })).toHaveLength(0);
    // a session that ended yesterday on the api-key input
    const key = world.bank.addInput(seed.admin.id, { label: "key", source: "api-key", model: "m", tokens: 500_000, recurrence: "once", apiKey: "sk-ant-api03-key" });
    const noor = world.agents.first("name = ?", ["Noor"])!;
    const s = world.ops.startSession(noor.id, { purpose: "work", model: "m", funding: "api-key", credentialInputId: key.id });
    world.ops.endSession(s.id, { status: "done", costUsd: 0.5, tokens: 10 });
    const yesterday = new Date(now.getTime() - 86_400_000).toISOString();
    world.sessions.patch(s.id, { startedAt: yesterday, endedAt: yesterday });
    const r = await reconcileDue(ctx, now);
    expect(r).toEqual({ day: yesterday.slice(0, 10), sessions: 1, subscriptionUsd: 0, apiKeyUsd: 0.5, donorKeyUsd: 0, unlisted: [], mismatches: 0, ok: true });
    expect(await reconcileDue(ctx, now)).toBeNull();
    expect(world.events.list({ types: ["system"], textLike: "Bank reconciliation%" })).toHaveLength(1);
    // the day is remembered in meta, so the next ticks read one row instead of scanning the system events
    expect(world.town.marker("reconciledThrough")).toBe(yesterday.slice(0, 10));
    // a town reconciled by the old code (event, no marker): the first tick finds the event once and sets the marker
    world.db.prepare("DELETE FROM meta WHERE key = 'marker:reconciledThrough'").run();
    expect(await reconcileDue(ctx, now)).toBeNull();
    expect(world.town.marker("reconciledThrough")).toBe(yesterday.slice(0, 10));
    expect(world.events.list({ types: ["system"], textLike: "Bank reconciliation%" })).toHaveLength(1);
    world.close();
  });

  it("the reconciliation never leaves the town: no fetch, no Console or Admin API URL, no secret read (Mitchell, 2026-10-31)", () => {
    const src = readFileSync(new URL("../src/reconcile.ts", import.meta.url), "utf8") + readFileSync(new URL("../../core/src/reconcile.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/fetch\(|api\.anthropic\.com|cost_report|ADMIN_KEY|secrets\./);
  });
});
