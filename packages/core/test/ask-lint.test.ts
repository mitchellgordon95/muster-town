/**
 * The ask card's linter (docs/legible-delegation.md §5, build step 3): each countable 80%-STE rule fails one sentence
 * and passes another, and §5's real Prod ask fails as first written and passes as a card.
 */
import { ASK_LINT_RULES, lintAskBody } from "@muster-town/schema";
import { describe, expect, it } from "vitest";

/** A card that passes every card rule, so a test sees only the sentence rule it is about. */
const card = { recommendation: "Continue", branches: [{ label: "Continue" }, { label: "Cut" }] };
const rules = (body: string, c: Parameters<typeof lintAskBody>[1] = card) => lintAskBody(body, c).map((p) => p.split(":")[0]);

const PROD_BEFORE = "Continue gr_q1jrelx2ty at its checkpoint (about 150,000 more is enough: one session merges PR #392 and closes it) or cut it, in which case the docs PR merges under exploration and its second key result stays unclaimed.";
const PROD_AFTER = `**Prod asks for 150k more tokens to finish the self-host grant.**
You funded this at 600k on Oct 31. It has spent 474k. Three of four steps shipped. A stranger can now run a town from a published image, and CI restores a backup from it on every green main.
One step is left. A docs PR points self-host path B at the image. One session does it.
If you continue: 150k, then the grant closes.
If you cut: the PR merges under exploration. One key result stays unclaimed.
Cleo recommends continue.`;

describe("the ask linter (docs/legible-delegation.md §5)", () => {
  it("each rule fails a sentence that breaks it and passes one that keeps it", () => {
    // sentence length: 20 words for an instruction, 25 for a description
    expect(rules("Fund the grant now so that the deck ships this week and the forks can start on the second step before the weekend.")).toEqual(["sentence-length"]);
    expect(rules("Fund the grant now so the deck ships this week.")).toEqual([]);
    expect(rules("The deck shipped this week and the forks started on the second step before the weekend, so the third step can start early on Monday morning at nine.")).toEqual(["sentence-length"]);
    expect(rules("The deck shipped this week and the forks started on the second step before the weekend.")).toEqual([]);
    // no ids
    expect(rules("The grant gr_q1jrelx2ty has spent 474k.")).toEqual(["no-ids"]);
    expect(rules("The self-host grant has spent 474k.")).toEqual([]);
    // no semicolons, no parentheses
    expect(rules("It has spent 474k; one step is left.")).toEqual(["no-semicolons"]);
    expect(rules("It has spent 474k. One step is left.")).toEqual([]);
    expect(rules("It has spent 474k (of 600k).")).toEqual(["no-parentheses"]);
    expect(rules("It has spent 474k of 600k.")).toEqual([]);
    // one instruction per sentence
    expect(rules("Continue the grant or cut it now.")).toEqual(["one-instruction"]);
    expect(rules("If you continue: one session closes it.")).toEqual([]);
    // conditions before the actions they affect
    expect(rules("The grant stops, in which case the PR merges under exploration.")).toEqual(["condition-first"]);
    expect(rules("Fund the grant, if the PR is green.")).toEqual(["condition-first"]);
    expect(rules("If the PR is green, fund the grant.")).toEqual([]);
    // a recommendation, and at least two branches (fields, or sentences)
    expect(rules("One step is left.", { branches: card.branches })).toEqual(["recommendation"]);
    expect(rules("One step is left. Cleo recommends continue.", { branches: card.branches })).toEqual([]);
    expect(rules("One step is left.", { recommendation: "Continue", branches: [{ label: "Continue" }] })).toEqual(["branches"]);
    expect(rules("If you continue: it closes. If you cut: it stops.", { recommendation: "Continue" })).toEqual([]);
    // every rule is data with a name and the line a prompt quotes
    expect(ASK_LINT_RULES.map((r) => r.name)).toEqual(["sentence-length", "no-ids", "no-semicolons", "no-parentheses", "one-instruction", "condition-first", "recommendation", "branches", "dictionary"]);
  });

  it("the §5 Prod ask fails as first written and passes as a card", () => {
    const failed = lintAskBody(PROD_BEFORE);
    expect(failed.map((p) => p.split(":")[0])).toEqual(["sentence-length", "no-ids", "no-parentheses", "one-instruction", "condition-first", "recommendation", "branches"]);
    expect(failed[0]).toContain("Continue gr_q1jrelx2ty at its checkpoint");
    expect(lintAskBody(PROD_AFTER)).toEqual([]);
  });
});
