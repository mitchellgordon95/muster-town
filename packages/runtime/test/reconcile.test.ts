import { describe, expect, it } from "vitest";
import { World } from "@muster-town/core";
import { fetchConsoleCost, reconcileDue } from "../src/reconcile.ts";
import type { Ctx } from "../src/session.ts";

const page = (amounts: string[], next: string | null) => ({ data: [{ results: amounts.map((amount) => ({ currency: "USD", amount })) }], has_more: !!next, next_page: next });

describe("fetchConsoleCost (the Admin API's cost report, raw HTTP)", () => {
  it("sums every page's amounts (decimal cents) into USD for the UTC day, with the Admin key and version headers", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: init!.headers as Record<string, string> });
      const body = calls.length === 1 ? page(["123.45", "100"], "p2") : page(["76.55"], null);
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await fetchConsoleCost("sk-ant-admin01-x", "2026-10-29", fetchFn)).toBe(3);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/organizations/cost_report?starting_at=2026-10-29T00%3A00%3A00Z&ending_at=2026-10-30T00%3A00%3A00Z&bucket_width=1d");
    expect(calls[1].url).toContain("&page=p2");
    expect(calls[0].headers).toMatchObject({ "x-api-key": "sk-ant-admin01-x", "anthropic-version": "2023-06-01" });
    const failing = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    await expect(fetchConsoleCost("k", "2026-10-29", failing)).rejects.toThrow("cost report HTTP 401");
  });
});

describe("reconcileDue (once per UTC day, for the day before)", () => {
  it("a fresh town with no sessions yesterday and no Admin key stays quiet; a day with a session is reconciled once", async () => {
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
    expect(r).toMatchObject({ day: yesterday.slice(0, 10), sessions: 1, apiKeyUsd: 0.5, consoleUsd: null, ok: true });
    expect(await reconcileDue(ctx, now)).toBeNull();
    expect(world.events.list({ types: ["system"], textLike: "Bank reconciliation%" })).toHaveLength(1);
    world.close();
  });
});
