/** Stale-state detection: a redeploy cut off by a restart gets a terminal event; the drain drops agents it waits on in vain; docker outages raise a town notice. */
import { describe, expect, test, vi } from "vitest";
import type { World } from "@muster-town/core";
import { HostBackend, makeRedeployer, startRuntime, STUCK_POLLS, type CmdResult, type CommandRunner, type DeskBackend, type RedeployDeps } from "../src/index.ts";
import { drainNudge, drainNudgeFacilitator } from "../src/redeploy.ts";
import { callVerb, deferred, init, result, setup, text } from "./helpers.ts";

const ok = (stdout = ""): CmdResult => ({ code: 0, stdout, stderr: "" });
/** a clean tree; every command succeeds */
const run: CommandRunner = async (cmd, args) => {
  const line = [cmd, ...args].join(" ");
  if (line.startsWith("git rev-parse HEAD")) return ok("abc123\n");
  if (line.startsWith("git rev-list --count")) return ok("0\n");
  return ok();
};
const redeployEvents = (world: World) => world.events.recent({ limit: 500 }).filter((e) => e.type === "system" && (e.payload as { redeploy?: boolean }).redeploy);
const make = (world: World, extra: Partial<RedeployDeps> = {}) =>
  makeRedeployer({ world, repoRoot: "/repo", collective: "climate", image: "x", isWorking: () => false, run, exit: vi.fn(), exitDelayMs: 1, drainPollMs: 1, ...extra });
const INTERRUPTED = "Redeploy: ended by a server restart (the run was interrupted)";

describe("terminal event on restart", () => {
  test("startup closes a run whose last event isn't terminal (the server was restarted mid-drain)", () => {
    const { world } = setup(async function* () { yield result(1, 0); });
    world.events.append({ type: "system", text: "Redeploy: draining, waiting for 1 session(s) to end: Lena", payload: { redeploy: true, run: { state: "scheduled", requestedBy: "Pix", commits: 2, working: ["ag_lena"], blocked: [] }, step: "drain", phase: "start" } });
    make(world);
    const last = redeployEvents(world).at(-1)!;
    expect(last.text).toBe(INTERRUPTED);
    expect(last.payload).toMatchObject({ redeploy: true, phase: "end", terminal: true, ok: false, aborted: true, run: { state: "aborted", requestedBy: "Pix", working: [] } });
    // a second startup sees the terminal event and adds nothing
    make(world);
    expect(redeployEvents(world).filter((e) => e.text === INTERRUPTED)).toHaveLength(1);
  });

  test("not when the last redeploy event is terminal (restarting, failed, explicit terminal) or there is none", () => {
    for (const payload of [
      { redeploy: true, run: { state: "restarting", requestedBy: "Pix", commits: 1, working: [], blocked: [] } },
      { redeploy: true, run: { state: "failed", requestedBy: "Pix", commits: null, working: [], blocked: [] } },
      { redeploy: true, phase: "end", terminal: true },
    ]) {
      const { world } = setup(async function* () { yield result(1, 0); });
      world.events.append({ type: "system", text: "Redeploy: something", payload });
      make(world);
      expect(redeployEvents(world).some((e) => e.text === INTERRUPTED)).toBe(false);
    }
    const { world } = setup(async function* () { yield result(1, 0); });
    make(world);
    expect(redeployEvents(world)).toHaveLength(0);
  });

  test("every normal terminal outcome carries terminal: true (restarting; a failure)", async () => {
    const { world } = setup(async function* () { yield result(1, 0); });
    const r = make(world);
    r.redeploy({ image: false, requestedBy: "Pix" });
    await r.done();
    const evs = redeployEvents(world);
    expect(evs.at(-1)).toMatchObject({ text: "Redeploy: restarting server", payload: { terminal: true } });
    expect(evs.slice(0, -1).some((e) => (e.payload as { terminal?: boolean }).terminal)).toBe(false);

    const dirty: CommandRunner = async (cmd, args) => ([cmd, ...args].join(" ") === "git status --porcelain" ? ok(" M x\n") : run(cmd, args, { cwd: "/repo" }));
    const f = make(world, { run: dirty });
    f.redeploy({ image: false, requestedBy: "Pix" });
    await f.done();
    expect(redeployEvents(world).at(-1)).toMatchObject({ text: "Redeploy: aborted, the working tree is dirty", payload: { terminal: true, ok: false } });
  });
});

