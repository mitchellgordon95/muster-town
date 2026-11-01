import { ROOT_GOAL_ID } from "@muster-town/schema";
/** Manager forks step 2 (dc_mymt27yz25 §2, §5.3): the scheduler spawns forks from the building queue, retires them at session end, routes messages. */
import { describe, expect, test, vi } from "vitest";
import { buildingQueue, updateBuilding } from "@muster-town/core";
import type { DeskBackend } from "../src/index.ts";
import { callVerb, creditBank, init, result, setup, type FakeSession } from "./helpers.ts";

const REPORT = { title: "Done", verdict: "stop", body: "## What I did\nIt.\n\n## Findings\nThe plan: step A then B.\n\n## What I need from you\nNothing needed." };

/** The seeded lab with Mei as manager, room for two forks. */
function forkSetup(script: (s: FakeSession) => AsyncGenerator<unknown, void, unknown>, opts: { spare?: number; backend?: DeskBackend } = {}) {
  let meiId = "";
  // the manager's own sessions (woken by its forks' reports) just end
  const t = setup(async function* (s) {
    if (s.agentId === meiId) { yield init(); yield result(1, 0); return; }
    yield* script(s);
  }, opts.backend ? { deskBackend: opts.backend } : {});
  const { world, lab, by } = t;
  const mei = by("Mei");
  meiId = mei.id;
  updateBuilding(world, lab.id, { managerAgentId: mei.id });
  const b = world.buildings.require(lab.id);
  // labs are lane-gated: queued exploration needs free tokens
  creditBank(world);
  world.buildings.upsert({ ...b, headcount: world.layout.deskCount(lab.id) + (opts.spare ?? 2) });
  const queue = async (title: string, extra: Record<string, unknown> = {}) =>
    (await world.verbs.assign(world.agents.require(mei.id), { title, description: "Do it.", gap: "test gap", ...extra })).assignmentId;
  return { ...t, mei, queue };
}

async function pass(runtime: { tickOnce(): Promise<void>; whenIdle(): Promise<void> }) {
  await runtime.tickOnce();
  await runtime.whenIdle();
}

