import { describe, expect, it, vi } from "vitest";
import type { Agent, Building, Meeting, Town } from "@muster-town/schema";
import { facilitatePrompt, managePrompt, managerIntrayBlock, managerStateBlock, managerSystemPrompt, meetingReplyPrompt, meetingReplySystemPrompt, REPORT_FORMAT, sessionMemory, summarySystemPrompt, workshopPrompt, workSystemPrompt } from "../src/prompts.ts";
import { composeWorkBrief, createBuilding, createResident, forkManager, TOWN_HALL_ID, updateBuilding } from "../src/index.ts";
import { REPO_ROOT, seededWorld, musterWorld } from "./helpers.ts";

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
    // work routing (1:1 mt_lsyqj98z0w): every task goes to the building; the manager never runs a work session
    expect(p).toMatch(/Every task goes to the building: you never run a work session/);
    expect(p).toMatch(/arrive as in-tray rows/);
    expect(p).not.toMatch(/assign a task to yourself/);
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
    const p = workshopPrompt({ dir: "/home/agent/work/agent-town", base: "main" }, "agent-town");
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

describe("a work session's prompt is split for the provider's cache (gr_9kt5t7w51w, kr_9jf2lzz98p)", () => {
  /** A forks-on building with code access, a manager Pix, a topic page, a town board FYI. */
  function forky() {
    const s = seededWorld();
    const { world, seed } = s;
    world.town.set({ workspace: { path: REPO_ROOT, repoUrl: "git@github.com:me/agent-town.git", base: "main", branchPrefix: "agent", tools: [] } });
    world.setTownDefaults({ codeAccess: true });
    const b = createBuilding(world, { name: "Forky", headcount: 3, dailyTokensPerAgent: 100_000, model: "claude-opus-5-5", cheapModel: "claude-haiku-5-5" }, seed.admin.id);
    const pix = createResident(world, { buildingId: b.id, name: "Pix" });
    updateBuilding(world, b.id, { managerAgentId: pix.id });
    world.budget.donate(seed.admin.id, { tokens: 1_000_000, buildingId: b.id });
    const agent = (id: string) => world.agents.require(id);
    const write = (input: { title: string; body: string; type?: "wiki" | "log"; topicOf?: string }) => world.verbs.write(agent(pix.id), { type: "wiki", state: "draft", ...input });
    const fork = async (title: string, extra: Record<string, unknown>) => {
      const { assignmentId } = await world.verbs.assign(agent(pix.id), { title, description: `Do ${title}.`, ...extra });
      const { fork: f } = forkManager(world, b.id, assignmentId);
      return world.ops.startSession(f.id, { purpose: "work", model: "m", assignmentId });
    };
    return { ...s, b, pix: agent(pix.id), agent, write, fork };
  }

  it("two forks of one building with different assignments, pages, lanes and branches get a byte-identical system prompt; the first message carries the clock, then the state", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { world, b, pix, write, fork, admin } = forky();
      vi.setSystemTime(Date.parse("2026-11-05T21:00:00Z"));
      const page1 = (await write({ title: "The Bank", body: "Bank page: counts adjusted tokens.", topicOf: b.id })).id;
      await write({ title: "How Mitchell likes things", body: "Short answers, wiki v1." });
      await write({ type: "log", title: "log", body: "decided X" });
      const s1 = await fork("Fix the HUD", { gap: "the HUD is wrong", pages: [page1] });
      const one = composeWorkBrief(world, s1.id);

      // between the two: the clock, the manager's wiki and log, a new topic page, a town-wide FYI
      vi.setSystemTime(Date.parse("2026-11-05T21:40:00Z"));
      await write({ title: "How Mitchell likes things", body: "Short answers, wiki v2." });
      await write({ type: "log", title: "log", body: "decided Y" });
      const page2 = (await write({ title: "Desk image", body: "Desk page: ffmpeg is in the image.", topicOf: b.id })).id;
      await world.verbs.write(admin, { type: "fyi", state: "building", buildingId: TOWN_HALL_ID, title: "Town rule", body: "No redeploy after a merge." });
      const s2 = await fork("Write the Bank tab", { gap: "no Bank tab", pages: [page2] });
      const two = composeWorkBrief(world, s2.id);

      expect(one.agent.id).not.toBe(two.agent.id);
      expect(one.workspace!.branch).not.toBe(two.workspace!.branch);
      expect(two.system).toBe(one.system);
      // nothing per fork or live in it
      for (const x of [one, two]) {
        expect(x.system).toContain(`You are a fork of Pix, the manager of the Forky`);
        expect(x.system).not.toContain(x.agent.name);
        expect(x.system).not.toContain(x.agent.id);
        expect(x.system).not.toContain(x.workspace!.branch);
        expect(x.system).not.toMatch(/Clock: it is|This session:|wiki v[12]|decided [XY]|Bank page|Desk page|## Your branch|Town-wide FYIs|No redeploy after a merge/);
        expect(x.system).toContain("## Code access");
        expect(x.system).toContain(`Your building id: ${b.id}`);
      }
      // the first message: the clock first, then the state (who, lane, memory, branch), then the assignment
      expect(one.prompt.startsWith("Clock: it is 2026-11-05 21:00 UTC")).toBe(true);
      expect(two.prompt.startsWith("Clock: it is 2026-11-05 21:40 UTC")).toBe(true);
      const at = (s: string) => two.prompt.indexOf(s);
      expect(at(`You are ${two.agent.name} (agent id ${two.agent.id}), a fork of Pix.`)).toBeGreaterThan(0);
      expect(at(", exploration on gap: no Bank tab")).toBeGreaterThan(at("You are "));
      expect(at("## What Pix knows")).toBeGreaterThan(at("This session:"));
      expect(two.prompt).toContain("wiki v2");
      expect(two.prompt).toContain("Desk page: ffmpeg");
      expect(two.prompt).toContain("## Pix's log");
      expect(two.prompt).toContain("No redeploy after a merge.");
      expect(one.prompt).not.toContain("No redeploy after a merge.");
      expect(at(`## Your branch\nYour checkout at /home/agent/work/agent-town is on branch \`${two.workspace!.branch}\``)).toBeGreaterThan(at("## Pix's log"));
      expect(at("Your assignment (")).toBeGreaterThan(at("## Your branch"));
      expect(one.prompt).toContain("wiki v1");
      expect(one.prompt).toContain(", exploration on gap: the HUD is wrong");
      void pix;
    } finally { vi.useRealTimers(); }
  });

  it("the session's job, rule and pocket (plan dc_uwx045472m step 4) are in the first message; the system prompt only explains jobs", async () => {
    const { world, fork } = forky();
    const s1 = await fork("Fix the HUD", { gap: "the HUD is wrong" });
    const s2 = await fork("Write the Bank tab", { gap: "no Bank tab" });
    const one = composeWorkBrief(world, s1.id);
    const two = composeWorkBrief(world, s2.id);
    expect(two.system).toBe(one.system);
    expect(one.system).toContain("your report is also filed as one entry on that job's thread");
    for (const x of [one, two]) {
      const a = world.assignments.require(world.sessions.require(x === one ? s1.id : s2.id).assignmentId!);
      const line = `This session: job jb_${a.chainId} (rule chunk), exploration on gap: ${a.gap}`;
      expect(x.prompt).toContain(line);
      expect(x.system).not.toContain(`jb_${a.chainId}`);
    }
  });

  it("two work sessions of one manager get a byte-identical system prompt; the in-tray, team, grants, board and the wiki index are in the first message", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { world, b, pix, write } = forky();
      vi.setSystemTime(Date.parse("2026-11-05T21:00:00Z"));
      await write({ title: "The sink", body: "The ocean sink is 2.4 GtC/yr." });
      const a1 = world.ops.createWork(null, pix.id, { title: "Grant x funded" });
      const one = composeWorkBrief(world, world.ops.startSession(pix.id, { purpose: "work", model: "m", assignmentId: a1.id }).id);
      world.ops.endSession(one.session.id, { status: "done" });
      vi.setSystemTime(Date.parse("2026-11-05T21:30:00Z"));
      await write({ title: "The sink", body: "The ocean sink is 2.6 GtC/yr." });
      const a2 = world.ops.createWork(null, pix.id, { title: "Write the checkpoint for y" });
      const two = composeWorkBrief(world, world.ops.startSession(pix.id, { purpose: "work", model: "m", assignmentId: a2.id }).id);
      expect(two.system).toBe(one.system);
      expect(two.system).toContain(`You are Pix, a resident of the Forky`);
      expect(two.system).toContain("Working the in-tray.");
      expect(two.system).not.toMatch(/Clock: it is|## Your in-tray \(you work it|## Your team|GtC|## Your branch|This session:/);
      expect(two.prompt.startsWith("Clock: it is 2026-11-05 21:30 UTC")).toBe(true);
      const at = (s: string) => two.prompt.indexOf(s);
      expect(at("## Your in-tray (you work it")).toBeGreaterThan(0);
      expect(at("## Your team")).toBeGreaterThan(at("## Your in-tray"));
      expect(at("## Grants (this building is goal-directed)")).toBeGreaterThan(at("## Your team"));
      // the wiki as an index, never the page
      expect(two.prompt).toMatch(/- "The sink" \(dc_[a-z0-9]+, .*\): The ocean sink is 2\.6 GtC\/yr/);
      expect(two.prompt).not.toContain("### The sink");
      expect(at("Your assignment (")).toBeGreaterThan(at("## Your wiki"));
    } finally { vi.useRealTimers(); }
  });
});
