import { describe, expect, test } from "vitest";
import { intrayOf, World } from "@muster-town/core";
import type { Event } from "@muster-town/schema";
import { HostBackend, ruleFor, startRuntime, startWaker, WAKE_RULES, type WakeCtx, type WakeRule } from "../src/index.ts";
import { init, result, setup } from "./helpers.ts";

const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };

/** A bare waker over `world` whose rules count deliveries: `durable` for "system" events with payload.durable, a kick for the rest. */
function counting(world: World) {
  const runs: { rule: string; id: number }[] = [];
  const rules: WakeRule[] = [
    { name: "durable", who: "manager", kind: "T", replay: true, match: (e) => e.type === "system" && pl(e).durable === true, run: (_w, e) => { runs.push({ rule: "durable", id: e.id }); } },
    { name: "kick", who: "agent", kind: "M", replay: false, match: (e) => e.type === "system", run: (_w, e) => { runs.push({ rule: "kick", id: e.id }); } },
  ];
  const tasks = new Set<Promise<unknown>>();
  let stopped = false;
  const start = () => {
    stopped = false;
    return startWaker({
      world, rules, stopped: () => stopped, wake: { world } as WakeCtx,
      later: (fn) => { const p = new Promise<void>((r) => setImmediate(r)).then(fn).then(() => undefined); tasks.add(p); return p; },
    });
  };
  const stop = (w: ReturnType<typeof start>) => { stopped = true; w.stop(); };
  const idle = async () => { await settle(); await Promise.allSettled([...tasks]); };
  const append = (durable: boolean) => world.events.append({ type: "system", text: durable ? "durable" : "kick", payload: { durable } });
  return { runs, start, stop, idle, append };
}
const pl = (e: Event) => e.payload as Record<string, unknown>;

describe("the Waker's persisted cursor (docs/wakes.md §4 step 4)", () => {
  test("a first boot starts at the end of the log: history is not replayed", async () => {
    const world = World.open(":memory:");
    const c = counting(world);
    c.append(true);
    expect(world.town.wakeCursor()).toBeNull();
    const w = c.start();
    await w.booted; await c.idle();
    expect(c.runs).toEqual([]);
    expect(world.town.wakeCursor()).toBe(world.events.lastId());
    c.stop(w); world.close();
  });

  test("live events run their rule once; the cursor passes a durable one once it has run; a restart replays nothing twice", async () => {
    const world = World.open(":memory:");
    const c = counting(world);
    const w = c.start();
    await w.booted;
    const d = c.append(true), k = c.append(false);
    await c.idle();
    expect(c.runs).toEqual([{ rule: "durable", id: d.id }, { rule: "kick", id: k.id }]);
    // the kick was seen before the durable rule settled: the cursor is past both
    expect(world.town.wakeCursor()).toBe(k.id);
    c.stop(w);
    const w2 = c.start();
    await w2.booted; await c.idle();
    expect(c.runs).toHaveLength(2);
    c.stop(w2); world.close();
  });

  test("a durable event that arrived while the waker was down is delivered once on boot; a kick is not replayed", async () => {
    const world = World.open(":memory:");
    const c = counting(world);
    const w = c.start();
    await w.booted;
    c.stop(w);
    const k = c.append(false), d = c.append(true);
    expect(k.id).toBeLessThan(d.id);
    const w2 = c.start();
    await w2.booted; await c.idle();
    expect(c.runs).toEqual([{ rule: "durable", id: d.id }]);
    expect(world.town.wakeCursor()).toBe(d.id);
    // live events after the boot are handled live, and the next restart replays none of it
    const d2 = c.append(true);
    await c.idle();
    c.stop(w2);
    const w3 = c.start();
    await w3.booted; await c.idle();
    expect(c.runs).toEqual([{ rule: "durable", id: d.id }, { rule: "durable", id: d2.id }]);
    c.stop(w3); world.close();
  });
});

