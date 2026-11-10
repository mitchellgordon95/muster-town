/**
 * The ask card's contract per type and its enforcement (docs/legible-delegation.md §4-5, build step 3): what each type
 * must carry, and since 1:1 mt_ewxnhs90cq decision 5 (2026-11-10): missing structure is refused on submit_report's typed
 * asks, propose_grant and calibrate; style rules never refuse, they are filed as warnings in the ask's history.
 */
import { askStructure, askWarnings, checkAskContract } from "@muster-town/schema";
import { describe, expect, it } from "vitest";
import { buildingRoleId, townHallIntray } from "../src/index.ts";
import { asksFor } from "../src/asks.ts";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const names = (problems: string[]) => problems.map((p) => p.split(":")[0]!.replace("contract ", ""));
const MONEY = `You funded this at 600k on Oct 31. It has spent 474k. Three of four steps shipped.
If you continue: 150k, then the grant closes.
If you cut: the PR merges under exploration.`;
const two = [{ label: "Continue" }, { label: "Cut" }];
const claim = [{ text: "PR #392 is green and mergeable", check: { kind: "pr" } }];

describe("the ask contract per type (docs/legible-delegation.md §4)", () => {
  it("each type names the fields its card is missing, read from the fields or from labelled lines and sentences in the body", () => {
    // money: prior decision, spent, steps, two branches, a recommendation, 1-2 claims
    expect(checkAskContract("money", { body: MONEY, branches: two, recommendation: "Continue", claims: claim })).toEqual([]);
    expect(names(checkAskContract("money", { body: "It ships the deck." }))).toEqual(["prior-decision", "spent", "steps", "branches", "recommendation", "claims"]);
    expect(checkAskContract("money", { body: "Prior decision: none yet.\nSpent: nothing.\nSteps: two, none done.", branches: two, recommendation: "Fund", claims: claim })).toEqual([]);
    expect(names(checkAskContract("money", { body: MONEY, branches: two, recommendation: "Continue", claims: [...claim, ...claim, ...claim] }))).toEqual(["claims"]);
    // a retainer has runs, not steps
    expect(checkAskContract("money", { body: "You approved it last week. It has spent 9k.", branches: two, recommendation: "Approve", claims: claim, targetKind: "retainer" })).toEqual([]);
    // click: who is parked since when, the one-time permission that stops it recurring
    expect(names(checkAskContract("click", { body: "Create the repo." }))).toEqual(["parked", "permission"]);
    expect(checkAskContract("click", { body: "Pix has waited on this since Nov 6.\nIf you give the test account admin once, this never comes back." })).toEqual([]);
    // credential: the exact scope, the fallback if refused
    expect(names(checkAskContract("credential", { body: "Reissue the token." }))).toEqual(["scope", "fallback"]);
    expect(checkAskContract("credential", { body: "Scope: repo and workflow on the test account.\nIf you decline: the check stays manual." })).toEqual([]);
    // meeting: the one question, the recommended answer
    expect(names(checkAskContract("meeting", { body: "Let's talk about the deck." }))).toEqual(["question", "recommended-answer"]);
    expect(checkAskContract("meeting", { body: "Should the deck open on the slate?", recommendation: "Yes: it is the first decision." })).toEqual([]);
    // policy: the rule, what the manager did, what reversing costs
    expect(names(checkAskContract("policy", { body: "Forks redeploy now." }))).toEqual(["rule", "what-i-did", "reversing-cost"]);
    expect(checkAskContract("policy", { body: "Rule: forks may redeploy on green CI.\nI applied it twice this week.\nReversing it means a human redeploys each change." })).toEqual([]);
  });

  it("structure is the hard contract fields, two branch buttons and the recommendation field; the rest only warns", () => {
    const n = (ps: string[]) => names(ps.map((p) => p.replace("structure ", "")));
    expect(n(askStructure("money", { body: "It ships the deck." }))).toEqual(["branches", "recommendation", "prior-decision", "spent", "steps"]);
    expect(askStructure("money", { body: MONEY, branches: two, recommendation: "Continue" })).toEqual([]);
    // claims are style for money now: a warning, not a refusal
    expect(names(askWarnings("money", { body: MONEY, branches: two, recommendation: "Continue" }))).toEqual(["claims"]);
    // a "recommends" sentence no longer stands in for the field
    expect(n(askStructure("money", { body: `${MONEY}\nPix recommends continue.`, branches: two }))).toEqual(["recommendation"]);
    expect(n(askStructure("click", { body: "Create the repo.", branches: two, recommendation: "Done" }))).toEqual(["parked"]);
    expect(n(askStructure("credential", { body: "Reissue the token.", branches: two, recommendation: "Do it" }))).toEqual(["scope", "fallback"]);
    expect(n(askStructure("meeting", { body: "Let's talk about the deck.", branches: two, recommendation: "Yes" }))).toEqual(["question"]);
    expect(n(askStructure("policy", { body: "Forks redeploy now.", branches: two, recommendation: "Keep" }))).toEqual(["rule"]);
    expect(names(askWarnings("policy", { body: "Rule: forks redeploy now; keep it.", branches: two, recommendation: "Keep" }))).toEqual(["what-i-did", "reversing-cost", "no-semicolons"]);
  });

  it("an author's card missing structure is refused every time; style rules file it with warnings in its history", async () => {
    const { world, admin, by } = seededWorld();
    const mei = by("Mei"), noor = by("Noor");
    world.ops.updateBuilding(admin, LAB, { managerAgentId: mei.id });
    world.permissions.grant({ kind: "agent", id: mei.id }, buildingRoleId(LAB, "manager"));
    const plan = (objective: string, kr = "The lab board shows its goal first") => ({ title: "Lab board shows its goal", keyResults: [{ text: kr, howToCheck: "Open the lab board" }], objective, steps: [{ title: "Step 1", description: "Do the work", size: "M" as const }], stopCondition: "two tries", askTokens: 200_000 });

    // propose_grant: the town's card from the plan passes
    const clean = await world.verbs.propose_grant(mei, plan("Show the lab's goal first on its board"));
    expect(asksFor(world, { kind: "grant", id: clean.grantId })[0]).toMatchObject({ tags: [], claims: [expect.objectContaining({ check: { kind: "kr", ref: expect.stringMatching(/^kr_/) } })] });
    // the card never quotes the objective (§5): a long objective with asides, a snake_case word and even an id passes, its
    // title names the grant, the first key result is the card's second line, and the grant keeps the objective whole
    const long = "Make the lab board answer what the lab is for in one look (the goal, its grants and the open key results, read from db_path and gr_abc123) for every guest who opens it, before anything else; then measure it. A second sentence.";
    const passed = await world.verbs.propose_grant(mei, plan(long));
    const longAsk = asksFor(world, { kind: "grant", id: passed.grantId })[0]!;
    expect(longAsk).toMatchObject({ tags: [], title: 'Fund "Lab board shows its goal" at 150k' });
    expect(longAsk.body.split("\n")[1]).toBe("The lab board shows its goal first.");
    expect(`${longAsk.title}\n${longAsk.body}`).not.toMatch(/…|in one look|second sentence/);
    expect(world.grants.require(passed.grantId).objective).toBe(long);
    // a first key result that fails the linter is dropped from the body, never clipped; the proposal still passes
    const noisy = await world.verbs.propose_grant(mei, plan("Show the goal first", "The board shows gr_abc123 first; then the grants"));
    const noisyAsk = asksFor(world, { kind: "grant", id: noisy.grantId })[0]!;
    expect(noisyAsk.tags).toEqual([]);
    expect(noisyAsk.body).not.toContain("gr_abc123");
    expect(noisyAsk.body.split("\n")[1]).toBe("It asks for 150,000 tokens. Nothing is spent yet.");
    // an explorer's own card with an id is filed, the rule a warning in its history and in the answer
    const idCard = await world.verbs.propose_grant(mei, { ...plan("Show the goal first"), ask: { body: "This is a new proposal about gr_abc123. Nothing is spent yet. It has one step, and none is done yet.", recommendation: "Fund it.", claims: [{ text: "The board lists it", check: { kind: "manual" as const } }] } });
    expect(idCard.note).toMatch(/style warning\(s\)[\s\S]*no-ids/);
    const idAsk = asksFor(world, { kind: "grant", id: idCard.grantId })[0]!;
    expect(idAsk.tags).toEqual([]);
    expect(idAsk.history.find((h) => h.action === "lint")!.note).toMatch(/^warnings: [\s\S]*no-ids/);
    // one missing its recommendation is refused, every time
    const noRec = { ...plan("Show the goal first"), ask: { body: "This is a new proposal. Nothing is spent yet. It has one step, and none is done yet.", claims: [{ text: "The board lists it", check: { kind: "manual" as const } }] } };
    for (let i = 0; i < 4; i++) await expect(world.verbs.propose_grant(mei, noRec as never)).rejects.toThrow(/structure recommendation/);
    const card = {
      body: "This is a new proposal. You have not decided on it before.\nNothing is spent yet. It has one step, and none is done yet.\nIf you fund: the goal shows first.\nIf you reject: the board stays as it is.",
      recommendation: "Fund: one session does it.", claims: [{ text: "The board API lists the goal", check: { kind: "api" as const, ref: "GET /api/buildings/carbon-cycle /building/goal" } }],
    };
    const withCard = await world.verbs.propose_grant(mei, { ...plan("Show the goal (see gr_abc123) first; then the grants"), ask: card });
    expect(asksFor(world, { kind: "grant", id: withCard.grantId })[0]).toMatchObject({ body: card.body, recommendation: card.recommendation, tags: [] });

    // a rollup's typed ask missing its rule is refused every time; with the rule it is filed, its style rules as warnings
    const report = await world.verbs.submit_report(noor, { title: "Done", body: "## What I did\nx", verdict: "stop" });
    const body = "## Shipped\nNone.\n\n## Decided\n- dc_a → approved\n\n## Key results\non track\n\n## Needs from Mitchell\n- Decide whether forks may redeploy.";
    const bad = { type: "policy" as const, title: "May forks redeploy?", body: "Forks redeploy now (on green CI); keep it?", branches: [{ label: "Keep" }, { label: "Change" }], recommendation: "Keep" };
    const roll = () => world.verbs.submit_report(mei, { title: "Rollup", body, verdict: "stop", rollup: true, provenance: { sourceIds: [report.id], urls: [] }, asks: [bad] });
    for (let i = 0; i < 4; i++) await expect(roll()).rejects.toThrow(/asks\[0\] "May forks redeploy\?": contract rule/);
    const filed = await world.verbs.submit_report(mei, { title: "Rollup", body, verdict: "stop", rollup: true, provenance: { sourceIds: [report.id], urls: [] }, asks: [{ ...bad, body: `Rule: ${bad.body}` }] });
    expect(filed.note).toMatch(/style warning\(s\)[\s\S]*no-semicolons/);
    const warned = world.asks.require(filed.asks![0]!.id);
    expect(warned.tags).toEqual([]);
    expect(warned.history.find((h) => h.action === "lint")!.note).toMatch(/no-semicolons[\s\S]*no-parentheses/);
    expect(world.events.list({ types: ["ask.refused"] })).toEqual([]);

    // the invariant over everything open: no card carries the old lint-failed pill, and an author's card has its structure
    const open = townHallIntray(world).asks;
    expect(open.length).toBeGreaterThanOrEqual(3);
    for (const a of open) expect(a.tags).not.toContain("lint-failed");
    expect(askStructure(warned.type, warned)).toEqual([]);
  }, 30_000);
});
