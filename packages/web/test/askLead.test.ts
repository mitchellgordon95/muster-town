/**
 * The ask card's one bold lead (grant gr_x7p580xe1o step 1). PROD is the live GET /api/asks of 2026-11-20 01:41 UTC
 * verbatim (ak_daahya1764): one paragraph of short lines. Its "If you <branch>:" sentences stay in the body, where the
 * author wrote them (Mitchell, 1:1 mt_gf4un6ct4p: the buttons go back to one row at the bottom).
 */
import { describe, expect, it } from "vitest";
import { deltaOf } from "../src/panels/asks";

const PROD = "Prod asks 200k tokens to show self-hosted towns as tiles on the muster.town homepage.\nThis is a new proposal. You have not decided on it before. Nothing is spent. Zero of two steps are done. Two steps are left.\nIf you fund: 200k buys both steps and three key results checked on the live homepage.\nIf you reject: Prod removes the homepage promise from the guide under exploration. Verified towns stay in the API only.";

describe("deltaOf: one bold lead", () => {
  it("is the first paragraph when the body has a blank line", () => {
    expect(deltaOf("First line.\n\nThe rest.")).toEqual({ delta: "First line.", rest: "The rest." });
  });
  it("is the first sentence of a one-paragraph live body, and the rest keeps its 'If you' sentences", () => {
    const d = deltaOf(PROD);
    expect(d.delta).toBe("Prod asks 200k tokens to show self-hosted towns as tiles on the muster.town homepage.");
    expect(d.rest.startsWith("This is a new proposal.")).toBe(true);
    expect(d.rest).toContain("\nIf you fund: 200k buys");
    expect(d.rest.endsWith("Verified towns stay in the API only.")).toBe(true);
    expect(deltaOf("Spent 2.2M so far. Done.")).toEqual({ delta: "Spent 2.2M so far.", rest: "Done." });
    expect(deltaOf("One line, no stop")).toEqual({ delta: "One line, no stop", rest: "" });
  });
});
