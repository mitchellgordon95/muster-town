import { describe, expect, it } from "vitest";
import { firstSentence, isPlumbing, latestThought, nowLine, plainActivity } from "../src/panels/nowLine";

const ID = /\b(as|se|dc|mt|ag|bl|gr|kr|rs)_[a-z0-9]{10}\b/;
const agent = (status: string, extra: object = {}) => ({ name: "Teo 1", kind: "resident", status, activity: "", forkOf: null, ...extra }) as never;

describe("agent panel Now line", () => {
  it("says what a working agent does, from its latest thought, in one sentence", () => {
    const l = nowLine({ agent: agent("working", { activity: "Reading AgentPanel.tsx" }), thought: "I'm reading the panel code. Then I'll test it.", task: "Delight step 2" });
    expect(l?.now).toBe("Now: I'm reading the panel code.");
    expect(l?.task).toEqual({ label: "Working on", title: "Delight step 2" });
  });
  it("falls back to the activity, without the funding note or a git branch", () => {
    expect(nowLine({ agent: agent("working", { activity: "Starting work (funded by subscription)" }) })?.now).toBe("Now: Starting work");
    expect(plainActivity("Setting up agent/teo-1/delight-step-2")).toBe("Setting up their desk");
  });
  it("says a resting agent is resting, with what it last finished", () => {
    const l = nowLine({ agent: agent("idle"), lastDone: "Readable bubbles" });
    expect(l?.now).toMatch(/^Now: resting/);
    expect(l?.task?.label).toBe("Last finished");
  });
  it("says a retired helper finished its task", () => {
    expect(nowLine({ agent: agent("retired", { forkOf: "ag_r7ufyv4dkp" }), task: "x" })?.now).toMatch(/^Done:/);
  });
  it("never puts a raw id or an internal word in the line itself", () => {
    for (const s of ["idle", "working", "walking", "in-meeting", "stopped", "out-of-budget", "offline", "banned", "retired"]) {
      const now = nowLine({ agent: agent(s, { activity: "Starting work (funded by subscription)" }) })?.now ?? "";
      expect(now).not.toMatch(ID);
      expect(isPlumbing({ type: "agent.tool", text: now })).toBe(false);
    }
  });
  it("cuts a long thought", () => {
    expect(firstSentence("a".repeat(300)).length).toBe(160);
  });
  it("finds the latest thought of the current session only", () => {
    const ev = [
      { type: "agent.thought", text: "old", agentId: "a" },
      { type: "session.started", text: "", agentId: "a" },
      { type: "agent.tool", text: "Reading", agentId: "a" },
    ] as never[];
    expect(latestThought(ev, "a")).toBeNull();
    expect(latestThought([...ev, { type: "agent.thought", text: "new", agentId: "a" } as never], "a")).toBe("new");
  });
});

describe("plumbing lines fold behind Details", () => {
  it("folds sessions, secrets, spend and chain lines; keeps thoughts and tools", () => {
    expect(isPlumbing({ type: "system", text: "Transcript kept for session se_bna34wg9uv (290 lines)" })).toBe(true);
    expect(isPlumbing({ type: "session.started", text: "Teo 1 started a work session (funded by subscription)" })).toBe(true);
    expect(isPlumbing({ type: "agent.tool", text: "chain as_ud02cnnqwn · hop 2" })).toBe(true);
    expect(isPlumbing({ type: "agent.tool", text: "Reading AgentPanel.tsx" })).toBe(false);
    expect(isPlumbing({ type: "agent.thought", text: "I'll park on the session's CI" })).toBe(false);
  });
});
