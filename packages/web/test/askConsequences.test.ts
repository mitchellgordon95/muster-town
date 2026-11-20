/**
 * The ask card's "If you <branch>:" split and its one bold lead (grant gr_x7p580xe1o step 1). The two bodies are the
 * live GET /api/asks of 2026-11-20 01:41 UTC verbatim (ak_3ault12lbz, ak_daahya1764): one paragraph of short lines.
 */
import { describe, expect, it } from "vitest";
import { deltaOf, splitConsequences } from "../src/panels/asks";

const BANK = "Bank Transparency asks you to fund Show how much incoming credit goes unused at 200,000 tokens.\nThis is a new proposal. You have not decided on it before. Nothing is spent. It has two steps, none done.\nToday the Balance tab says the collective runs a surplus of about 17.9 million tokens a day. That is not true. Subscription credit expires at the next daily renewal.\nOver the last 7 full days 148 million tokens came in and 24.7 million were used. That is 16.7 percent. About 5 of every 6 tokens expired undrawn.\nOver all time 262 million of 454 million credited tokens expired. That is 58 percent.\nA stranger cannot see this today. Expiry shows only as one all-time row and per credit on Inputs.\nIf you fund: step one adds an expired count to each daily row and the day chart. It adds 7 day and 30 day sentences with credited, used and expired, and a check line that the parts add up. It rewords the surplus line to say unused subscription tokens expire at renewal. Step two verifies it live signed out with a picture and claims the three key results.\nIf you counter: say the amount or the steps to drop. One step with no live check is the smallest version.\nIf you reject: the Balance tab keeps calling expiring credit a surplus.\nThe town estimates 141k to 193k from three similar closed grants. The key results are due Nov 23.\nOne limit stays. The used share is a share of the credited amount, not of the real plan capacity.";
const PROD = "Prod asks 200k tokens to show self-hosted towns as tiles on the muster.town homepage.\nThis is a new proposal. You have not decided on it before. Nothing is spent. Zero of two steps are done. Two steps are left.\nYou funded the self-hosted directory in October and it shipped. A town that registers and proves its DNS name appears in the directory API. The self-host guide promises it also appears on the homepage beside the hosted towns. The homepage code never reads the directory, so the guide makes a promise the town does not keep. The directory lists zero towns today.\nStep 1 is small. Prod adds homepage tiles marked self-hosted with an outside link, a test, and fixes the guide. Onboarding owns homepage tiles, so Kelly reviews the pull request. Cleo 1 told Kelly tonight and Kelly has not answered yet. Step 2 is medium. A one-day proof town on Wright's box gets listed and shows a tile. Wright then tears it down and the tile leaves the homepage.\nIf you fund: 200k buys both steps and three key results checked on the live homepage.\nIf you counter at 50k: Prod re-proposes step 1 only. The key results stay met, unverified until a real town registers.\nIf you reject: Prod removes the homepage promise from the guide under exploration. Verified towns stay in the API only.";
const MONEY = ["Fund", "Counter", "Reject"];

describe("splitConsequences on the live bodies", () => {
  it("moves each branch's whole 'If you' line under its button and keeps the rest in order", () => {
    const { body, byLabel } = splitConsequences(BANK, MONEY);
    expect(Object.keys(byLabel)).toEqual(["Fund", "Counter", "Reject"]);
    expect(byLabel.Fund).toMatch(/^If you fund: step one adds .* claims the three key results\.$/);
    expect(byLabel.Counter).toBe("If you counter: say the amount or the steps to drop. One step with no live check is the smallest version.");
    expect(byLabel.Reject).toBe("If you reject: the Balance tab keeps calling expiring credit a surplus.");
    expect(body).not.toMatch(/If you/);
    expect(body.split("\n")).toHaveLength(8);
    expect(body.endsWith("not of the real plan capacity.")).toBe(true);
  });
  it("gives 'If you counter at 50k:' to Counter", () => {
    const { body, byLabel } = splitConsequences(PROD, MONEY);
    expect(byLabel.Counter).toBe("If you counter at 50k: Prod re-proposes step 1 only. The key results stay met, unverified until a real town registers.");
    expect(byLabel.Fund).toMatch(/^If you fund: 200k buys/);
    expect(byLabel.Reject).toMatch(/Verified towns stay in the API only\.$/);
    expect(body).not.toMatch(/If you/);
    expect(body.endsWith("the tile leaves the homepage.")).toBe(true);
  });
});

describe("splitConsequences edge cases", () => {
  it("leaves a sentence that names no branch, or has no colon, in the body", () => {
    const r = splitConsequences("Keel recommends a bar. If you agree, reply Bar.\n\nIf you claim: it is yours.\nIf you decline: Noor drops it.", ["Done", "Decline"]);
    expect(r.byLabel).toEqual({ Decline: "If you decline: Noor drops it." });
    expect(r.body).toBe("Keel recommends a bar. If you agree, reply Bar.\n\nIf you claim: it is yours.");
  });
  it("matches on a word boundary, mid-line after a sentence, and case-insensitively", () => {
    const r = splitConsequences("The rule is S. If you ADD it: every prompt pins it. If you skip: nothing changes.", ["Add", "Skip", "Ad"]);
    expect(r.byLabel).toEqual({ Add: "If you ADD it: every prompt pins it.", Skip: "If you skip: nothing changes." });
    expect(r.body).toBe("The rule is S.");
  });
  it("keeps a branch's second sentence in the body, and a body with none unchanged", () => {
    const r = splitConsequences("If you fund: a.\nIf you fund: b.", ["Fund"]);
    expect(r.byLabel).toEqual({ Fund: "If you fund: a." });
    expect(r.body).toBe("If you fund: b.");
    expect(splitConsequences("I'd like to help", ["Let in", "Decline"])).toEqual({ body: "I'd like to help", byLabel: {} });
  });
});

describe("deltaOf: one bold lead", () => {
  it("is the first paragraph when the body has a blank line", () => {
    expect(deltaOf("First line.\n\nThe rest.")).toEqual({ delta: "First line.", rest: "The rest." });
  });
  it("is the first sentence of a one-paragraph live body", () => {
    const { body } = splitConsequences(PROD, MONEY);
    const d = deltaOf(body);
    expect(d.delta).toBe("Prod asks 200k tokens to show self-hosted towns as tiles on the muster.town homepage.");
    expect(d.rest.startsWith("This is a new proposal.")).toBe(true);
    expect(deltaOf("Spent 2.2M so far. Done.")).toEqual({ delta: "Spent 2.2M so far.", rest: "Done." });
    expect(deltaOf("One line, no stop")).toEqual({ delta: "One line, no stop", rest: "" });
  });
});
