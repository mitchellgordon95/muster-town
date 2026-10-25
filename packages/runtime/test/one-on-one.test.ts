import { describe, expect, test } from "vitest";
import { intrayOf } from "@muster-town/core";
import { callVerb, init, result, setup, type Script } from "./helpers.ts";

const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5)); expect(ok()).toBe(true); };

async function managed(script: Script) {
  const env = setup(script);
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
});
