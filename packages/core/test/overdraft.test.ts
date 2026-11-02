import { describe, expect, it } from "vitest";
import { blockedBy, buildingRoleId, createAssignment, freeTokens } from "../src/index.ts";
import { laneHold } from "../src/lanes.ts";
import { seededWorld } from "./helpers.ts";

// Promised and available, and the overdraft walk (docs/bank.md, Mitchell 2026-11-01).
const LAB = "carbon-cycle";
const OPUS = "claude-opus-5-5";

/** Two API keys (6,000 and 4,000) and two funded grants: G1 (5,000, funded first) and G2 (4,000), each with grant work queued. */
function setup() {
  const s = seededWorld();
  const { world, admin } = s;
  const k1 = world.bank.addInput(admin.ownerUserId!, { label: "Old key", source: "api-key", model: OPUS, tokens: 6_000, apiKey: "sk-ant-api03-old" });
  const k2 = world.bank.addInput(admin.ownerUserId!, { label: "New key", source: "api-key", model: OPUS, tokens: 4_000, apiKey: "sk-ant-api03-new" });
  const manager = world.agents.first("homeBuildingId = ? AND kind != 'human'", [LAB])!;
  world.permissions.grant(manager, buildingRoleId(LAB, "manager"));
  const fund = (askTokens: number) => {
    const g = world.grantDesk.propose(manager, world.grantDesk.create(manager, LAB, { keyResults: [{ text: "k", howToCheck: "h" }], objective: `ask ${askTokens}`, stopCondition: "s", askTokens }).id);
    const funded = world.grantDesk.decide(admin, g.id, { action: "fund" });
    const work = createAssignment(world, { agentId: manager.id, title: `work on ${funded.id}`, description: "d", createdBy: { kind: "system", id: "system" }, lane: { lane: "grant", grantId: funded.id } });
    return { grant: funded, work };
  };
  const g1 = fund(5_000);
  const g2 = fund(4_000);
  const root = () => freeTokens(world, "gl_town");
  return { ...s, k1, k2, g1, g2, root, manager };
}

describe("promised and available: the usable balance", () => {
  it("a broken key's credit leaves the usable balance; a Fable-only limit doesn't; a reset before the credit's expiry doesn't", () => {
    const { world, k1, k2, root } = setup();
    expect(world.bank.usableBalance()).toBe(10_000);
    expect(root()).not.toHaveProperty("unavailableTokens");
    world.bank.availability.recordFailure({ inputId: k1.id, model: OPUS, text: "Switch to another model to continue.", }, new Date());
    expect(world.bank.usableBalance()).toBe(10_000); // one model limited: the others can still spend it
    world.bank.availability.recordFailure({ inputId: k2.id, model: OPUS, text: "Your credit balance is too low to access the Anthropic API." });
    expect(world.bank.usableBalance()).toBe(6_000);
    expect(world.bank.balance()).toBe(10_000);
    expect(root()).toMatchObject({ generalTokens: 6_000, promisedTokens: 10_000, unavailableTokens: 4_000, unavailable: [{ inputId: k2.id, tokens: 4_000, text: expect.stringMatching(/^New key: out of credit/) }] });
  });

  it("a subscription credit counts only if its input can serve before the credit expires", () => {
    const { world, seed } = seededWorld();
    const now = new Date("2026-11-01T18:00:00.000Z");
    world.bank.cancelInput(seed.admin.id, world.bank.subscriptionInput()!.id, now);
    const sub = world.bank.addInput(seed.admin.id, { label: "Max plan", source: "subscription", token: "sk-ant-oat01-test-token", model: OPUS, tokens: 2_000_000, recurrence: "daily", weeklyCapTokens: 20_000_000 }, now);
    // the credit expires at the next daily renewal (tomorrow 18:00): a window resetting tonight leaves it usable
    world.bank.availability.limit({ inputId: sub.id, scope: "*", kind: "window", until: "2026-11-01T23:00:00.000Z", reason: "5-hour limit" }, now);
    expect(world.bank.usableBalance(now)).toBe(2_000_000);
    // a weekly window resetting after the credit expires: today's quota is behind a reset that comes too late
    world.bank.availability.limit({ inputId: sub.id, scope: "*", kind: "window", until: "2026-11-05T00:00:00.000Z", reason: "weekly limit" }, now);
    expect(world.bank.usableBalance(now)).toBe(0);
  });
});

describe("the overdraft walk", () => {
  it("covers claims in order; past the line, funded work waits and the overdraft is shown; a grant straddling the line runs", () => {
    const { world, k1, k2, g1, g2, root } = setup();
    expect(root()).toMatchObject({ fundedRemainingTokens: 9_000, freeTokens: 1_000 });
    expect(root()).not.toHaveProperty("overdraftTokens");
    expect(laneHold(world, g2.work)).toBeNull();

    // the newer key breaks: 6,000 usable covers G1 (5,000) and 1,000 of G2, which straddles the line and runs
    world.bank.availability.recordFailure({ inputId: k2.id, model: OPUS, text: "Your credit balance is too low" });
    expect(root()).toMatchObject({ freeTokens: 0, overdraftTokens: 3_000, overdrafted: [{ kind: "funded", id: g2.grant.id, tokens: 4_000, shortTokens: 3_000 }] });
    expect(laneHold(world, g1.work)).toBeNull();
    expect(laneHold(world, g2.work)).toBeNull();

    // both keys broken: nothing usable; both grants wait, at the Bank, with the shortfall
    world.bank.availability.recordFailure({ inputId: k1.id, model: OPUS, text: "authentication_error: invalid x-api-key" });
    expect(root()).toMatchObject({ overdraftTokens: 9_000 });
    expect(laneHold(world, g1.work)).toMatch(/^held: overdrafted, .* \(5,000 tokens short\)$/);
    expect(blockedBy(world, world.assignments.require(g2.work.id))).toMatchObject({ kind: "budget", placeId: "bank", text: expect.stringMatching(/^overdrafted/) });

    // the newer key is fixed ("Try now", then a success): the walk covers G1 first (funded earlier), G2 waits
    const lim = world.bank.availability.open(k2.id)[0]!;
    world.bank.availability.clear(lim);
    expect(root()).toMatchObject({ overdraftTokens: 5_000 });
    expect(laneHold(world, g1.work)).toBeNull();
    expect(laneHold(world, g2.work)).toMatch(/^held: overdrafted/);
  });

  it("an open proposal's ask soaks up a shortfall first and is never listed as overdrafted", () => {
    const { world, k2, root, manager } = setup();
    world.grantDesk.propose(manager, world.grantDesk.create(manager, LAB, { keyResults: [{ text: "k", howToCheck: "h" }], objective: "a proposal", stopCondition: "s", askTokens: 900 }).id);
    world.bank.availability.recordFailure({ inputId: k2.id, model: OPUS, text: "Your credit balance is too low" });
    expect(root().overdrafted?.map((o) => o.kind)).toEqual(["funded"]);
    expect(root().overdraftTokens).toBe(3_000);
  });
});
