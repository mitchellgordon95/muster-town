import { describe, expect, it } from "vitest";
import type { Agent, Building, Meeting, Town } from "@muster-town/schema";
import { facilitatePrompt, managePrompt, managerIntrayBlock, managerStateBlock, managerSystemPrompt, meetingReplyPrompt, meetingReplySystemPrompt, REPORT_FORMAT, sessionMemory, summarySystemPrompt, workshopPrompt, workSystemPrompt } from "../src/prompts.ts";
import { seededWorld, musterWorld } from "./helpers.ts";

describe("the team-lead prompt is split for the provider's cache (docs/prompt-caching.md)", () => {
  it("the system prompt is byte-identical across wakes, whatever the clock, in-tray or wiki did meanwhile; the state block carries all of that, clock first", async () => {
    const { world, by, admin } = seededWorld();
    const mei = by("Mei");
    const b = world.ops.updateBuilding(admin, "carbon-cycle", { managerAgentId: mei.id });
    const t = world.town.get();
    const opts = { purpose: "Measure the sink", buildings: "Other buildings: none.", skills: "## Skills\n- none", code: true };
    const before = managerSystemPrompt(mei, b, t, opts);
    const r = await world.verbs.submit_report(by("Noor"), { title: "Ocean sink 2024", body: "## What I did\nx\n## Findings\ny\n## What I need from you\nMerge PR #12.", verdict: "stop" });
    await world.verbs.write(mei, { type: "wiki", title: "The sink", body: "The ocean sink is 2.4 GtC/yr; see dc_x." });
    const after = managerSystemPrompt(mei, b, t, opts);
    expect(after).toBe(before);
    // nothing live in it: no clock, no report ids, no wiki body, no commit
    expect(after).not.toMatch(/Clock: it is/);
    expect(after).not.toContain(r.id);
    expect(after).not.toContain("2.4 GtC/yr");
    expect(after).not.toContain("## Your in-tray (you work it");
    // what it does carry: the fixed rules (decide, rollup format) and the pointer to the first message
    expect(after).toContain("Working the in-tray.");
    expect(after).toMatch(/rollup: true/);
    expect(after).toContain("opens the first message");
    expect(after).toContain("Read, Grep and Glob");

    const now = Date.parse("2026-11-02T20:00:00Z");
    const state = managerStateBlock(world, mei, b, { now });
    expect(state.startsWith("Clock: it is 2026-11-02 20:00 UTC")).toBe(true);
    expect(state).toContain(`${r.id} "Ocean sink 2024" by Noor (verdict stop`);
    expect(state).toContain("Last rollup: never; reports decided since: 0");
    expect(state).toContain("## Your team (you are the manager of");
    expect(state).toContain("## Grants (this building is goal-directed)");
    // the wiki as an index (title, id, gist), never the page; the pages are `read` on demand
    expect(state).toMatch(/## Your wiki \(`read` the pages that matter/);
    expect(state).toMatch(/- "The sink" \(dc_[a-z0-9]+, .*\): The ocean sink is 2\.4 GtC\/yr/);
    expect(state).not.toContain("### The sink");
    expect(state).toContain("## Your log");
    // the in-tray comes before the memory, so the first doc id in the message is a report, not a wiki page
    expect(state.indexOf("## Your in-tray")).toBeLessThan(state.indexOf("## Your wiki"));
    expect(state.indexOf(r.id)).toBeLessThan(state.indexOf("The sink"));
  });
});

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
  it("the rollup rule is 'something new is live and decided, at least 4 h apart' and names the live commit (1:1 mt_7mhv73quu3)", async () => {
    const { world, by, admin } = musterWorld();
    const mei = by("Mei");
    const b = world.ops.updateBuilding(admin, "carbon-cycle", { managerAgentId: mei.id });
    const now = Date.parse("2026-10-31T12:00:00Z");
    expect(managerIntrayBlock(world, b, mei.id, now)).toContain("Live: unknown (no runtime).");
    world.host.commit = "fa73e88aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    world.host.startedAt = "2026-10-31T07:12:00.000Z";
    const block = managerIntrayBlock(world, b, mei.id, now);
    expect(block).toMatch(/Roll up when something new is live .* and the reports that cover it are decided, or when a covered report hit an escalation criterion; keep at least 4 h since your last rollup/);
    expect(block).not.toMatch(/24 h/);
    expect(block).toContain("Live: fa73e88 since 2026-10-31 07:12 UTC (4 h ago) (no rollup yet).");
    const prov = { sourceIds: [(await world.verbs.submit_report(by("Noor"), { title: "x", body: "## What I did\nx", verdict: "stop" })).id], urls: [] };
    await world.verbs.submit_report(mei, { title: "Rollup", body: "## Shipped\nNone.\n## Decided\nx\n## Key results\nx\n## Needs from Mitchell\nNothing needed.", verdict: "stop", rollup: true, provenance: prov });
    expect(managerIntrayBlock(world, b, mei.id, now)).toContain("(already live at your last rollup).");
    world.host.startedAt = new Date(Date.now() + 60_000).toISOString();
    expect(managerIntrayBlock(world, b, mei.id, now)).toContain("(newer than your last rollup).");
  }, 30_000);
  it("the team-lead session prompt keeps the manager to decisions and rollups: every task becomes an assignment, independent ones on forks in parallel, no reassign", () => {
    const { world } = seededWorld();
    const b = world.buildings.get("carbon-cycle")!;
    const p = managePrompt(b, [], (id) => world.nameOf(id));
    expect(p).toMatch(/A manager does only decisions and rollups/);
    expect(p).toMatch(/becomes an assignment the moment it appears/);
    expect(p).toMatch(/run on forks in parallel/);
    expect(p).not.toMatch(/reassign/);
    // town hall 2026-10-25, decision 6: delegate by default, self-assign when small, blocking or needing manager permissions
    expect(p).toMatch(/The default is to delegate; assign a task to yourself/);
    expect(p).toMatch(/small, blocking, or needs your manager permissions/);
    expect(p).toMatch(/lands back in this in-tray/);
    expect(p).toMatch(/Roll up when something new is live and decided \(at least 4 h apart\), or sooner on escalation/);
    expect(p).not.toMatch(/One rollup per day/);
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