describe("drain nudge", () => {
  test("every session the drain waits on is told once that the restart comes after it ends; the requester's own session is named", async () => {
    const { world, by } = setup(async function* () { yield result(1, 0); });
    const noor = by("Noor");
    const pix = by("Ada");
    world.setStatus(noor.id, "working");
    world.setStatus(pix.id, "working");
    let left = [noor.id, pix.id];
    const nudge = vi.fn();
    const r = make(world, { working: () => left, nudge, drainTimeoutMs: 60_000 });
    r.redeploy({ image: false, requestedBy: "Ada" });
    await new Promise((res) => setTimeout(res, 40));
    expect(nudge).toHaveBeenCalledTimes(2);
    expect(nudge).toHaveBeenCalledWith(pix.id, drainNudge(true));
    expect(nudge).toHaveBeenCalledWith(noor.id, drainNudge(false));
    expect(drainNudge(true)).toMatch(/^The redeploy you requested is waiting for your work session to end/);
    expect(drainNudge(false)).toMatch(/^A redeploy is waiting/);
    const start = redeployEvents(world).find((e) => { const p = e.payload as { step?: string; phase?: string }; return p.step === "drain" && p.phase === "start"; })!;
    expect(start.text).toContain("Ada requested it and is still running, so it waits for them too");
    expect(start.payload).toMatchObject({ requester: pix.id });
    left = [];
    await r.done();
    expect(nudge).toHaveBeenCalledTimes(2);
  });
});

// the drain, the facilitator's close and the exit take over a second on a busy CI runner (vi.waitFor defaults to 1 s)
const SLOW = { timeout: 15_000, interval: 20 };

