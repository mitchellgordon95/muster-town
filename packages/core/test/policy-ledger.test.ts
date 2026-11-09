/**
 * The policy ledger (docs/legible-delegation.md §6, build step 5): a Town Hall doc of type `policy`, one rule per line
 * with its origin, pinned in managers' prompts (`policyLedgerBlock`). After a human decides a policy ask, or act_in_1on1
 * does a decision a human said, the Secretary files "Add this rule to the ledger?"; only a human's "Add" appends it.
 */
import { describe, expect, it } from "vitest";
import { buildingRoleId, createOneOnOne } from "../src/index.ts";
import { createAsk, decideAsk } from "../src/asks.ts";
import { policyLedgerBlock } from "../src/secretary.ts";
import { managerStateBlock } from "../src/prompts.ts";
import { ensureDictionary } from "../src/dictionary.ts";
import { creditBank, seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";

function setup() {
  const s = seededWorld();
  const { world } = s;
  creditBank(world, 10_000_000);
  const manager = world.agents.first("homeBuildingId = ? AND kind != 'human'", [LAB])!;
  world.permissions.grant(manager, buildingRoleId(LAB, "manager"));
  const sec = world.secretary.ensure()!;
  const ledger = world.secretary.ensurePolicyLedger()!;
  const ledgerAsks = () => world.asks.where("type = 'policy' AND targetKind = 'rule' AND status = 'open'");
  return { ...s, world, manager, sec, ledger, ledgerAsks };
}

describe("the policy ledger", () => {
  it("a policy decision files the ask to add its rule to the ledger; Add appends the line, Skip doesn't; the ledger block is in the pinned text", () => {
    const { world, admin, manager, ledger, ledgerAsks } = setup();
    expect(ledger).toMatchObject({ type: "policy", buildingId: "town-hall", title: "Policy ledger" });
    expect(world.secretary.ensurePolicyLedger()!.id).toBe(ledger.id);
    expect(policyLedgerBlock(world)).toBe("");
    const { ask: p } = createAsk(world, { type: "policy", buildingId: LAB, sourceDocId: null, by: manager.id, title: "Forks never push to main without CI", branches: [{ label: "Keep the rule" }, { label: "Change it" }] });
    // a manager can't decide it, a human can; deciding it proposes the rule (nothing is appended yet)
    expect(() => decideAsk(world, manager, p.id, "Keep the rule")).toThrow(/Only a human/);
    decideAsk(world, admin, p.id, "Keep the rule");
    const [add] = ledgerAsks();
    expect(add).toMatchObject({ type: "policy", targetId: `ledger:${p.id}`, branches: [{ label: "Add", action: "ledger-add" }, { label: "Skip", action: "ledger-skip" }] });
    expect(add!.title).toBe("Add this rule to the ledger? Forks never push to main without CI: Keep the rule");
    expect(add!.body).toMatch(new RegExp(`^- Forks never push to main without CI: Keep the rule \\(origin: ${p.id}, \\d{4}-\\d\\d-\\d\\d\\)$`));
    expect(world.docs.require(ledger.id).body).not.toContain("Forks never push");
    // deciding "Add this rule?" never files another one; Add appends its line
    decideAsk(world, admin, add!.id, "Add");
    expect(ledgerAsks()).toHaveLength(0);
    expect(world.docs.require(ledger.id).body.trimEnd().split("\n").at(-1)).toBe(add!.body);
    expect(world.events.list({ types: ["policy.added"] })).toHaveLength(1);
    expect(policyLedgerBlock(world)).toBe(`## Policy ledger (rules the humans set; follow them and don't ask what a rule already answers)\n${add!.body}`);
    // a second policy decision, skipped: nothing appended
    const { ask: q } = createAsk(world, { type: "policy", buildingId: LAB, sourceDocId: null, title: "Explorers stop at one proposal", branches: [{ label: "Keep the rule" }] });
    decideAsk(world, admin, q.id, "Keep the rule");
    decideAsk(world, admin, ledgerAsks()[0]!.id, "Skip");
    expect(policyLedgerBlock(world).split("\n")).toHaveLength(2);
    // "Add: <words>" appends the human's wording with the same origin
    const { ask: r } = createAsk(world, { type: "policy", buildingId: LAB, sourceDocId: null, title: "Visitors see the Bank", branches: [{ label: "Yes" }] });
    decideAsk(world, admin, r.id, "Yes");
    decideAsk(world, admin, ledgerAsks()[0]!.id, "Add: visitors see the Bank before they sign in");
    expect(policyLedgerBlock(world)).toMatch(new RegExp(`\\n- visitors see the Bank before they sign in \\(origin: ${r.id}, `));
    // pinned in every manager's team-lead session (the first message, managerStateBlock)
    expect(managerStateBlock(world, manager, world.buildings.require(LAB))).toContain(policyLedgerBlock(world));
  });

  it("after act_in_1on1 does a decision the human said, the Secretary proposes their words as a rule; it never appends on its own", async () => {
    const { world, admin, manager, sec, ledger, ledgerAsks } = setup();
    const g = world.grantDesk.propose(manager, world.grantDesk.create(manager, LAB, {
      keyResults: [{ text: "k", howToCheck: "h" }], objective: "A banner", approach: "a line", steps: [{ size: "M", title: "Step 1", description: "Do it" }], stopCondition: "s", askTokens: 300_000,
    }).id);
    const th = world.buildings.first("kind = 'town-hall'")!;
    const m = createOneOnOne(world, admin, th.id, { agentId: sec.id });
    const at = new Date().toISOString();
    world.meetings.patch(m.id, { phase: "discussing", transcript: [...m.transcript, { speakerId: world.holderOf(admin).id, speakerKind: "user", text: "fund it, small UI grants are always fine", at } as never] });
    await world.verbs.act_in_1on1(sec, { meetingId: m.id, utteranceAt: at, action: "fund", targetId: g.id, tokens: 300_000 });
    const [add] = ledgerAsks();
    expect(add).toMatchObject({ targetId: `ledger:${m.id}` });
    expect(add!.body).toMatch(new RegExp(`^- .* in a 1:1: "fund it, small UI grants are always fine" \\(fund ${g.id}.*\\) \\(origin: ${m.id}, `));
    expect(world.docs.require(ledger.id).body).not.toContain("small UI grants");
  });

  it("no agent writes or rewrites the ledger or the dictionary, not even its author; the human Add still appends", async () => {
    const { world, admin, manager, sec, ledger, ledgerAsks } = setup();
    expect(ledger.authorId).toBe(sec.id);
    const dict = ensureDictionary(world)!;
    for (const type of ["policy", "dictionary"] as const) {
      await expect(world.verbs.write(sec, { type, title: "x", body: "- anything goes", state: "building" })).rejects.toThrow(/humans only/);
    }
    // its author can't update it in place (as any type), and nor can a manager
    await expect(world.verbs.write(sec, { id: ledger.id, type: "fyi", title: "Policy ledger", body: "- anything goes" })).rejects.toThrow(/humans only/);
    await expect(world.verbs.write(manager, { id: dict.id, type: "fyi", title: "Town dictionary", body: "x" })).rejects.toThrow(/humans only/);
    expect(world.docs.require(ledger.id).body).not.toContain("anything goes");
    const { ask: p } = createAsk(world, { type: "policy", buildingId: LAB, sourceDocId: null, title: "Forks never push to main", branches: [{ label: "Keep" }] });
    decideAsk(world, admin, p.id, "Keep");
    decideAsk(world, admin, ledgerAsks()[0]!.id, "Add");
    expect(world.docs.require(ledger.id).body).toContain("Forks never push to main: Keep");
  });
});
