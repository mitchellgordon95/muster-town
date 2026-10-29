import { describe, expect, it } from "vitest";
import type { Agent, Building, Meeting, Town } from "@muster-town/schema";
import { facilitatePrompt, managePrompt, managerIntrayBlock, meetingReplyPrompt, meetingReplySystemPrompt, REPORT_FORMAT, sessionMemory, summarySystemPrompt, workshopPrompt, workSystemPrompt } from "../src/prompts.ts";
import { seededWorld } from "./helpers.ts";

const agent = { id: "ag_1", name: "Root", title: "Backend", direction: "Core, server, and runtime only." } as Agent;
const building = { id: "workshop", name: "Town Workshop", goal: "Ship PRs", maxTurnsPerSession: 120 } as Building;
const town = { name: "Workshop Collective", goal: "Be trustworthy" } as Town;

describe("prompts carry no titles or job descriptions", () => {
  it("the work prompt names the agent without a title or lane, and says it owns the work end to end", () => {
    const p = workSystemPrompt(agent, building, town);
    expect(p).toContain("You are Root, a resident of the Town Workshop");
    expect(p).toContain("end to end");
    expect(p).not.toContain("Backend");
    expect(p).not.toContain("Core, server, and runtime only.");
    expect(p).not.toMatch(/standing direction/i);
  });
  it("the meeting summary prompt has no title", () => {
    expect(summarySystemPrompt(agent)).not.toContain("Backend");
  });
});

describe("no forced next step", () => {
  it("reports are what I did / findings / what I need from you, and inventing work is discouraged", () => {
    expect(REPORT_FORMAT).toMatch(/## What I did/);
    expect(REPORT_FORMAT).toMatch(/## Findings/);
    expect(REPORT_FORMAT).toMatch(/## What I need from you/);
    expect(REPORT_FORMAT).not.toMatch(/Proposal for next session/);
    expect(REPORT_FORMAT).toMatch(/Never invent follow-up work/);
  });
  it("the manager's in-tray block lists the residents' pending reports, the escalation criteria and the rollup rule; only the manager gets it", async () => {
    const { world, by, admin } = seededWorld();
    const mei = by("Mei");
    const b = world.ops.updateBuilding(admin, "carbon-cycle", { managerAgentId: mei.id });
    const r = await world.verbs.submit_report(by("Noor"), { title: "Ocean sink 2024", body: "## What I did\nx\n## Findings\ny\n## What I need from you\nMerge PR #12.", verdict: "stop" });
    const block = managerIntrayBlock(world, b, mei.id);
    expect(block).toContain("## Your in-tray (you work it; Mitchell doesn't see these reports)");
    expect(block).toContain(`${r.id} "Ocean sink 2024" by Noor (verdict stop`);
    expect(block).toContain("needs: Merge PR #12.");
    expect(block).toMatch(/Decide yourself unless/);
    expect(block).toMatch(/rollup: true/);
    expect(block).toContain("Last rollup: never; reports decided since:");
    expect(sessionMemory(world, mei, b).team).toContain("## Your in-tray");
    expect(sessionMemory(world, by("Noor"), b).team).toBeUndefined();
    await world.verbs.review(admin, { docId: r.id, decision: "approve" });
    const after = managerIntrayBlock(world, b, mei.id);
    expect(after).not.toContain(r.id);
    expect(after).toContain("reports decided since: 1");
  });
  it("the team-lead session prompt keeps the manager to decisions and rollups: every task becomes an assignment, independent ones to different residents in parallel", () => {
    const { world } = seededWorld();
    const b = world.buildings.get("carbon-cycle")!;
    const p = managePrompt(b, [], (id) => world.nameOf(id));
    expect(p).toMatch(/A manager does only decisions and rollups/);
    expect(p).toMatch(/becomes an assignment the moment it appears/);
    expect(p).toMatch(/different residents in parallel/);
    expect(p).toMatch(/not queued on one resident/);
    // town hall 2026-10-25, decision 6: delegate by default, self-assign when small, blocking or needing manager permissions
    expect(p).toMatch(/The default is to delegate; assign a task to yourself/);
    expect(p).toMatch(/small, blocking, or needs your manager permissions/);
    expect(p).toMatch(/lands back in this in-tray/);
    expect(p).toMatch(/One rollup per day, or sooner on escalation/);
    expect(p).not.toMatch(/never your own next session/);
    const block = managerIntrayBlock(world, b, world.agents.first("name = 'Mei'")!.id);
    expect(block).toMatch(/Your own work reports .* land here too/);
  });
});

describe("workshop code-access rules", () => {
  it("forbid force-pushes and history rewrites, but not pushing to the base branch", () => {
    const p = workshopPrompt({ dir: "/home/agent/work/agent-town", branch: "agent/root/x", base: "main" }, "agent-town");
    expect(p).toContain("- Never force-push, never rewrite history, never run destructive commands.");
    expect(p).not.toContain("Never push to main");
  });
});

describe("meeting prompts (docs/meetings.md §3.3, §3.5)", () => {
  const meeting = { id: "mt_1", kind: "standup", title: "Lab standup", agenda: "", brings: { mode: "status", text: "" }, askHumans: false, attendeeIds: ["ag_1"], summaries: {}, transcript: [], decisions: [] } as unknown as Meeting;
  it("a reply turn is told its tools (read, search, speak) and the meeting id; no 'no tools' line", () => {
    const sys = meetingReplySystemPrompt(agent);
    expect(sys).not.toContain("no tools");
    expect(sys).toContain("`read`");
    expect(sys).toContain("`search`");
    expect(sys).toContain("action \"speak\"");
    expect(meetingReplyPrompt(meeting, () => "Root", { assignment: undefined, lastReport: undefined, events: [] })).toContain("meetingId mt_1");
  });
  it("a facilitation that starts over a non-empty transcript says it is picking up after a restart", () => {
    expect(facilitatePrompt(meeting, () => "Root")).not.toContain("picking up after a restart");
    const resumed = { ...meeting, transcript: [{ speakerId: "ag_1", speakerKind: "agent", text: "Agenda: x", at: "2026-10-24T00:00:00.000Z" }] } as unknown as Meeting;
    expect(facilitatePrompt(resumed, () => "Root")).toContain("picking up after a restart");
  });
});