describe("manager forks: spawn and retire", () => {
  test("building-queue work runs as a fork of the manager at a free desk; the fork retires after its report and frees the desk", async () => {
    const { world, runtime, sdk, mei, lab, queue } = forkSetup(async function* (s) {
      yield init();
      yield* callVerb(s, "submit_report", REPORT);
      yield result(100, 0.01);
    });
    const desks = world.layout.deskCount(lab.id);
    const a = await queue("Fix the thing");
    await pass(runtime);
    const forked = world.events.recent({ limit: 200 }).find((e) => e.type === "agent.forked")!;
    expect(forked.text).toMatch(/^Mei forked Mei 1 for "Fix the thing" at desk \d+$/);
    const forkId = forked.agentId!;
    const s = world.sessions.first("agentId = ? AND purpose = 'work'", [forkId])!;
    expect(s).toMatchObject({ assignmentId: a, status: "done" });
    // the prompt carries the chain block, not "Your previous report"
    const prompt0 = sdk.sessions.find((x) => x.agentId === forkId)!.received[0];
    expect(prompt0).toContain("This is the first session on this work");
    expect(prompt0).not.toContain("Your previous report");
    expect(world.assignments.require(a)).toMatchObject({ status: "done", agentId: forkId });
    expect(world.agents.require(forkId)).toMatchObject({ status: "retired", name: "Mei 1", forkOf: mei.id });
    expect(world.layout.deskCount(lab.id)).toBe(desks);
    const retired = world.events.recent({ limit: 200 }).find((e) => e.type === "agent.retired" && e.agentId === forkId)!;
    expect(retired.payload).toMatchObject({ reportId: s.reportId });
    // session events say whose fork it is; the manager itself never ran it
    expect(world.events.recent({ limit: 200 }).find((e) => e.type === "session.started" && e.agentId === forkId)?.payload).toMatchObject({ forkOf: mei.id });
    expect(world.sessions.count("agentId = ? AND purpose = 'work'", [mei.id])).toBe(0);
  });

  test("forks stop at the free desks; the rest waits on the building queue and runs once a desk frees up", async () => {
    const { world, runtime, lab, queue } = forkSetup(async function* (s) {
      yield init();
      yield* callVerb(s, "submit_report", REPORT);
      yield result(100, 0.01);
    }, { spare: 1 });
    const a1 = await queue("One"), a2 = await queue("Two");
    await runtime.tickOnce();
    // one spare desk: one fork, the second assignment still queued
    expect(world.events.recent({ limit: 200 }).filter((e) => e.type === "agent.forked")).toHaveLength(1);
    expect(buildingQueue(world, lab.id).map((a) => a.id)).toEqual([a2]);
    await runtime.whenIdle();
    await pass(runtime);
    expect(world.assignments.require(a1).status).toBe("done");
    expect(world.assignments.require(a2).status).toBe("done");
    // the name is reused: the lowest n no live fork holds
    expect(world.events.recent({ limit: 200 }).filter((e) => e.type === "agent.forked").map((e) => e.text).sort()).toEqual([
      expect.stringContaining('Mei 1 for "One"'), expect.stringContaining('Mei 1 for "Two"'),
    ]);
  });

  test("named residents' own work runs as before, not as a fork", async () => {
    const { world, runtime, by } = forkSetup(async function* (s) {
      yield init();
      yield* callVerb(s, "submit_report", REPORT);
      yield result(100, 0.01);
    });
    world.ops.createWork(null, by("Noor").id, { title: "Named" });
    await pass(runtime);
    expect(world.events.recent({ limit: 200 }).some((e) => e.type === "agent.forked")).toBe(false);
    expect(world.sessions.count("agentId = ? AND purpose = 'work' AND status = 'done'", [by("Noor").id])).toBe(1);
  });

  test("a park goes back on the building queue on the same chain; a new fork picks it up with the previous report in full", async () => {
    const { world, runtime, sdk, clock, lab, queue } = forkSetup(async function* (s) {
      yield init();
      if (s.received[0].includes("Long job")) {
        yield* callVerb(s, "submit_report", { ...REPORT, title: "Parked", verdict: "continue", resumeWhen: { after: new Date(clock.t + 60_000).toISOString() }, next: "Finish it" });
      } else yield* callVerb(s, "submit_report", REPORT);
      yield result(100, 0.01);
    });
    const a = await queue("Long job");
    await pass(runtime);
    const first = world.agents.first("forkOf IS NOT NULL")!;
    expect(first.status).toBe("retired");
    const cont = buildingQueue(world, lab.id)[0];
    expect(cont).toMatchObject({ chainId: a, queue: "building", title: "Finish it" });
    expect(cont.waitFor).not.toBeNull();
    await pass(runtime);
    expect(world.sessions.count("assignmentId = ?", [cont.id])).toBe(0); // still waiting
    clock.t += 120_000;
    await pass(runtime);
    await pass(runtime);
    const s2 = world.sessions.first("assignmentId = ?", [cont.id])!;
    expect(s2.agentId).not.toBe(first.id);
    expect(world.agents.require(s2.agentId)).toMatchObject({ status: "retired", forkOf: first.forkOf });
    const prompt = sdk.sessions.find((x) => x.agentId === s2.agentId)!.received[0];
    expect(prompt).toContain(`This work continues chain ${a}`);
    expect(prompt).toContain('"Parked" by Mei 1');
    expect(prompt).toContain("The plan: step A then B.");
    expect(prompt).toContain("not only in a desk file");
  });

  test("a fork whose session never ends cleanly is retired by the sweep, and its work goes back on the building queue", async () => {
    const { world, runtime, lab, queue } = forkSetup(async function* () { yield init(); yield result(1, 0); });
    const a = await queue("Will be orphaned");
    const { forkManager } = await import("@muster-town/core");
    const { fork } = forkManager(world, lab.id, a); // as if spawned by a previous process that died before starting it
    await runtime.tickOnce();
    await runtime.whenIdle();
    expect(world.agents.require(fork.id).status).toBe("retired");
    // the next pass forks again for the requeued work
    await pass(runtime);
    expect(world.assignments.require(a).status).toBe("done");
  });
});

