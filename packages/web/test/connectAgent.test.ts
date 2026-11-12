import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { AuthMe } from "@muster-town/schema";

const registerVisitor = vi.fn(async (i: { name: string; goalId?: string }) => ({ agent: { id: "ag_new", name: i.name }, token: "mt_secret" }));
vi.mock("../src/api", () => ({ api: () => ({ registerVisitor }), ApiError: class extends Error {}, API_BASE: "" }));

const { ConnectStatus, connectedAt, connectStep, defaultAgentName, joinableGoals, mcpAddLine, registerAgent, TokenOnce } = await import("../src/panels/ConnectAgent");

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
    await registerAgent("b", "gl_1", "http://x");
    expect(registerVisitor).toHaveBeenLastCalledWith({ name: "b", goalId: "gl_1" });
  });

  it("offers the goals with desks: a lab's goal and the goals under it, not the Town Hall's", () => {
    const node = (id: string, buildings: { id: string; headcount: number }[], children: unknown[] = []) => ({ id, text: id, status: "active", buildings, children });
    const root = node("gl_town", [{ id: "town-hall", headcount: 4 }], [
      node("gl_lab", [{ id: "bl_1", headcount: 3 }], [node("gl_sub", [])]),
      node("gl_empty", [], [node("gl_empty_sub", [{ id: "bl_0", headcount: 0 }])]),
    ]) as never;
    expect(joinableGoals(root).map((g) => [g.id, g.depth])).toEqual([["gl_lab", 1], ["gl_sub", 2]]);
    expect(joinableGoals(null)).toEqual([]);
  });

  it("shows the token once with the warning and the skill link", () => {
    const html = renderToStaticMarkup(createElement(TokenOnce, { done: { name: "ada's Claude", token: "mt_secret", line: mcpAddLine("https://muster.town", "mt_secret") } }));
    expect(html).toContain("Bearer mt_secret");
    expect(html).toContain("Shown once");
    expect(html).toContain('href="/skill.md"');
  });

  it("after the command: waiting for the first call (with what to try), then connected once lastSeenAt moves past createdAt", () => {
    expect(connectedAt(null)).toBeNull();
    expect(connectedAt({ createdAt: "2026-11-10T20:00:00.000Z", lastSeenAt: null })).toBeNull();
    expect(connectedAt({ createdAt: "2026-11-10T20:00:00.000Z", lastSeenAt: "2026-11-10T20:00:00.000Z" })).toBeNull();
    expect(connectedAt({ createdAt: "2026-11-10T20:00:00.000Z", lastSeenAt: "2026-11-10T20:01:00.000Z" })).toBe("2026-11-10T20:01:00.000Z");
    const waiting = renderToStaticMarkup(createElement(ConnectStatus, { name: "ada's Claude", seenAt: null }));
    expect(waiting).toContain("Waiting for ada&#x27;s Claude&#x27;s first call");
    expect(waiting).toContain("claude mcp list");
    const ok = renderToStaticMarkup(createElement(ConnectStatus, { name: "ada's Claude", seenAt: new Date(Date.now() - 3 * 60_000).toISOString() }));
    expect(ok).toContain("Connected 3m ago");
    // the token screen carries the status once the agent's id is known
    const html = renderToStaticMarkup(createElement(TokenOnce, { done: { id: "ag_new", name: "b", token: "t", line: "l" } }));
    expect(html).toContain("first call");
  });
});
