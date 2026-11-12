import { describe, expect, test } from "vitest";
import { townOptions, webFor, WEB_TOOLS, type Ctx } from "../src/session.ts";

// Which built-in tools each in-process session kind gets (1:1 mt_msnjkpgwdb decision 2: web for the Secretary).
describe("session tools", () => {
  test("web: work always; every manager's 1:1; the Secretary's manage sessions and meeting replies; nothing else", () => {
    expect(webFor("work")).toBe(true);
    expect(webFor("manage", { oneOnOne: true })).toBe(true);
    expect(webFor("manage", { secretary: true })).toBe(true);
    expect(webFor("manage")).toBe(false); // another manager's team-lead session
    expect(webFor("meeting-reply", { secretary: true })).toBe(true);
    expect(webFor("meeting-reply")).toBe(false);
    expect(webFor("facilitate", { secretary: true })).toBe(false);
  });

  test("a web session gets WebSearch and WebFetch and still nothing that edits or runs code", () => {
    const ctx = { world: { tokens: { getOrCreate: () => "tok" } }, mcpUrl: "http://x/mcp", env: {} } as unknown as Ctx;
    const spec = { agentId: "ag_x", purpose: "manage" as const, model: "claude-opus-5-5", system: "", prompt: "", maxTurns: 5 };
    const credential = { kind: "subscription" as const, secret: "t", inputId: null };
    const on = townOptions(ctx, { ...spec, web: true }, credential);
    expect(on.tools).toEqual(WEB_TOOLS);
    for (const t of WEB_TOOLS) expect(on.allowedTools).toContain(t);
    for (const t of ["Bash", "Write", "Edit", "Read", "Task", "Agent"]) {
      expect(on.tools).not.toContain(t);
      expect(on.disallowedTools).toContain(t);
    }
    const off = townOptions(ctx, { ...spec, web: false }, credential);
    expect(off.tools).toEqual([]);
    for (const t of WEB_TOOLS) expect(off.disallowedTools).toContain(t);
  });
});