describe("manager forks: a stale desk slot (image redeploy kept it busy)", () => {
  test("the slot of a fork the sweep retires is removed before the next fork takes the same desk in that pass", async () => {
    const removed: string[] = [];
    const desk: DeskBackend = {
      kind: "docker",
      available: async () => true,
      ensure: async (a) => ({ name: `desk-${a.id}`, agentId: a.id }),
      // the next fork's session runs until the test ends
      exec: () => {
        let done!: (code: number) => void;
        const exited = new Promise<number>((r) => { done = r; });
        return { wait: () => exited, kill: () => done(143) };
      },
      remove: async () => {},
      removeSandbox: async (name: string) => { removed.push(name); },
    };
    const { world, runtime, lab, queue } = forkSetup(async function* () { yield init(); yield result(1, 0); }, { spare: 1, backend: desk });
    const a = await queue("Was running through the image redeploy");
    const { forkManager } = await import("@muster-town/core");
    // as if adopted after the restart: its session has ended, so this pass's sweep retires it, frees its desk and requeues its work
    const { fork, desk: n } = forkManager(world, lab.id, a);
    world.db.prepare("INSERT INTO stale_desks (key, buildingId, n, at) VALUES (?, ?, ?, ?)").run("desk-slot-stale", lab.id, n, new Date().toISOString());
    await runtime.tickOnce();
    expect(world.agents.require(fork.id).status).toBe("retired");
    // the next fork takes the same (only) desk in that pass
    const next = world.events.recent({ limit: 200 }).filter((e) => e.type === "agent.forked").at(-1)!;
    expect(next.agentId).not.toBe(fork.id);
    expect((next.payload as { desk: number }).desk).toBe(n);
    await vi.waitFor(() => expect(removed).toEqual(["desk-slot-stale"]));
    expect(world.db.prepare("SELECT COUNT(*) AS c FROM stale_desks").get()).toEqual({ c: 0 });
  });
  test("the manager's own desk is never kept busy: a stale row for its seat clears on the next pass (Nell ms_a6dshs7urq)", async () => {
    const removed: string[] = [];
    const desk: DeskBackend = {
      kind: "docker",
      available: async () => true,
      ensure: async (a) => ({ name: `desk-${a.id}`, agentId: a.id }),
      exec: () => ({ wait: async () => 0, kill: () => {} }),
      remove: async () => {},
      removeSandbox: async (name: string) => { removed.push(name); },
    };
    const { world, runtime, lab, mei } = forkSetup(async function* () { yield init(); yield result(1, 0); }, { backend: desk });
    const seat = world.db.prepare("SELECT n FROM desks WHERE agentId = ?").get(mei.id) as { n: number };
    world.db.prepare("INSERT INTO stale_desks (key, buildingId, n, at) VALUES (?, ?, ?, ?)").run("desk-slot-seat", lab.id, seat.n, new Date().toISOString());
    await runtime.tickOnce();
    await vi.waitFor(() => expect(removed).toEqual(["desk-slot-seat"]));
    expect(world.db.prepare("SELECT COUNT(*) AS c FROM stale_desks").get()).toEqual({ c: 0 });
  });
});



