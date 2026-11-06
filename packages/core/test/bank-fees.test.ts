import { describe, expect, it } from "vitest";
import { seededWorld } from "./helpers.ts";

// gr_qggxximtru step 1 (kr_au6pcldl3c): plans paid for, what the town pays in cash for a subscription plan
describe("bank fees (plans paid for)", () => {
  it("an admin records a plan, anyone reads it, and an admin ends it", () => {
    const { world, seed } = seededWorld();
    expect(world.bank.fees()).toEqual([]);
    const fee = world.bank.addFee(seed.admin.id, { label: "Max 20x", usdPerMonth: 200, from: "2026-10-20" });
    expect(fee).toMatchObject({ label: "Max 20x", usdPerMonth: 200, fromDate: "2026-10-20", toDate: null, paidBy: seed.admin.id });
    world.bank.addFee(seed.admin.id, { label: "Max 5x", usdPerMonth: 100, from: "2026-09-01", to: "2026-10-19" });
    expect(world.bank.fees().map((f) => f.label)).toEqual(["Max 20x", "Max 5x"]); // newest first
    expect(world.bank.endFee(seed.admin.id, fee.id, "2026-11-30")).toMatchObject({ toDate: "2026-11-30" });
    expect(world.events.list({ types: ["bank.fee"] })).toHaveLength(3);
  });

  it("only an admin writes; label, amount and dates are checked", () => {
    const { world, seed } = seededWorld();
    const other = world.ops.createUser("Other").user;
    expect(() => world.bank.addFee(other.id, { label: "Max", usdPerMonth: 100, from: "2026-10-01" })).toThrow(/admin/);
    const ok = world.bank.addFee(seed.admin.id, { label: "Max", usdPerMonth: 100, from: "2026-10-01" });
    expect(() => world.bank.endFee(other.id, ok.id, "2026-10-31")).toThrow(/admin/);
    const bad = [
      { label: "", usdPerMonth: 100, from: "2026-10-01" },
      { label: "x".repeat(81), usdPerMonth: 100, from: "2026-10-01" },
      { label: "Max", usdPerMonth: 0, from: "2026-10-01" },
      { label: "Max", usdPerMonth: -5, from: "2026-10-01" },
      { label: "Max", usdPerMonth: 100, from: "2026-02-30" },
      { label: "Max", usdPerMonth: 100, from: "Oct 1" },
    ];
    for (const b of bad) expect(() => world.bank.addFee(seed.admin.id, b)).toThrow();
    expect(() => world.bank.addFee(seed.admin.id, { label: "Max", usdPerMonth: 100, from: "2026-10-02", to: "2026-10-01" })).toThrow(/before it starts/);
    expect(() => world.bank.endFee(seed.admin.id, ok.id, "2026-09-30")).toThrow(/before it starts/);
    expect(world.bank.fees()).toHaveLength(1);
  });

  it("a hosted collective has no plans", () => {
    const { world, seed } = seededWorld();
    world.host.hosted = true;
    expect(() => world.bank.addFee(seed.admin.id, { label: "Max", usdPerMonth: 100, from: "2026-10-01" })).toThrow(/API key only/);
    expect(world.bank.seedFees(seed.admin.id, [{ label: "Max", usdPerMonth: 100, from: "2026-10-01" }])).toEqual([]);
    expect(world.bank.fees()).toEqual([]);
  });

  // collective.json `plans` (1:1 mt_pr3347g2w2): the Workshop's own plan is seeded on boot, once
  it("seedFees records each collective.json plan once, keyed on its label and first day", () => {
    const { world, seed } = seededWorld();
    const plan = { label: 'Claude Max 20x (now "Ultra")', usdPerMonth: 200, from: "2026-10-25" };
    const added = world.bank.seedFees(seed.admin.id, [plan]);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ label: plan.label, usdPerMonth: 200, fromDate: "2026-10-25", toDate: null, paidBy: seed.admin.id });
    expect(world.bank.seedFees(seed.admin.id, [plan])).toEqual([]); // the next boot: already there
    world.bank.addFee(seed.admin.id, { label: "Max 5x", usdPerMonth: 100, from: "2026-09-01", to: "2026-10-24" });
    expect(world.bank.seedFees(seed.admin.id, [plan, { label: "Max 5x", usdPerMonth: 100, from: "2026-09-01" }])).toEqual([]); // a hand-recorded one counts
    expect(world.bank.fees()).toHaveLength(2);
    expect(world.events.list({ types: ["bank.fee"] }).filter((e) => (e.payload as { seeded?: boolean }).seeded)).toHaveLength(1);
  });
});
