import { describe, expect, it } from "vitest";
import { EXPECTED_SESSION_DEFAULT, percentile } from "../src/bank.ts";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const DAY = 86_400_000;

/** A lab with a child goal under its attachment, a key result there, the town's general key, and a member. */
function setup() {
  const s = seededWorld();
  const { world, admin } = s;
  const manager = world.agents.first("homeBuildingId = ? AND kind != 'human'", [LAB])!;
  const top = world.goalTree.attachmentOf(LAB);
  const child = world.goalTree.create(admin, { parentId: top, text: "Child goal" });
  const kr = world.goalTree.addKeyResult(admin, child.id, { text: "A thing", howToCheck: "Look", due: "2026-12-31" } as never);
  world.bank.addInput(admin.ownerUserId!, { label: "Town key", source: "api-key", model: "m", tokens: 1_000_000, apiKey: "sk-town" } as never);
  const user = world.ops.createUser("Donor").user;
  const avatar = world.ops.ensureAvatar(user.id);
  const earmark = (goalId: string, tokens: number, label = "Earmark") =>
    world.bank.addInput(user.id, { label, source: "api-key", model: "m", tokens, apiKey: `sk-${label}`, goalId } as never);
  return { ...s, manager, top, child, kr, user, avatar, earmark };
}

describe("funding streams (goal tree step 7)", () => {
  it("an earmark needs an api-key input and an active goal", () => {
    const { world, user, admin, child } = setup();
    expect(() => world.bank.addInput(user.id, { label: "x", source: "api-key", model: "m", tokens: 10, apiKey: "sk-x", goalId: "gl_nope" } as never)).toThrow(/No active goal/);
    expect(() => world.bank.addInput(admin.ownerUserId!, { label: "s", source: "subscription", model: "m", tokens: 10, recurrence: "daily", weeklyCapTokens: 70, token: "sk-ant-oat01-" + "a".repeat(80), goalId: child.id } as never)).toThrow(/Only an API-key input/);
  });

  it("the general balance never draws on an earmark, nor runs on its key", () => {
    const { world, manager, child, earmark } = setup();
    const before = world.bank.balance();
    const e = earmark(child.id, 500_000);
    expect(world.bank.balance()).toBe(before);
    expect(world.bank.liveApiKeyInput()!.label).toBe("Town key");
    world.budget.charge(manager.id, 10_000, 0);
    expect(world.bank.inputBalance(e.id)).toBe(500_000);
    expect(world.bank.balance()).toBe(before - 10_000);
  });

  it("picks the nearest earmark above the work's goal that covers a session, then charges it first", () => {
    const { world, manager, top, child, kr, earmark } = setup();
    const high = earmark(top, 400_000, "High");
    const near = earmark(child.id, 300_000, "Near");
    const asg = { buildingId: LAB, grantId: null, keyResultId: kr.id };
    expect(world.streams.nodeOf(asg, LAB)).toBe(child.id);
    expect(world.streams.pick(asg, LAB)!.id).toBe(near.id);
    // work on the building's attachment (no key result) only sees the higher earmark
    expect(world.streams.pick({ buildingId: LAB, grantId: null, keyResultId: null }, LAB)!.id).toBe(high.id);
    const f = world.budget.fundingFor(LAB, { stream: near });
    expect(f).toMatchObject({ auth: "api-key", inputId: near.id, credential: { secret: "sk-Near" } });
    const general = world.bank.balance();
    world.budget.charge(manager.id, 50_000, 0, undefined, { inputId: near.id });
    expect(world.bank.inputBalance(near.id)).toBe(250_000);
    expect(world.bank.balance()).toBe(general);
    expect(world.events.list({ types: ["bank.debited"] }).at(-1)!.payload).toMatchObject({ inputId: near.id, goalId: child.id, grantId: null });
    // an earmark that runs dry leaves the rest to the general balance; nothing is held
    world.budget.charge(manager.id, 260_000, 0, undefined, { inputId: near.id });
    expect(world.bank.inputBalance(near.id)).toBe(0);
    expect(world.bank.balance()).toBe(general - 10_000);
    expect(world.streams.pick(asg, LAB)!.id).toBe(high.id);
  });

  it("an earmark below one expected session is never picked: it accrues", () => {
    const { world, child, kr, earmark } = setup();
    earmark(child.id, EXPECTED_SESSION_DEFAULT - 1, "Small");
    expect(world.streams.pick({ buildingId: LAB, grantId: null, keyResultId: kr.id }, LAB)).toBeNull();
    const row = world.streams.list().streams.find((x) => x.label === "Small")!;
    expect(row).toMatchObject({ coversSession: false, goalId: child.id, balance: EXPECTED_SESSION_DEFAULT - 1 });
    expect(row.goalPath).toMatch(/Child goal$/);
  });

  it("the expected session is the p90 of the last 7 days' work sessions, a default under 5", () => {
    const { world, manager } = setup();
    expect(world.bank.expectedSession(LAB)).toEqual({ tokens: EXPECTED_SESSION_DEFAULT, sample: 0 });
    const now = new Date();
    for (const out of [10_000, 20_000, 30_000, 40_000, 50_000, 60_000]) {
      const s = world.ops.startSession(manager.id, { purpose: "work", model: "claude-opus-5-5" });
      world.sessions.patch(s.id, { output: out, status: "done", endedAt: new Date(now.getTime() - 1000).toISOString() });
    }
    expect(world.bank.expectedSession(LAB, now)).toEqual({ tokens: 60_000, sample: 6 });
    expect(world.streams.list(now).expectedSessionTokens).toBe(60_000);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
  });

  it("an earmark with no draw for 7 days tells its donor once, in town", () => {
    const { world, child, avatar, earmark } = setup();
    const e = earmark(child.id, 10_000, "Idle");
    const later = new Date(Date.parse(e.createdAt) + 8 * DAY);
    expect(world.streams.tick(new Date(Date.parse(e.createdAt) + 6 * DAY))).toBe(0);
    expect(world.streams.tick(later)).toBe(1);
    const msg = world.messages.where("toId = ?", [avatar.id]).at(-1)!;
    expect(msg.body).toMatch(/No session has run on your Bank stream "Idle".*below one session/);
    expect(world.streams.tick(new Date(later.getTime() + DAY))).toBe(0);
    expect(world.streams.list(later).streams.find((x) => x.inputId === e.id)!.idle).toBe("below-one-session");
  });
});
