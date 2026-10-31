/** Agent teams step 2 (dc_i7ji4xacd9): the manager's `fork_status` reads a running fork's assignment, tokens so far and last tool calls. */
import { describe, expect, test } from "vitest";
import { updateBuilding, type ForkStatus } from "@muster-town/core";
import { TOWN_TOOLS } from "../src/session.ts";
import { callVerb, init, result, setup, toolUse } from "./helpers.ts";

const REPORT = { title: "Done", verdict: "stop", body: "## What I did\nIt.\n\n## Findings\nIt works.\n\n## What I need from you\nNothing needed." };
/** A tool_result as the SDK streams it: text content as given (the helper's toolResult JSON-encodes it). */
const toolResult = (id: string, text: string, isError = false) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }], is_error: isError }] } });
const usage = (id: string, output: number) => ({
  type: "assistant", session_id: "sdk-session-1",
  message: { id, model: "claude-opus-5-5", content: [{ type: "text", text: "Tests pass; now the report." }], usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
});

describe("fork_status", () => {
  test("mid-session the manager sees the fork's assignment, tokens booked so far, last calls with input and result lines; others are refused", async () => {
    let meiId = "";
    let seen: ForkStatus | null = null;
    let viaAssignment: ForkStatus | null = null;
    let refused = "";
    const t = setup(async function* (s) {
      if (s.agentId === meiId) { yield init(); yield result(1, 0); return; }
      yield init();
      yield toolUse("Bash", { command: "npm test -w packages/core\necho done", description: "run tests" }, "tu_bash");
      yield toolResult("tu_bash", "Tests  42 passed (42)\nDuration 3s");
      yield toolUse("Read", { file_path: "/repo/packages/core/src/forks.ts" }, "tu_read");
      yield toolResult("tu_read", "no such file", true);
      yield toolUse("Grep", { pattern: "teamBlock" }, "tu_desk");
      // a desk reports its result through POST /api/agents/me/activity
      const sid = s.world.sessions.first("agentId = ? AND status = 'running'", [s.agentId!])!.id;
      t.runtime.onDeskActivity(s.agentId!, { session: sid, kind: "result", toolUseId: "tu_desk", text: "\n  memory.ts:292 export function teamBlock\nmore", isError: false });
      yield usage("msg_1", 2000);
      seen = await s.world.verbs.fork_status(meiId, { forkId: s.agentId! });
      const asg = s.world.sessions.require(sid).assignmentId!;
      viaAssignment = await s.world.verbs.fork_status(meiId, { assignmentId: asg, limit: 1 });
      refused = await s.world.verbs.fork_status(t.by("Noor").id, { forkId: s.agentId! }).then(() => "allowed", (e: Error) => e.message);
      yield* callVerb(s, "submit_report", REPORT);
      yield result(100, 0.01);
    }, { usageBookMs: 0 });
    const { world, lab, by, runtime } = t;
    const mei = by("Mei");
    meiId = mei.id;
    updateBuilding(world, lab.id, { managerAgentId: mei.id });
    world.buildings.upsert({ ...world.buildings.require(lab.id), explorationTokensPerDay: 10_000_000, headcount: world.layout.deskCount(lab.id) + 2 });
    const { assignmentId } = await world.verbs.assign(world.agents.require(mei.id), { title: "Fix the thing", description: "Do it.", gap: "test gap" });
    await runtime.tickOnce();
    await runtime.whenIdle();

    expect(seen).not.toBeNull();
    const st = seen!;
    expect(st.fork).toMatchObject({ name: "Mei 1", status: "working" });
    expect(st.assignment).toMatchObject({ id: assignmentId, title: "Fix the thing", lane: "exploration" });
    expect(st.session).toMatchObject({ status: "running", reportId: null });
    expect(st.session!.adjustedTokensSoFar).toBeGreaterThan(0);
    expect(st.calls).toEqual([
      expect.objectContaining({ tool: "Bash", input: "command: npm test -w packages/core", result: "Tests  42 passed (42)", isError: false }),
      expect.objectContaining({ tool: "Read", input: "file_path: /repo/packages/core/src/forks.ts", result: "no such file", isError: true }),
      expect.objectContaining({ tool: "Grep", input: "pattern: teamBlock", result: "memory.ts:292 export function teamBlock" }),
    ]);
    expect(st.lastThought?.text).toBe("Tests pass; now the report.");
    // by assignment, newest call only
    expect(viaAssignment!.calls.map((c) => c.tool)).toEqual(["Grep"]);
    expect(refused).toMatch(/building\.assign/);
    // manage sessions (and the 1:1s they run) get every town verb, this one included
    expect(TOWN_TOOLS).toContain("mcp__town__fork_status");
    const forkId = st.fork.id;
    expect(world.agents.require(forkId).status).toBe("retired");
    const after = await world.verbs.fork_status(mei.id, { forkId });
    expect(after.session).toMatchObject({ status: "done" });
    expect(after.note).toMatch(/with report dc_/);
  });
});
