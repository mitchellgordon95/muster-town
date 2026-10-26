import { describe, expect, test, vi } from "vitest";
import { intrayOf } from "@muster-town/core";
import { HostBackend, startRuntime, type CmdResult, type CommandRunner, type RuntimeOptions } from "../src/index.ts";
import { drainNudgeOneOnOne } from "../src/redeploy.ts";
import { callVerb, fakeSdk, init, result, setup, type Script } from "./helpers.ts";

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