describe("manager forks: stop_fork (agent teams step 4)", () => {
  const stopEvents = (world: ReturnType<typeof forkSetup>["world"], forkId: string) =>
    world.events.list({ agentId: forkId, types: ["system"], payloadKey: "stopFork" }).map((e) => e.payload.stopFork);

  test("the manager asks a live fork to stop: it is interrupted, files its report and retires; no hard stop", async () => {
    let forkId = "";
    const { world, runtime, mei, clock, queue } = forkSetup(async function* (s) {
      yield init();
      forkId = s.agentId!;
      const got = await s.next();
      expect(got).toContain("Mei asks you to stop now: Mitchell changed plans");
      expect(got).toContain("submit_report");
      yield* callVerb(s, "submit_report", { ...REPORT, verdict: "continue" });
      yield result(100, 0.01);
    });
    const a = await queue("Long job");
    await runtime.tickOnce();
    for (let i = 0; i < 50 && !forkId; i++) await new Promise((r) => setTimeout(r, 10));
    // only someone with building.assign on the fork's building; not the fork itself
    const other = world.agents.where("kind = 'resident' AND status != 'retired' AND id NOT IN (?, ?)", [mei.id, forkId])[0]!;
    await expect(world.verbs.stop_fork(other.id, { forkId })).rejects.toThrow(/Only the manager/);
    await expect(world.verbs.stop_fork(forkId, { forkId })).rejects.toThrow(/stop yourself/);
    const r = await world.verbs.stop_fork(mei.id, { assignmentId: a, reason: "Mitchell changed plans" });
    expect(r.forkId).toBe(forkId);
    // asking twice keeps the first deadline and sends no second interrupt
    expect((await world.verbs.stop_fork(mei.id, { forkId })).deadline).toBe(r.deadline);
    expect(world.events.list({ agentId: forkId, types: ["system"] }).filter((e) => e.payload.interrupt)).toHaveLength(1);
    await runtime.whenIdle();
    expect(world.agents.require(forkId).status).toBe("retired");
    expect(world.assignments.require(a).status).toBe("done");
    const s = world.sessions.first("agentId = ? AND purpose = 'work'", [forkId])!;
    expect(world.docs.require(s.reportId!).title).toBe("Done");
    // past the deadline the tick finds nothing to stop
    clock.t = Date.parse(r.deadline) + 1000;
    await runtime.tickOnce();
    expect(stopEvents(world, forkId)).toEqual(["requested"]);
  });

  test("a fork that hasn't filed its report by the deadline is stopped hard: fallback report, assignment cancelled, retired", async () => {
    let forkId = "";
    const { world, runtime, mei, clock, queue } = forkSetup(async function* (s) {
      yield init();
      forkId = s.agentId!;
      await s.next(); // the stop request: ignored
      await vi.waitFor(() => { if (!s.interrupted || world.agents.require(forkId).status !== "stopped") throw new Error("not yet"); }, { timeout: 2000 });
      yield result(50, 0.001);
    });
    const a = await queue("Stubborn job");
    await runtime.tickOnce();
    for (let i = 0; i < 50 && !forkId; i++) await new Promise((r) => setTimeout(r, 10));
    const r = await world.verbs.stop_fork(mei.id, { forkId });
    expect(Date.parse(r.deadline) - Date.now()).toBeGreaterThan(4.9 * 60_000);
    // before the deadline: nothing
    clock.t = Date.parse(r.deadline) - 1000;
    await runtime.tickOnce();
    expect(world.agents.require(forkId).status).toBe("working");
    clock.t = Date.parse(r.deadline) + 1000;
    await runtime.tickOnce();
    await runtime.whenIdle();
    expect(stopEvents(world, forkId)).toEqual(["requested", "hard"]);
    const s = world.sessions.first("agentId = ? AND purpose = 'work'", [forkId])!;
    expect(s.status).toBe("interrupted");
    expect(world.docs.require(s.reportId!)).toMatchObject({ title: expect.stringContaining("Session ended without a report"), decision: "stop" });
    expect(world.assignments.require(a).status).toBe("cancelled");
    expect(world.agents.require(forkId).status).toBe("retired");
    // a retired fork can't be asked again
    await expect(world.verbs.stop_fork(mei.id, { forkId })).rejects.toThrow(/retired/);
  });

  test("the tick reads pending stops from meta, not the system events; a request from before the marker existed is seeded once", async () => {
    let forkId = "";
    const { world, runtime, mei, clock, queue } = forkSetup(async function* (s) {
      yield init();
      forkId = s.agentId!;
      await s.next();
      await vi.waitFor(() => { if (!s.interrupted || world.agents.require(forkId).status !== "stopped") throw new Error("not yet"); }, { timeout: 2000 });
      yield result(50, 0.001);
    });
    await queue("Stubborn job from before the deploy");
    await runtime.tickOnce();
    for (let i = 0; i < 50 && !forkId; i++) await new Promise((r) => setTimeout(r, 10));
    const r = await world.verbs.stop_fork(mei.id, { forkId });
    const pending = () => JSON.parse(world.town.marker("pendingForkStops") ?? "null") as { forkId: string; deadline: string }[] | null;
    expect(pending()).toEqual([expect.objectContaining({ forkId, deadline: r.deadline })]);
    // as if the request was made by the old code (no marker yet): the first tick seeds it from the last day's events
    world.db.prepare("DELETE FROM meta WHERE key = 'marker:pendingForkStops'").run();
    clock.t = Date.parse(r.deadline) - 1000;
    await runtime.tickOnce();
    expect(pending()).toEqual([expect.objectContaining({ forkId, deadline: r.deadline })]);
    clock.t = Date.parse(r.deadline) + 1000;
    await runtime.tickOnce();
    await runtime.whenIdle();
    expect(stopEvents(world, forkId)).toEqual(["requested", "hard"]);
    expect(world.agents.require(forkId).status).toBe("retired");
    // done with: the list is empty, so later ticks read one meta row and stop
    expect(pending()).toEqual([]);
  });
});