describe("drain waits for facilitations", { timeout: 30_000 }, () => {
  test("startRuntime: a running facilitation counts in the drain, is told to close a meeting no human is in, and is never dropped as stuck", async () => {
    const exit = vi.fn();
    let mossId = "";
    const nudges: string[] = [];
    const { world, runtime, by, lab } = setup(async function* (s) {
      if (!s.agentId) { yield text("Did: x"); yield result(1, 0, "Did: x"); return; } // summaries
      if (s.agentId === mossId) { // the facilitator listens until the drain tells it to close
        const meetingId = /meeting (mt_[\w-]+)/.exec(s.received[0])![1];
        yield init();
        nudges.push((await s.next())!);
        yield* callVerb(s, "meeting", { meetingId, action: "end", text: "Closing for the redeploy." });
        yield result(5, 0);
        return;
      }
      yield init(); yield result(1, 0);
    }, { repoRoot: "/repo", redeploy: { run, exit, exitDelayMs: 1, drainPollMs: 1, drainTimeoutMs: 60_000 } });
    mossId = by("Moss").id;
    const m = world.ops.createMeeting(null, { kind: "standup", buildingId: lab.id, startNow: true });
    void runtime.onMeetingStart(m.id);
    await vi.waitFor(() => expect(world.sessions.first("agentId = ? AND status = 'running' AND purpose = 'facilitate'", [mossId])).toBeTruthy(), SLOW);
    expect(world.agents.require(mossId).status).not.toBe("working"); // in-meeting: the old stuck check would have dropped him
    expect(runtime.isWorking(mossId)).toBe(false); // a facilitation is not a work session (the scheduler isn't blocked by it)
    expect(runtime.redeploy({ image: false, requestedBy: "Pix" })).toEqual({ started: true });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(75), SLOW);
    expect(nudges).toEqual([drainNudgeFacilitator()]);
    expect(world.meetings.require(m.id).phase).toBe("done");
    expect(world.docs.require(world.meetings.require(m.id).notesDocId!).body).toContain("Closing for the redeploy.");
    const texts = redeployEvents(world).map((e) => e.text);
    expect(texts.some((t) => t.startsWith("Redeploy: draining, waiting for 1 session(s) to end: Moss"))).toBe(true);
    expect(texts).toContain("Redeploy: drain … ok (no sessions running)");
    expect(redeployEvents(world).some((e) => (e.payload as { stuck?: boolean }).stuck)).toBe(false);
    expect(world.ops.pendingInterrupts(mossId, "none")).toEqual([]); // no work interrupt queued for an agent that was only facilitating
    await runtime.whenIdle();
  });

  test("startRuntime: a facilitation that keeps going (a human is talking) holds the drain only drainMeetingMs; the meeting gets the restart notice and stays open", async () => {
    const exit = vi.fn();
    let mossId = "";
    const restarted = deferred();
    const { world, runtime, by, lab } = setup(async function* (s) {
      if (!s.agentId) { yield text("Did: x"); yield result(1, 0, "Did: x"); return; }
      if (s.agentId === mossId) { yield init(); await s.next(); await restarted.promise; yield result(5, 0); return; } // ignores the nudge: keeps the meeting going
      yield init(); yield result(1, 0);
    }, { repoRoot: "/repo", redeploy: { run, exit, exitDelayMs: 1, drainPollMs: 1, drainMeetingMs: 50, drainTimeoutMs: 60_000 } });
    mossId = by("Moss").id;
    const m = world.ops.createMeeting(null, { kind: "standup", buildingId: lab.id, startNow: true });
    void runtime.onMeetingStart(m.id);
    await vi.waitFor(() => expect(world.sessions.first("agentId = ? AND status = 'running' AND purpose = 'facilitate'", [mossId])).toBeTruthy(), SLOW);
    expect(runtime.redeploy({ image: false, requestedBy: "Pix" })).toEqual({ started: true });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(75), SLOW);
    const texts = redeployEvents(world).map((e) => e.text);
    expect(texts).toContain("Redeploy: not waiting longer for meeting session(s): Moss; their meetings get a notice and resume after the restart");
    expect(texts.some((t) => t.startsWith("Redeploy: drain timed out"))).toBe(false);
    const after = world.meetings.require(m.id);
    expect(after.phase).toBe("discussing");
    expect(after.transcript.at(-1)).toMatchObject({ speakerKind: "system", text: "Moss's reply is waiting on a redeploy (commit abc123); the server is restarting and the meeting resumes after the restart." });
    restarted.resolve(); // (a real restart kills the session here)
    await runtime.whenIdle();
  });
});

