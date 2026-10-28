import { describe, expect, it } from "vitest";
import { DELETED_INPUT, financeSources, financeSummary, type SourcesInputs } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const T0 = new Date("2026-10-20T12:00:00.000Z");
const at = (days: number) => new Date(T0.getTime() + days * 86_400_000);
const iso = (days: number) => at(days).toISOString();

const fixture: SourcesInputs = {
  users: [{ id: "u1", name: "Mitchell" }],
  buildings: [{ id: "b1", name: "Workshop" }],
  inputs: [
    { id: "key", userId: "u1", label: "API key", source: "api-key", recurrence: "once", createdAt: iso(0), cancelledAt: null },
    { id: "sub", userId: "u1", label: "Subscription", source: "subscription", recurrence: "daily", createdAt: iso(-2), cancelledAt: iso(5) },
  ],
  credits: [
    { id: "d1", inputId: "key", tokens: 5000, createdAt: iso(0), expiresAt: null }, // durable
    { id: "s1", inputId: "sub", tokens: 1000, createdAt: iso(-2), expiresAt: iso(-1) }, // expired, never drawn
    { id: "s2", inputId: "sub", tokens: 1000, createdAt: iso(-1), expiresAt: iso(0) }, // expired, partly drawn
    { id: "s3", inputId: "sub", tokens: 1000, createdAt: iso(0), expiresAt: iso(1) }, // still live
    { id: "x1", inputId: "gone", tokens: 700, createdAt: iso(-3), expiresAt: null }, // its input was deleted
  ],
  debits: [{ creditId: "s2", tokens: 400 }, { creditId: "s3", tokens: 100 }, { creditId: null, tokens: 2000 }],
  allocations: [
    { id: "a1", userId: "u1", buildingId: "b1", label: "Old house budget", createdAt: iso(-4), auth: "api-key", retired: true, tokens: 3000, spentTokens: 1200 },
    { id: "a2", userId: "u1", buildingId: "b1", label: "Live", createdAt: iso(-1), auth: "subscription", retired: false, tokens: 500, spentTokens: 100 },
  ],
};

describe("financeSources (GET /api/finance/sources)", () => {
  it("lists each input with its dated credits, each donation, and ties to /api/finance", () => {
    const fin = financeSummary({ ...fixture, usage: [] }, at(0.5));
    const s = financeSources(fixture, fin.total, at(0.5));

    expect(s.inputs.map((r) => [r.id, r.label, r.tokens, r.expiredTokens])).toEqual([
      ["sub", "Subscription", 3000, 1600],
      ["key", "API key", 5000, 0],
      [null, DELETED_INPUT, 700, 0],
    ]);
    const sub = s.inputs[0]!;
    expect(sub).toMatchObject({ who: "Mitchell", source: "subscription", recurrence: "daily", firstAt: iso(-2), lastAt: iso(0), cancelledAt: iso(5) });
    expect(sub.credits.map((c) => [c.id, c.tokens, c.expiredTokens])).toEqual([["s1", 1000, 1000], ["s2", 1000, 600], ["s3", 1000, 0]]);

    // a retired allocation counts what it spent, a live one its size
    expect(s.donations.map((d) => [d.id, d.buildingName, d.sizeTokens, d.spentTokens, d.tokens])).toEqual([
      ["a1", "Workshop", 3000, 1200, 1200],
      ["a2", "Workshop", 500, 100, 500],
    ]);

    expect(s).toMatchObject({ creditedTokens: 8700, donatedTokens: 1700, totalReceived: 10400, sumCheck: { ok: true, diff: 0 } });
    expect(s.creditedTokens).toBe(fin.credited);
    expect(s.donatedTokens).toBe(fin.donated);
    expect(s.expiredTokens).toBe(fin.expired);
    expect(s).toMatchObject({ financeTotal: 10400, matchesFinance: true });
  });

  it("flags a total that doesn't match /api/finance, and has no deleted-input row when every credit has its input", () => {
    const s = financeSources({ ...fixture, credits: fixture.credits.filter((c) => c.inputId !== "gone") }, 1, T0);
    expect(s.inputs.some((r) => r.id === null)).toBe(false);
    expect(s).toMatchObject({ financeTotal: 1, matchesFinance: false, sumCheck: { ok: true } });
  });

  it("an input that never credited has no dates and 0 tokens", () => {
    const s = financeSources({ ...fixture, credits: [], debits: [] }, 0, T0);
    expect(s.inputs.find((r) => r.id === "key")).toMatchObject({ tokens: 0, firstAt: null, lastAt: null, credits: [] });
  });

  it("over a world: totalReceived equals Bank.finance().total", () => {
    const { world } = seededWorld();
    const u = world.ops.createUser("U").user;
    world.bank.addInput(u.id, { label: "Key", source: "api-key", model: "m", tokens: 1000, apiKey: "k" }, T0);
    const bid = world.buildings.all().find((x) => x.kind !== "town-hall")!.id;
    world.budget.donate(u.id, { tokens: 400, buildingId: bid, auth: "api-key" });
    const s = world.bank.sources(T0);
    expect(s.inputs.find((r) => r.label === "Key")).toMatchObject({ who: "U", tokens: 1000, credits: [{ tokens: 1000, expiresAt: null }] });
    expect(s.donations.some((d) => d.who === "U" && d.tokens === 400)).toBe(true);
    expect(s).toMatchObject({ totalReceived: world.bank.finance(T0).total, matchesFinance: true, sumCheck: { ok: true } });
  });
});
