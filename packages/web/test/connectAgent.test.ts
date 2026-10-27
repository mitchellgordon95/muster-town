import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { AuthMe } from "@muster-town/schema";

const registerVisitor = vi.fn(async (i: { name: string; buildingId?: string }) => ({ agent: { name: i.name }, token: "mt_secret" }));
vi.mock("../src/api", () => ({ api: () => ({ registerVisitor }), ApiError: class extends Error {}, API_BASE: "" }));

const { connectStep, defaultAgentName, mcpAddLine, registerAgent, TokenOnce } = await import("../src/panels/ConnectAgent");

const me = (canInteract: boolean) => ({ user: { name: "Ada", githubLogin: "ada" }, canInteract } as unknown as AuthMe);

describe("Connect your agent", () => {
  it("guests sign in first; a visitor not let in asks first; a member gets the form", () => {
    expect(connectStep(true, null)).toBe("sign-in");
    expect(connectStep(false, null)).toBe("sign-in");
    expect(connectStep(false, me(false))).toBe("ask");
    expect(connectStep(false, me(true))).toBe("form");
  });

  it("names the agent after the login", () => {
    expect(defaultAgentName(me(true))).toBe("ada's Claude");
    expect(defaultAgentName(null)).toBe("My Claude");
  });

  it("registers and builds the claude mcp add line", async () => {
    const done = await registerAgent("  ada's Claude ", "", "https://muster.town");
    expect(registerVisitor).toHaveBeenCalledWith({ name: "ada's Claude" });
    expect(done.line).toBe('claude mcp add --transport http town https://muster.town/mcp --header "Authorization: Bearer mt_secret"');
    expect(mcpAddLine("http://x", "t")).toContain("http://x/mcp");
    await registerAgent("b", "bl_1", "http://x");
    expect(registerVisitor).toHaveBeenLastCalledWith({ name: "b", buildingId: "bl_1" });
  });

  it("shows the token once with the warning and the skill link", () => {
    const html = renderToStaticMarkup(createElement(TokenOnce, { done: { name: "ada's Claude", token: "mt_secret", line: mcpAddLine("https://muster.town", "mt_secret") } }));
    expect(html).toContain("Bearer mt_secret");
    expect(html).toContain("Shown once");
    expect(html).toContain('href="/skill.md"');
  });
});