describe("manager forks: a desk that fails at startup", () => {
  test("after 2 forks in a row whose desk fails before a session exists, the work waits 10 min (waitFor.after), the manager is told, and the retire reason carries the error", async () => {
    const failing: DeskBackend = {
      kind: "docker",
      available: async () => true,
      ensure: async () => { throw new Error("insufficient resources to create new machine with existing volume 'vol_x'"); },
      exec: () => { throw new Error("unreachable"); },
    };
    const { world, runtime, mei, clock, queue } = forkSetup(async function* () { yield init(); yield result(1, 0); }, { backend: failing });
    const a = await queue("Needs a desk");
    const forked = () => world.events.recent({ limit: 300 }).filter((e) => e.type === "agent.forked");
    const retired = () => world.events.recent({ limit: 300 }).filter((e) => e.type === "agent.retired");
    await pass(runtime);
    expect(forked()).toHaveLength(1);
    expect(retired()[0]!.payload).toMatchObject({ tokens: 0, reason: "desk failed at startup: insufficient resources to create new machine with existing volume 'vol_x'", requeued: [a] });
    // still queued, no wait yet: the second try runs on the next pass
    expect(world.assignments.require(a)).toMatchObject({ status: "pending", agentId: mei.id, waitFor: null });
    await pass(runtime);
    expect(forked()).toHaveLength(2);
    const parked = world.assignments.require(a);
    expect(parked.status).toBe("pending");
    expect(parked.waitFor).toEqual({ after: new Date(clock.t + 10 * 60_000).toISOString() });
    const alert = world.events.recent({ limit: 300 }).find((e) => e.type === "system" && e.payload?.alert === "fork-startup-failed")!;
    expect(alert.text).toContain('"Needs a desk" couldn\'t start 2 times in a row (desk failed at startup: insufficient resources');
    expect(alert.payload).toMatchObject({ assignmentId: a, attempts: 2 });
    const note = world.messages.first("toId = ? AND kind = 'system'", [mei.id])!;
    expect(note.body).toContain(`"Needs a desk" (${a}) couldn't start 2 times in a row`);
    expect(note.body).toContain("desk-slots");
    // no third fork while it waits
    await pass(runtime);
    await pass(runtime);
    expect(forked()).toHaveLength(2);
    // after the backoff the scheduler tries again (and the count starts over)
    clock.t += 10 * 60_000 + 1000;
    await pass(runtime);
    expect(forked()).toHaveLength(3);
    expect(world.assignments.require(a)).toMatchObject({ status: "pending", waitFor: null });
  });
});

describe("declarative exploration: the explore tick (docs/how-work-gets-done.md §3)", () => {
  test("with the rule on and a free desk, the tick reserves a chunk and a fork runs the explorer; its reservation closes when it files", async () => {
    const { world, runtime } = forkSetup(async function* (s) {
      yield init();
      yield* callVerb(s, "submit_report", REPORT);
      yield result(100, 0.01);
    });
    world.goals.patch(ROOT_GOAL_ID, { explore: null });
    await pass(runtime);
    const r = world.bankReservations.first("1 = 1")!;
    expect(r).toMatchObject({ tokens: 100_000 });
    const a = world.assignments.require(r.assignmentId!);
    expect(a).toMatchObject({ lane: "exploration", reservationId: r.id });
    expect(world.events.recent({ limit: 200 }).some((e) => e.type === "agent.forked" && e.payload.assignmentId === a.id)).toBe(true);
    await pass(runtime);
    expect(world.assignments.require(a.id).status).toBe("done");
    expect(world.bankReservations.require(r.id).closedAt).not.toBeNull();
    expect(world.events.recent({ limit: 200 }).map((e) => e.type)).toEqual(expect.arrayContaining(["exploration.reserved", "exploration.started", "exploration.closed"]));
  });
});