describe("drain self-heal", () => {
  test(`an agent idle for more than ${STUCK_POLLS} polls is dropped with a stuck event, and the drain continues`, async () => {
    const { world, by } = setup(async function* () { yield result(1, 0); });
    const noor = by("Noor");
    expect(noor.status).toBe("idle");
    let polls = 0;
    const drop = vi.fn();
    const exit = vi.fn();
    const r = make(world, { working: () => { polls++; return [noor.id]; }, drop: (id) => drop(id, polls), drainTimeoutMs: 60_000, exit });
    r.redeploy({ image: false, requestedBy: "Pix" });
    await r.done();
    expect(drop).toHaveBeenCalledTimes(1);
    // the first call is the pre-drain check; then STUCK_POLLS polls that only count, and one more that drops
    expect(drop).toHaveBeenCalledWith(noor.id, 1 + STUCK_POLLS + 1);
    const stuck = redeployEvents(world).find((e) => (e.payload as { stuck?: boolean }).stuck)!;
    expect(stuck.text).toBe("Redeploy: drain stuck on Noor (idle but still counted); dropping");
    expect(stuck.payload).toMatchObject({ redeploy: true, phase: "drain", stuck: true, agentId: noor.id });
    expect(redeployEvents(world).map((e) => e.text)).toContain("Redeploy: drain … ok (no sessions running)");
    expect(exit).toHaveBeenCalledWith(75);
  });

  test("an agent that is working is never dropped; one that filed its report gets the wrap-up grace first", async () => {
    const { world, by } = setup(async function* () { yield result(1, 0); });
    const noor = by("Noor");
    world.setStatus(noor.id, "working");
    let left = [noor.id];
    const drop = vi.fn();
    const r = make(world, { working: () => left, drop, drainTimeoutMs: 60_000 });
    r.redeploy({ image: false, requestedBy: "Pix" });
    await new Promise((res) => setTimeout(res, 40));
    expect(drop).not.toHaveBeenCalled();
    left = [];
    await r.done();

    // filed its report (core sets it idle) while the session wraps up: dropped only after drainWrapUpMs
    const s = world.ops.startSession(noor.id, { purpose: "work", model: "m" });
    world.sessions.patch(s.id, { reportId: "doc_x" });
    world.setStatus(noor.id, "idle");
    const t0 = Date.now();
    let droppedAt = 0;
    const g = make(world, { working: () => [noor.id], drop: () => { droppedAt = Date.now(); }, drainTimeoutMs: 60_000, drainWrapUpMs: 80 });
    g.redeploy({ image: false, requestedBy: "Pix" });
    await g.done();
    expect(droppedAt - t0).toBeGreaterThanOrEqual(80);
  });

  test("startRuntime: a live session whose Session row already ended is pruned, so the drain doesn't wait for it", async () => {
    const gate = deferred();
    const exit = vi.fn();
    const { world, runtime, by } = setup(async function* () { await gate.promise; yield result(1, 0); },
      { repoRoot: "/repo", redeploy: { run, exit, exitDelayMs: 1, drainPollMs: 1, drainTimeoutMs: 60_000 } });
    const noor = by("Noor");
    const asg = world.ops.createWork(null, noor.id, { title: "Long one" });
    const done = runtime.runWorkSession(noor.id, asg.id).catch(() => undefined);
    await vi.waitFor(() => expect(world.sessions.first("agentId = ? AND status = 'running'", [noor.id])).toBeTruthy());
    expect(runtime.isWorking(noor.id)).toBe(true);
    // the row ends behind the runtime's back (e.g. a desk that died, ended elsewhere): the live entry is now stale
    world.ops.endSession(world.sessions.first("agentId = ? AND status = 'running'", [noor.id])!.id, { status: "error", error: "desk gone" });
    expect(runtime.redeploy({ image: false, requestedBy: "Pix" })).toEqual({ started: true });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(75));
    expect(runtime.isWorking(noor.id)).toBe(false);
    expect(redeployEvents(world).some((e) => e.text.startsWith("Redeploy: draining"))).toBe(false);
    gate.resolve();
    await done;
  });

  test("status(): running, phase, waitingFor names, since", async () => {
    const { world, by } = setup(async function* () { yield result(1, 0); });
    const noor = by("Noor");
    world.setStatus(noor.id, "working");
    let left = [noor.id];
    const r = make(world, { working: () => left, drainTimeoutMs: 60_000 });
    expect(r.status()).toEqual({ running: false, phase: "idle", waitingFor: [], since: null });
    r.redeploy({ image: false, requestedBy: "Pix" });
    await vi.waitFor(() => expect(r.status().phase).toBe("drain"));
    expect(r.status()).toMatchObject({ running: true, waitingFor: ["Noor"] });
    expect(Date.parse(r.status().since!)).not.toBeNaN();
    left = [];
    await r.done();
    expect(r.status()).toEqual({ running: false, phase: "idle", waitingFor: [], since: null });
  });
});

