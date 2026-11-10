import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GrantSteps } from "../src/panels/Places";

// grant B gr_b5fyqibfx2 step 2 (kr_snardl39qh): the grant card lists the plan's steps, numbered, with each step's state once funded
const steps = [{ title: "Build it", description: "the PR" }, { title: "Check it live", description: "as a guest" }, { title: "Close it", description: "close" }];

describe("the grant card's steps", () => {
  it("a proposal lists its steps numbered, with no state", () => {
    const html = renderToStaticMarkup(<GrantSteps grant={{ steps, stepStates: [null, null, null] }} />);
    expect(html).toContain("<ol class=\"grant-steps\">");
    expect(html.match(/<li/g)).toHaveLength(3);
    expect(html).toContain("Build it");
    expect(html).toContain("funding queues step 1");
    expect(html).not.toContain("grant-step-state");
  });

  it("a funded grant marks each step done, running or queued from its latest assignment", () => {
    const html = renderToStaticMarkup(<GrantSteps grant={{ steps, stepStates: [
      { assignmentId: "as_1", status: "done", reportId: "dc_1" }, { assignmentId: "as_2", status: "active", reportId: null }, null,
    ] }} />);
    expect(html).toContain("grant-step-state done");
    expect(html).toContain("· running");
    expect(html.match(/grant-step-state/g)).toHaveLength(2);
  });

  it("a grant from before steps shows nothing", () => {
    expect(renderToStaticMarkup(<GrantSteps grant={{ steps: [], stepStates: [] }} />)).toBe("");
  });
});
