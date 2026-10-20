import { describe, it, expect } from "vitest";
import { World } from "@muster-town/core";
import { fundingFor } from "../src/session.ts";

describe("fundingFor with Bank-only money", () => {
  it("a subscription-funded building still gets a fallback key from the Bank's API-key input", () => {
    const world = World.open(":memory:");
    const seed = world.seedDefaults({ adminName: "T", importDir: new URL("../../../buildings/carbon-cycle", import.meta.url).pathname });
    const bid = seed.lab!.id;
    // retire any seeded allocations so the Bank is the only money
    for (const a of world.allocations.where("buildingId = ?", [bid])) world.budget.retire(a.id);
    world.bank.addInput(seed.admin.id, { label: "sub", source: "subscription", model: "m", tokens: 1_000_000, recurrence: "daily", weeklyCapTokens: 7_000_000 });
    world.bank.addInput(seed.admin.id, { label: "buffer", source: "api-key", model: "m", tokens: 500_000, recurrence: "once", apiKey: "sk-ant-test-fallback" });
    const noor = world.agents.first("name = ?", ["Noor"])!;
    const f = fundingFor(world, noor.id, { ANTHROPIC_API_KEY: "" } as any);
    expect(f.auth).toBe("subscription");
    expect(f.fallback?.apiKey).toBe("sk-ant-test-fallback");
    expect(f.fallback?.allocationId).toBeNull();
    world.close();
  });
});
