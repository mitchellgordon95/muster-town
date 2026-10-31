import { describe, expect, test, vi } from "vitest";
import { intrayOf } from "@muster-town/core";
import { HostBackend, startRuntime, type CmdResult, type CommandRunner, type RuntimeOptions } from "../src/index.ts";
import { drainNudgeOneOnOne } from "../src/redeploy.ts";
import { callVerb, deferred, fakeSdk, init, result, setup, type Script } from "./helpers.ts";

const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5)); expect(ok()).toBe(true); };

async function managed(script: Script, extra: Partial<RuntimeOptions> = {}) {
  const env = setup(script, extra);
  const admin = env.world.ops.ensureAvatar(env.seed.admin.id);
  for (const d of intrayOf(env.world, env.lab.id)) await env.world.verbs.review(admin.id, { docId: d.id, decision: "approve" });
  env.world.ops.updateBuilding(admin, env.lab.id, { managerAgentId: env.by("Mei").id });
  return { ...env, admin };
}

describe("the manager's 1:1", () => {
  test("opening it starts the manager's session; the human's lines stream in; decisions become assignments; ending it ends the session", async () => {
    const env = await managed(async function* (s) {
      yield init();
      const mid = s.received[0].match(/(mt_[a-z0-9]+)/)![1];
      yield* callVerb(s, "meeting", { meetingId: mid, action: "speak", text: "Hi. What do you need?" });
      yield result(100, 0.01); // turn over: the session stays open while the 1:1 is
      const said = await s.next();
      expect(said).toContain("Can Noor pull SOCAT 2025?");
      yield* callVerb(s, "meeting", { meetingId: mid, action: "speak", text: "Yes, assigning it." });
      yield* callVerb(s, "meeting", { meetingId: mid, action: "decide", decisions: [{ text: "Noor: pull SOCAT 2025", assigneeId: s.world.agents.first("name = 'Noor'")!.id }] });
      yield result(200, 0.02);
      const over = await s.next();
      expect(over).toContain("is over");
      yield result(250, 0.03);
    });
    const { world, runtime, sdk, by, lab, admin } = env;
    const mei = by("Mei"), noor = by("Noor");
    const m = world.ops.openOneOnOne(admin, lab.id);
    await until(() => world.meetings.require(m.id).transcript.length === 1);
    expect(sdk.sessions).toHaveLength(1);
    expect(sdk.sessions[0].received[0]).toContain(m.id);
    const live = world.sessions.first("agentId = ? AND status = 'running'", [mei.id])!;
    expect(live).toMatchObject({ purpose: "manage", meetingId: m.id });
    expect(runtime.isWorking(mei.id)).toBe(true);

    world.ops.meetingSay(admin, m.id, "Can Noor pull SOCAT 2025?");
    await until(() => world.meetings.require(m.id).decisions.length === 1);
    const a = world.assignments.require(world.meetings.require(m.id).decisions[0].assignmentId!);
    expect(a).toMatchObject({ agentId: noor.id, fromMeetingId: m.id });
    expect(world.sessions.require(live.id).status).toBe("running"); // still open between turns

    world.ops.endMeeting(admin, m.id);
    await runtime.whenIdle();
    expect(sdk.sessions).toHaveLength(1);
    expect(world.sessions.require(live.id)).toMatchObject({ status: "done", reportId: null });
    expect(world.meetings.require(m.id).notesDocId).not.toBeNull();
    expect(world.agents.require(mei.id).status).toBe("idle");
  });

  test("Plan with an agent: the Planner answers its Town Hall 1:1 with the tree brief in its prompt and proposes for no building", async () => {
    const env = await managed(async function* (s) {
      yield init();
      const mid = s.received[0].match(/(mt_[a-z0-9]+)/)![1];
      expect(s.received[0]).toContain("You are the Planner");
      yield* callVerb(s, "propose_goal", { action: "add-goal", parentId: "gl_join", text: "Strangers finish a task", why: "asked in the 1:1" });
      yield* callVerb(s, "meeting", { meetingId: mid, action: "speak", text: "Drafted one proposal." });
      yield result(100, 0.01);
      expect(await s.next()).toContain("is over");
      yield result(150, 0.02);
    });
    const { world, runtime, sdk, admin } = env;
    // the Town Hall draws nothing from the Bank: an allocation of its own pays the Planner
    world.budget.donate(env.seed.admin.id, { tokens: 1_000_000, buildingId: "town-hall", auth: "api-key" });
    const m = world.reorgs.openPlanner(admin, "gl_join");
    const planner = world.reorgs.planner()!;
    await until(() => world.meetings.require(m.id).transcript.length === 2);
    expect(sdk.sessions).toHaveLength(1);
    expect(world.sessions.first("agentId = ? AND status = 'running'", [planner.id])).toMatchObject({ purpose: "manage", meetingId: m.id });
    expect(world.goalProposals.first("proposedBy = ?", [planner.id])).toMatchObject({ buildingId: null, status: "open" });
    world.ops.endMeeting(admin, m.id);
    await runtime.whenIdle();
    expect(world.agents.require(planner.id).status).toBe("idle");
  });

  test("a report's Talk to <author>: the resident author answers its own 1:1 (report id in its prompt) and the session ends with it", async () => {
    const env = await managed(async function* (s) {
      yield init();
      const mid = s.received[0].match(/(mt_[a-z0-9]+)/)![1];
      yield* callVerb(s, "meeting", { meetingId: mid, action: "speak", text: "Sure, ask away." });
      yield result(100, 0.01);
      expect(await s.next()).toContain("is over");
      yield result(150, 0.02);
    });
    const { world, runtime, sdk, by, lab, admin } = env;
    const noor = by("Noor");
    const { id } = await world.verbs.submit_report(noor, { title: "Ocean sink", body: "## Findings\n2.9 GtC/yr", verdict: "continue" });
    await runtime.whenIdle(); // the manager's in-tray session over the new report
    const before = sdk.sessions.length;
    const m = world.ops.openOneOnOne(admin, lab.id, { agentId: noor.id, docId: id });
    await until(() => world.meetings.require(m.id).transcript.length === 2);
    const s = sdk.sessions[before];
    expect(s.received[0]).toContain(m.id);
    expect(s.received[0]).toContain(id);
    expect(world.sessions.first("agentId = ? AND status = 'running'", [noor.id])).toMatchObject({ purpose: "manage", meetingId: m.id });
    world.ops.endMeeting(admin, m.id);
    await runtime.whenIdle();
    expect(world.sessions.first("agentId = ? AND meetingId = ?", [noor.id, m.id])).toMatchObject({ status: "done" });
    expect(world.agents.require(noor.id).status).toBe("idle");
  });

  test("a busy manager waits for the next tick; a quiet 1:1 is closed by the town", async () => {
    const env = await managed(async function* (s) { yield init(); yield result(100, 0.01); await s.next(); yield result(50, 0.01); });
    const { world, runtime, sdk, by, lab, admin, clock } = env;
    const mei = by("Mei");
    world.setStatus(mei.id, "working");
    const m = world.ops.openOneOnOne(admin, lab.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(sdk.sessions).toHaveLength(0);
    world.setStatus(mei.id, "idle");
    await runtime.tickOnce();
    await until(() => sdk.sessions.length === 1);
    clock.t = Date.now() + 21 * 60_000; // meeting timestamps are wall-clock
    await runtime.tickOnce();
    await runtime.whenIdle();
    expect(world.meetings.require(m.id).phase).toBe("done");
    expect(world.sessions.first("agentId = ? AND purpose = 'manage'", [mei.id])).toMatchObject({ status: "done" });
  });

  test("an agent busy in a work session: the 1:1 says why it's silent, isn't closed as quiet, and is answered once the work ends", async () => {
    const work = deferred();
    const env = await managed(async function* (s) {
      yield init();
      if (s.agentId !== s.world.agents.first("name = 'Noor'")!.id) { yield result(50, 0.01); return; } // Mei's in-tray
      const mid = s.received[0].match(/(mt_[a-z0-9]+)/)?.[1];
      if (!mid || !s.received[0].includes("1:1")) { await work.promise; yield* callVerb(s, "submit_report", { title: "Done", body: "## Findings\nok", verdict: "stop" }); yield result(100, 0.01); return; }
      yield* callVerb(s, "meeting", { meetingId: mid, action: "speak", text: "Sorry, I was busy. Here now." });
      yield result(100, 0.01);
      expect(await s.next()).toContain("is over");
      yield result(150, 0.02);
    });
    const { world, runtime, sdk, by, lab, admin, clock } = env;
    const noor = by("Noor");
    const asg = world.ops.createWork(null, noor.id, { title: "Measure the growth rate" });
    const running = runtime.runWorkSession(noor.id, asg.id);
    await until(() => sdk.sessions.length === 1);
    const m = world.ops.openOneOnOne(admin, lab.id, { agentId: noor.id });
    world.ops.meetingSay(admin, m.id, "hello?");
    await until(() => world.meetings.require(m.id).transcript.some((u) => u.speakerKind === "system"));
    await runtime.tickOnce();
    const notices = world.meetings.require(m.id).transcript.filter((u) => u.speakerKind === "system");
    expect(notices).toHaveLength(1); // once per busy session, not per wake
    expect(notices[0].text).toContain('Noor is in a work session ("Measure the growth rate") and answers here when it ends.');
    const noorSessions = () => sdk.sessions.filter((x) => x.agentId === noor.id).length;
    expect(noorSessions()).toBe(1); // only the work session: the 1:1 waits for it
    clock.t = Date.now() + 21 * 60_000;
    await runtime.tickOnce();
    expect(world.meetings.require(m.id).phase).toBe("discussing"); // the human's line still waits on Noor
    clock.t = Date.now(); // session start times are wall-clock too
    work.resolve();
    await running;
    await runtime.tickOnce();
    await until(() => world.meetings.require(m.id).transcript.some((u) => u.speakerId === noor.id));
    world.ops.endMeeting(admin, m.id);
    await runtime.whenIdle();
  });

  test("a redeploy doesn't silence the 1:1: the manager keeps answering, the restart posts a notice, and a new session answers what it missed", async () => {
    const ok = (stdout = ""): CmdResult => ({ code: 0, stdout, stderr: "" });
    const run: CommandRunner = async (cmd, args) => ok([cmd, ...args].join(" ").startsWith("git rev-parse HEAD") ? "abc1234def\n" : args[0] === "rev-list" ? "0\n" : "");
    const exit = vi.fn();
    const env = await managed(async function* (s) {
      yield init();
      const mid = s.received[0].match(/(mt_[a-z0-9]+)/)![1];
      yield* callVerb(s, "meeting", { meetingId: mid, action: "speak", text: "Hi. What do you need?" });
      yield result(100, 0.01);
      expect(await s.next()).toBe(drainNudgeOneOnOne()); // told to keep answering, not to wrap up
      yield result(110, 0.01);
      expect(await s.next()).toContain("Still there?");
      yield* callVerb(s, "meeting", { meetingId: mid, action: "speak", text: "Yes, still here." });
      yield result(120, 0.01);
      await s.next(); // the restart cuts the session here
    }, { repoRoot: "/repo", redeploy: { run, exit, exitDelayMs: 1, drainPollMs: 1, drainMeetingMs: 300, drainTimeoutMs: 60_000 } });
    const { world, runtime, by, lab, admin } = env;
    const mei = by("Mei");
    const m = world.ops.openOneOnOne(admin, lab.id);
    await until(() => world.meetings.require(m.id).transcript.length === 1);

    expect(runtime.redeploy({ image: false, requestedBy: "Pix" })).toEqual({ started: true });
    await until(() => env.sdk.sessions[0].received.length === 2); // the nudge
    world.ops.meetingSay(admin, m.id, "Still there?"); // during the drain: still answered
    await until(() => world.meetings.require(m.id).transcript.some((u) => u.text === "Yes, still here."));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(75), { timeout: 3000 }); // the drain didn't wait for the 1:1 to end
    const notice = world.meetings.require(m.id).transcript.at(-1)!;
    expect(notice).toMatchObject({ speakerId: "system", speakerKind: "system", text: "Mei's reply is waiting on a redeploy (commit abc1234); the server is restarting and the meeting resumes after the restart." });
    world.ops.meetingSay(admin, m.id, "Also, can Noor pull SOCAT?"); // spoken while the server restarts
    await runtime.stop();

    // the restarted server: the orphaned session is reconciled, the open 1:1 wakes the manager with what it missed
    world.ops.reconcile([]);
    let prompt = "";
    const sdk2 = fakeSdk(world, async function* (s) {
      prompt = s.received[0];
      yield init();
      yield* callVerb(s, "meeting", { meetingId: m.id, action: "speak", text: "Back after the restart: yes, assigning Noor." });
      yield result(100, 0.01);
      await s.next();
    });
    const runtime2 = startRuntime({ world, mcpUrl: "http://127.0.0.1:4321/mcp", sdk: sdk2, intervalMs: 0, exportDir: false, deskBackend: new HostBackend() });
    await runtime2.tickOnce();
    await until(() => world.meetings.require(m.id).transcript.at(-1)!.text.startsWith("Back after the restart"));
    expect(prompt).toContain("still unanswered:\n- ");
    expect(prompt).toContain("Also, can Noor pull SOCAT?");
    expect(prompt.split("still unanswered")[1]).not.toContain("Still there?"); // only lines after its last reply count as missed
    expect(world.sessions.first("agentId = ? AND status = 'running'", [mei.id])).toMatchObject({ purpose: "manage", meetingId: m.id });
    await runtime2.stop();
  });
});