describe("WAKE_RULES: each of the old onEvent branches is one rule, first match wins", () => {
  test("events map to the rule that handled them before; a tell has none (relayWake runs in the tell verb)", () => {
    const { world, lab, seed } = setup(async function* () { yield init(); yield result(10, 0.001); });
    const admin = world.ops.ensureAvatar(seed.admin.id);
    const ev = (type: string, payload: Record<string, unknown> = {}, buildingId: string | null = lab.id) => ({ id: 1, ts: new Date().toISOString(), type, agentId: null, buildingId, text: "", payload }) as unknown as Event;
    const mei = world.agents.first("name = ?", ["Mei"])!;
    world.ops.updateBuilding(admin, lab.id, { managerAgentId: mei.id });
    const one = world.ops.createMeeting(null, { kind: "standup", buildingId: lab.id });
    const name = (e: Event) => ruleFor(e, world)?.name ?? null;
    expect(name(ev("meeting.created", { meetingId: one.id, phase: "collecting" }))).toBe("meeting-summaries");
    expect(name(ev("meeting.phase", { meetingId: one.id, phase: "collecting" }))).toBe("meeting-summaries");
    expect(name(ev("meeting.phase", { meetingId: one.id, phase: "discussing" }))).toBe("facilitation");
    expect(name(ev("agent.mentioned", { meetingId: one.id, toId: mei.id }))).toBe("meeting-reply");
    expect(name(ev("agent.mentioned", { toId: mei.id }))).toBeNull();
    expect(name(ev("doc.created", { docType: "report" }))).toBe("manager-intray");
    expect(name(ev("doc.created", { docType: "flag" }))).toBe("manager-intray");
    expect(name(ev("doc.created", { docType: "note" }))).toBeNull();
    expect(name(ev("doc.created", { docType: "report" }, null))).toBeNull();
    for (const t of ["grant.funded", "grant.closed", "kr.created", "kr.updated", "kr.deleted"]) expect(name(ev(t))).toBe("manager-intray-row");
    expect(name(ev("agent.status", { status: "stopped" }))).toBe("stop");
    expect(name(ev("agent.status", { status: "idle" }))).toBeNull();
    expect(name(ev("agent.banned"))).toBe("stop");
    expect(name(ev("agent.told", { toId: mei.id }))).toBeNull();
    expect(WAKE_RULES.filter((r) => r.replay).map((r) => r.name)).toEqual(["manager-intray-row"]);
  });

  test("a human's key-result edit while the server is down: the restarted runtime writes the in-tray row once and wakes the manager; the next restart writes none", async () => {
    const env = setup(async function* () { yield init(); yield result(100, 0.01, "Noted."); });
    const { world, runtime, lab, seed } = env;
    const admin = world.ops.ensureAvatar(seed.admin.id);
    for (const d of intrayOf(world, lab.id)) await world.verbs.review(admin.id, { docId: d.id, decision: "approve" });
    const mei = env.by("Mei");
    world.ops.updateBuilding(admin, lab.id, { managerAgentId: mei.id });
    const kr = world.grantDesk.createKeyResult(admin, lab.id, { text: "Visitors can read the goal", howToCheck: "Open the board" });
    await settle(); await runtime.whenIdle();
    const rows = () => world.docs.where("authorId = 'system' AND buildingId = ? AND type = 'report' AND tags LIKE '%manager-intray%'", [lab.id]);
    const manages = () => world.sessions.where("agentId = ? AND purpose = 'manage'", [mei.id]);
    expect(rows()).toHaveLength(1);
    const before = manages().length;
    await runtime.stop();
    // down: the event is in the log, nobody acts on it
    world.grantDesk.updateKeyResult(admin, kr.id, { text: "Visitors can read the goal in one glance" });
    await settle();
    expect(rows()).toHaveLength(1);
    const boot = () => startRuntime({ world, mcpUrl: "http://127.0.0.1:4321/mcp", sdk: env.sdk, intervalMs: 0, exportDir: false, deskBackend: new HostBackend() });
    const r2 = boot();
    await settle(); await r2.whenIdle();
    expect(rows()).toHaveLength(2);
    expect(rows()[1]!.title).toMatch(new RegExp(`^Key result ${kr.id} edited by `));
    expect(manages().length).toBe(before + 1);
    await r2.stop();
    const r3 = boot();
    await settle(); await r3.whenIdle();
    expect(rows()).toHaveLength(2);
    expect(manages().length).toBe(before + 1);
    await r3.stop();
  });
});
