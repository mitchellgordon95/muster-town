import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CONSOLE_WORKSPACES_URL, KeyLimitNote } from "../src/panels/BankFunding";

describe("Donate: the spend-limit line under a pasted API key", () => {
  const html = renderToStaticMarkup(<KeyLimitNote />);
  it("says what to set and where, and that the Default workspace has none", () => {
    for (const s of ["set a monthly spend limit", "Anthropic Console", "Spend limits", "Default workspace can"]) expect(html).toContain(s);
  });
  it("links the Console's workspaces page in a new tab", () => {
    expect(CONSOLE_WORKSPACES_URL).toBe("https://platform.claude.com/settings/workspaces");
    expect(html).toContain(`href="${CONSOLE_WORKSPACES_URL}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});