describe("docker-down notice", () => {
  function fakeDocker() {
    const state = { up: false, probes: 0 };
    const probe: DeskBackend = {
      kind: "docker",
      available: async () => { state.probes++; return state.up; },
      ensure: async () => { throw new Error("no desks in tests"); },
      exec: () => { throw new Error("no desks in tests"); },
    };
    return { state, probe };
  }
  const alerts = (world: World) => world.events.recent({ limit: 500 }).map((e) => (e.payload as { alert?: string }).alert).filter(Boolean);

  test("down at startup → one docker-down event (not every tick); back → docker-up; down again → docker-down", async () => {
    const { state, probe } = fakeDocker();
    const { world, runtime } = setup(async function* () { yield result(1, 0); }, { deskBackend: undefined, desks: { backend: "auto" }, dockerProbe: probe, dockerProbeMs: 0 });
    expect(await runtime.backend()).toBe("host");
    await runtime.tickOnce();
    await runtime.tickOnce();
    await runtime.whenIdle();
    expect(state.probes).toBeGreaterThan(1);
    expect(alerts(world)).toEqual(["docker-down"]);
    expect(world.events.recent({ limit: 500 }).find((e) => (e.payload as { alert?: string }).alert === "docker-down")!.text)
      .toBe("Docker is not running: code desks can't start; workshop sessions are paused");
    expect(world.snapshot().health).toMatchObject({ docker: false });

    state.up = true;
    await runtime.tickOnce();
    await runtime.whenIdle();
    expect(alerts(world)).toEqual(["docker-down", "docker-up"]);
    expect(world.events.recent({ limit: 500 }).find((e) => (e.payload as { alert?: string }).alert === "docker-up")!.text).toBe("Docker is back: code desks resume");
    expect(world.snapshot().health).toMatchObject({ docker: true });
    await runtime.tickOnce();
    await runtime.whenIdle();
    expect(alerts(world)).toEqual(["docker-down", "docker-up"]);

    // OrbStack stops while on docker desks: the liveness probe raises it again (and auto falls back to the host)
    state.up = false;
    await runtime.tickOnce();
    await runtime.whenIdle();
    expect(alerts(world)).toEqual(["docker-down", "docker-up", "docker-down"]);
    expect(world.snapshot().health).toMatchObject({ docker: false });
  });

  test("up at startup, stops mid-run → docker-down; back → docker-up (the host fallback must re-probe)", async () => {
    const { state, probe } = fakeDocker();
    state.up = true;
    const { world, runtime } = setup(async function* () { yield result(1, 0); }, { deskBackend: undefined, desks: { backend: "auto" }, dockerProbe: probe, dockerProbeMs: 0 });
    expect(await runtime.backend()).toBe("docker");
    state.up = false;
    await runtime.tickOnce();
    await runtime.whenIdle();
    expect(alerts(world)).toEqual(["docker-down"]);
    state.up = true;
    await runtime.tickOnce();
    await runtime.whenIdle();
    expect(alerts(world)).toEqual(["docker-down", "docker-up"]);
    expect(world.snapshot().health).toMatchObject({ docker: true });
  });

  test("a restart during an outage doesn't repeat the notice; one after it ends announces docker-up", async () => {
    const { state, probe } = fakeDocker();
    const { world, runtime } = setup(async function* () { yield result(1, 0); }, { deskBackend: undefined, desks: { backend: "auto" }, dockerProbe: probe, dockerProbeMs: 0 });
    await runtime.backend();
    await runtime.stop();
    const again = startRuntime({ world, mcpUrl: "http://127.0.0.1:4321/mcp", intervalMs: 0, exportDir: false, desks: { backend: "auto" }, dockerProbe: probe, dockerProbeMs: 0 });
    await again.backend();
    expect(alerts(world)).toEqual(["docker-down"]);
    await again.stop();
    state.up = true;
    const third = startRuntime({ world, mcpUrl: "http://127.0.0.1:4321/mcp", intervalMs: 0, exportDir: false, desks: { backend: "auto" }, dockerProbe: probe, dockerProbeMs: 0 });
    await third.backend();
    expect(alerts(world)).toEqual(["docker-down", "docker-up"]);
    await third.stop();
  });

  test("an injected backend never probes or alerts", async () => {
    const { world, runtime } = setup(async function* () { yield result(1, 0); }, { deskBackend: new HostBackend() });
    await runtime.tickOnce();
    expect(alerts(world)).toEqual([]);
    expect(world.snapshot().health).toMatchObject({ docker: true });
  });
});
