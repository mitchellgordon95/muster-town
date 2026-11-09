/**
 * The ask card's contract per type and its enforcement (docs/legible-delegation.md §4-5, build step 3): what each type
 * must carry, the bounce on submit_report's typed asks and on propose_grant, the 3-strike escape, and that whatever
 * reaches the in-tray passed or carries lint-failed.
 */
import { checkAskContract, vetAsk } from "@muster-town/schema";
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

  it("an ask reaching the in-tray passed its type's contract and the linter, or carries lint-failed", async () => {
    const { world, admin, by } = seededWorld();
    const mei = by("Mei"), noor = by("Noor");
    world.ops.updateBuilding(admin, LAB, { managerAgentId: mei.id });
    world.permissions.grant({ kind: "agent", id: mei.id }, buildingRoleId(LAB, "manager"));
    const plan = (objective: string) => ({ keyResults: [{ text: "The lab board shows its goal first", howToCheck: "Open the lab board" }], objective, steps: [{ title: "Step 1", description: "Do the work" }], stopCondition: "two tries", askTokens: 200_000 });

    // propose_grant: the town's card from the plan passes when the objective does
    const clean = await world.verbs.propose_grant(mei, plan("Show the lab's goal first on its board"));
    expect(asksFor(world, { kind: "grant", id: clean.grantId })[0]).toMatchObject({ tags: [], claims: [expect.objectContaining({ check: { kind: "kr", ref: expect.stringMatching(/^kr_/) } })] });
    // an objective that breaks the linter is refused with the rule; the explorer's own card passes instead
    await expect(world.verbs.propose_grant(mei, plan("Show the goal (see gr_abc123) first; then the grants"))).rejects.toThrow(/no-ids[\s\S]*no-semicolons|no-semicolons[\s\S]*no-ids/);
    const card = {
      body: "This is a new proposal. You have not decided on it before.\nNothing is spent yet. It has one step, and none is done yet.\nIf you fund: the goal shows first.\nIf you reject: the board stays as it is.",
      recommendation: "Fund: one session does it.", claims: [{ text: "The board API lists the goal", check: { kind: "api" as const, ref: "GET /api/buildings/carbon-cycle /building/goal" } }],
    };
    const withCard = await world.verbs.propose_grant(mei, { ...plan("Show the goal (see gr_abc123) first; then the grants"), ask: card });
    expect(asksFor(world, { kind: "grant", id: withCard.grantId })[0]).toMatchObject({ body: card.body, recommendation: card.recommendation, tags: [] });

    // a rollup's typed ask that fails is refused twice; the session's third attempt is filed, flagged, its rules in history
    const report = await world.verbs.submit_report(noor, { title: "Done", body: "## What I did\nx", verdict: "stop" });
    const body = "## Shipped\nNone.\n\n## Decided\n- dc_a → approved\n\n## Key results\non track\n\n## Needs from Mitchell\n- Decide whether forks may redeploy.";
    const bad = { type: "policy" as const, title: "May forks redeploy?", body: "Forks redeploy now (on green CI); keep it?", branches: [{ label: "Keep" }, { label: "Change" }], recommendation: "Keep" };
    const roll = () => world.verbs.submit_report(mei, { title: "Rollup", body, verdict: "stop", rollup: true, provenance: { sourceIds: [report.id], urls: [] }, asks: [bad] });
    await expect(roll()).rejects.toThrow(/asks\[0\] "May forks redeploy\?": contract rule/);
    await expect(roll()).rejects.toThrow(/Your next attempt is filed even if it still fails/);
    const filed = await roll();
    const flagged = world.asks.require(filed.asks![0]!.id);
    expect(flagged.tags).toEqual(["lint-failed"]);
    expect(flagged.history.find((h) => h.action === "lint")!.note).toMatch(/no-semicolons[\s\S]*no-parentheses/);
    expect(world.events.list({ types: ["ask.refused"] }).map((e) => e.payload.what)).toEqual(["proposal", "rollup", "rollup"]);

    // the invariant over everything open: each card passes its contract and the linter, or is flagged
    const open = townHallIntray(world).asks;
    expect(open.length).toBeGreaterThanOrEqual(3);
    for (const a of open) expect(vetAsk(a.type, a).length === 0 || a.tags.includes("lint-failed")).toBe(true);
  }, 30_000);
});
