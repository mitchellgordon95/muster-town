import { describe, expect, it } from "vitest";
import { buildingRoleId, townKpis } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";

/** A proposed grant in the lab, a member with no roles, and the member's own one-time API-key input (credited at once). */
function setup(memberTokens = 50_000) {
  const s = seededWorld();
  const { world, admin } = s;
  const manager = world.agents.first("homeBuildingId = ? AND kind != 'human'", [LAB])!;
  world.permissions.grant(manager, buildingRoleId(LAB, "manager"));
  const kr = world.grantDesk.createKeyResult(admin, LAB, { text: "A visitor can read the banner", howToCheck: "Open the lab" });
  const g = world.grantDesk.create(manager, LAB, { keyResultId: kr.id, objective: "Banner", approach: "a line", stopCondition: "two tries", askTokens: 20_000, testingPlan: [] });
  world.grantDesk.propose(manager, g.id);
  const user = world.ops.createUser("Member").user;
  const member = world.ops.ensureAvatar(user.id);
  const input = world.bank.addInput(user.id, { label: "Member key", source: "api-key", model: "m", tokens: memberTokens, apiKey: "sk-member" } as never);
  // the town's own input keeps the pool funded
  world.bank.addInput(admin.ownerUserId!, { label: "Town key", source: "api-key", model: "m", tokens: 1_000_000, apiKey: "sk-town" } as never);
  return { ...s, manager, kr, g, user, member, input };
}

describe("member funding (fundWith)", () => {
  it("a member without building.fund can't fund from the pool, nor with someone else's input", () => {
    const { world, g, member, admin } = setup();
    expect(() => world.grantDesk.decide(member, g.id, { action: "fund" })).toThrow(/building.fund/);
    const other = world.bank.summary().inputs.find((i) => i.userId === admin.ownerUserId)!;
    expect(() => world.grantDesk.decide(member, g.id, { action: "fund", fundWith: other.id })).toThrow(/not your Bank input/);
    expect(() => world.grantDesk.decide(member, g.id, { action: "reject", fundWith: other.id })).toThrow(/fund" only/);
    expect(world.grantDesk.get(g.id).status).toBe("proposed");
  });

  it("an input that can't pay the grant's tokens is refused", () => {
    const { world, g, member, input } = setup(5_000);
    expect(() => world.grantDesk.decide(member, g.id, { action: "fund", fundWith: input.id })).toThrow(/can pay 5,000 more tokens; this grant needs 20,000/);
    expect(world.grantDesk.decide(member, g.id, { action: "fund", fundWith: input.id, tokens: 5_000 }).status).toBe("funded");
  });

  it("funds with the member's own input: fundedBy, fundedWith, names, the event, and the Fund KPI", () => {
    const { world, g, member, user, input } = setup();
    const f = world.grantDesk.decide(member, g.id, { action: "fund", fundWith: input.id });
    expect(f).toMatchObject({ status: "funded", grantTokens: 20_000, fundedBy: user.id, fundedWith: input.id, fundedByName: "Member", fundedWithLabel: "Member key" });
    expect(world.events.list({ types: ["grant.funded"] }).at(-1)!.text).toMatch(/funded from Member key/);
    const fund = townKpis(world).kpis.find((k) => k.key === "fund")!;
    expect(fund.thisWeek).toBeGreaterThanOrEqual(1);
    expect(fund.detail).toMatch(/1 grant funded \(20,000 adjusted tokens\)/);
  });

  it("an admin still funds from the pool (fundedWith null) and may also fund with an input", () => {
    const { world, g, admin } = setup();
    expect(world.grantDesk.decide(admin, g.id, { action: "fund" })).toMatchObject({ fundedWith: null, fundedBy: admin.ownerUserId });
  });

  it("a session on the grant is paid from the input first, then the pool; each debit names the input", () => {
    const { world, g, member, manager, input } = setup(20_000);
    world.grantDesk.decide(member, g.id, { action: "fund", fundWith: input.id });
    const before = world.bank.balance();
    world.budget.charge(manager.id, 15_000, 0, undefined, { grantId: g.id });
    let row = world.bank.summary().inputs.find((i) => i.id === input.id)!;
    expect(row).toMatchObject({ debitedTokens: 15_000, balanceTokens: 5_000 });
    expect(world.bank.balance()).toBe(before - 15_000);
    const ev = world.events.list({ types: ["bank.debited"] });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ inputId: input.id, grantId: g.id, tokens: 15_000, leftForPool: 0 });
    expect(ev[0]!.text).toMatch(/Member key paid 15,000 adj. tokens/);
    // the input runs dry: 5,000 from it, the other 7,000 from the building's pool (not named)
    world.budget.charge(manager.id, 12_000, 0, undefined, { grantId: g.id });
    row = world.bank.summary().inputs.find((i) => i.id === input.id)!;
    expect(row).toMatchObject({ debitedTokens: 20_000, balanceTokens: 0 });
    const debits = world.db.prepare("SELECT inputId, grantId, tokens FROM bank_debits ORDER BY rowid").all() as { inputId: string | null; grantId: string | null; tokens: number }[];
    expect(debits.slice(-2)).toEqual([{ inputId: input.id, grantId: g.id, tokens: 5_000 }, { inputId: null, grantId: null, tokens: 7_000 }]);
    expect(world.bank.balance()).toBe(before - 27_000);
    // a session not on the grant never touches the input
    world.budget.charge(manager.id, 1_000, 0);
    expect(world.events.list({ types: ["bank.debited"] })).toHaveLength(2);
  });

  it("what an input already owes another live grant counts against it", () => {
    const { world, g, member, manager, kr, input } = setup(30_000);
    world.grantDesk.decide(member, g.id, { action: "fund", fundWith: input.id });
    const g2 = world.grantDesk.create(manager, LAB, { keyResultId: kr.id, objective: "Banner 2", approach: "a line", stopCondition: "two tries", askTokens: 20_000, testingPlan: [] });
    world.grantDesk.propose(manager, g2.id);
    expect(() => world.grantDesk.decide(member, g2.id, { action: "fund", fundWith: input.id })).toThrow(/can pay 10,000 more tokens \(after 20,000 it owes other grants\)/);
  });
});
