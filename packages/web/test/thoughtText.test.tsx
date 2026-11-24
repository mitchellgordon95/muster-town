import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ThoughtText } from "../src/panels/ThoughtText";
import { plainThought } from "../src/panels/thoughtMarkdown";
import { firstSentence } from "../src/panels/nowLine";

// Grant gr_7h6r66d10i: a thought in Talk shows bold as bold, code as code, list items as lines; ids stay links.
describe("ThoughtText", () => {
  it("renders bold, code and list items, with no markdown characters left", () => {
    const html = renderToStaticMarkup(<ThoughtText text={"Found **two** bugs in `grants.ts`:\n- the clip\n- the render"} />);
    expect(html).toContain("<strong>two</strong>");
    expect(html).toContain("<code>grants.ts</code>");
    expect(html).toContain("<br/>the clip<br/>the render");
    expect(html).not.toMatch(/\*\*|`|- the/);
  });
  it("keeps doc ids as links", () => {
    const html = renderToStaticMarkup(<ThoughtText text={"Reading **dc_abc123xyz0** now"} />);
    expect(html).toMatch(/<strong><a [^>]*href="[^"]*dc_abc123xyz0/);
  });
  it("the head line's sentence has no markdown characters", () => {
    expect(plainThought("## Plan\n- **Fix** the `clip`")).toBe("Plan Fix the clip");
    expect(firstSentence("Now **fixing** the `clip`. Then tests.")).toBe("Now fixing the clip.");
  });
});
