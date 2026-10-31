import { describe, it, expect } from "vitest";
import { NO_KEY_HOLD, NO_TOKEN_HOLD, World } from "@muster-town/core";
import { fundingFor } from "../src/session.ts";
import { credentialEnv } from "../src/sdk.ts";

const open = () => {
  const world = World.open(":memory:");
  const seed = world.seedDefaults({ adminName: "T", importDir: new URL("../../../buildings/carbon-cycle", import.meta.url).pathname });
  const bid = seed.lab!.id;
  // retire any seeded allocations so the Bank is the only money
  for (const a of world.allocations.where("buildingId = ?", [bid])) world.budget.retire(a.id);
  const noor = world.agents.first("name = ?", ["Noor"])!;
  return { world, seed, bid, noor };
};

describe("fundingFor with Bank-only money (the Bank is the only place a credential lives)", () => {
  it("a subscription-funded building runs on the subscription input's token: one credential, no fallback key beside it", () => {
    const { world, seed, noor } = open();
    world.bank.addInput(seed.admin.id, { label: "sub", source: "subscription", model: "m", tokens: 1_000_000, recurrence: "daily", weeklyCapTokens: 7_000_000, token: "sk-ant-oat01-test-token" });
    world.bank.addInput(seed.admin.id, { label: "buffer", source: "api-key", model: "m", tokens: 500_000, recurrence: "once", apiKey: "sk-ant-api03-fallback" });
    const f = fundingFor(world, noor.id);
    expect(f.auth).toBe("subscription");
    expect(f.credential).toMatchObject({ kind: "subscription", secret: "sk-ant-oat01-test-token" });
    expect(Object.keys(f)).toEqual(["allocationId", "auth", "credential"]);
    expect(Object.keys(credentialEnv(f.credential))).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
    world.close();
  });

  it("failover is the next session's pick: after a cap death the Bank hands out the api-key input's key (booked as api-key) until the cap resets; never two in one session (1:1 mt_x40qq8poc3)", () => {
    const { world, seed, bid, noor } = open();
    world.bank.addInput(seed.admin.id, { label: "sub", source: "subscription", model: "m", tokens: 1_000_000, recurrence: "daily", weeklyCapTokens: 7_000_000, token: "sk-ant-oat01-test-token" });
    const buffer = world.bank.addInput(seed.admin.id, { label: "buffer", source: "api-key", model: "m", tokens: 500_000, recurrence: "once", apiKey: "sk-ant-api03-fallback" });
    const now = new Date();
    const s = world.ops.startSession(noor.id, { purpose: "work", model: "m", funding: "subscription" });
    world.ops.endSession(s.id, { status: "error", error: "You've hit your org's monthly spend limit · your session limit resets 8:50pm (UTC)", spendLimit: "You've hit your org's monthly spend limit" });
    expect(world.bank.capState(now).cappedAt).toBeTruthy();
    const f = world.budget.fundingFor(bid, { now });
    expect(f).toEqual({ allocationId: null, auth: "api-key", credential: { kind: "api-key", secret: "sk-ant-api03-fallback", inputId: buffer.id } });
    expect(Object.keys(credentialEnv(f.credential))).toEqual(["ANTHROPIC_API_KEY"]);
    // once the reset in the SDK's message has passed: back on the subscription
    const later = new Date(Date.parse(world.bank.capState(now).resetsAt) + 60_000);
    expect(world.bank.capState(later).cappedAt).toBeNull();
    expect(world.budget.fundingFor(bid, { now: later }).auth).toBe("subscription");
    // capped with nothing to fail over to: still the subscription (the cap hold holds new starts)
    world.bank.cancelInput(seed.admin.id, buffer.id);
    expect(world.budget.fundingFor(bid, { now }).auth).toBe("subscription");
    world.close();
  });

  it("nothing in the Bank: held with NO_KEY_HOLD; a subscription input without its token: NO_TOKEN_HOLD (never the host env)", () => {
    const { world, seed, bid, noor } = open();
    expect(() => fundingFor(world, noor.id)).toThrow(NO_KEY_HOLD);
    expect(world.budget.credentialHold(bid)).toBe(NO_KEY_HOLD);
    expect(() => world.bank.addInput(seed.admin.id, { label: "sub", source: "subscription", model: "m", tokens: 1_000_000, recurrence: "daily", weeklyCapTokens: 7_000_000 })).toThrow(/needs its token/);
    expect(() => world.bank.addInput(seed.admin.id, { label: "sub", source: "subscription", model: "m", tokens: 1_000_000, recurrence: "daily", weeklyCapTokens: 7_000_000, token: "sk-ant-api03-nope" })).toThrow(/API key/);
    const inp = world.bank.addInput(seed.admin.id, { label: "sub", source: "subscription", model: "m", tokens: 1_000_000, recurrence: "daily", weeklyCapTokens: 7_000_000, token: "sk-ant-oat01-test-token" });
    expect(fundingFor(world, noor.id).credential.inputId).toBe(inp.id);
    // cancelling forgets the token: the credits it made still exist, so the subscription would pay, but nothing can run
    world.bank.cancelInput(seed.admin.id, inp.id);
    expect(world.budget.credentialHold(bid)).toBe(NO_KEY_HOLD);
    world.close();
  });

  it("an api-key input needs an Anthropic key, not a subscription token", () => {
    const { world, seed } = open();
    expect(() => world.bank.addInput(seed.admin.id, { label: "k", source: "api-key", model: "m", tokens: 1, apiKey: "sk-ant-oat01-nope" })).toThrow(/subscription token/);
    expect(() => world.bank.addInput(seed.admin.id, { label: "k", source: "api-key", model: "m", tokens: 1, apiKey: "sk-ant-api03-ok", token: "sk-ant-oat01-x" })).toThrow(/doesn't take/);
    world.close();
  });
});
