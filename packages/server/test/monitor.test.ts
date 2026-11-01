import { afterEach, describe, expect, it } from "vitest";
import { deskSizeFor, DESK_FALLBACK_SIZE, TOWN_HALL_ID } from "@muster-town/core";
import { buildApp } from "../src/app.ts";
import { CLEAR_AFTER, Counters, parseHostCpu, DESK_STEAL_EXPIRE_MS, REALERT_MS, type DeskSession, Monitor, defaultMetrics, processProbes, type Probes } from "../src/monitor.ts";
import { json, seededApp } from "./helpers.ts";

const MIN = 60_000;
const GB = 1024 * 1024 * 1024;
function rig(o: { probes?: Partial<Probes> } = {}) {
  let t = Date.parse("2026-10-28T20:00:00Z");
  const state = { rss: 0.2 * GB, lag: 0 as number | null, disk: 0.5 as number | null, slots: { running: 1, max: 30 }, queue: 0, backup: null as Probes["backup"] extends () => infer R ? R : never,
    http: { total: 0, errors: 0 }, ws: 0, sessions: { failed15: 0, ended30: 0, failed30: 0 }, desk: [] as DeskSession[],
    cpu: null as { cpu: number; steal: number } | null };
  const probes: Probes = {
    rssBytes: () => state.rss, lagP99Ms: () => state.lag, diskFree: () => state.disk, slots: () => state.slots,
    queueWaiting: () => state.queue, backup: () => state.backup, http: () => state.http, wsErrors: () => state.ws, sessions: () => state.sessions,
    deskSessions: (since) => state.desk.filter((d) => d.endedAt > since), deskBill: () => null, hostCpu: () => state.cpu, ...o.probes,
  };
  const logs: string[] = [];
  const log = { log: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) };
  return { state, logs, log, probes, now: () => t, tick: (ms = MIN) => { t += ms; } };
}

let close: (() => Promise<void>) | null = null;
afterEach(async () => { await close?.(); close = null; });

async function setup(o: Parameters<typeof rig>[0] = {}) {
  const s = await seededApp();
  close = s.close;
  const r = rig(o);
  const buildingId = s.world.buildings.all()[0]!.id;
  const make = () => new Monitor({ world: s.world, metrics: defaultMetrics(r.probes), now: r.now, log: r.log, buildingId });
  const m = make();
  const step = async (n = 1) => { for (let i = 0; i < n; i++) { r.tick(); await m.sample(); } };
  const alerts = () => (s.world.db.prepare("SELECT payload FROM events WHERE type = 'alert' ORDER BY id").all() as { payload: string }[]).map((e) => JSON.parse(e.payload) as { key: string; level: string; phase: string; docId: string | null });
  return { ...s, r, m, make, step, alerts, buildingId };
}

describe("monitor thresholds", () => {
  it("RSS: yellow after 5 min over 1.2 GB, red after 3 min over 1.6 GB, clear after 5 samples under yellow", async () => {
    const { r, m, step, alerts, world } = await setup();
    r.state.rss = 1.3 * GB;
    await step(5);
    expect(m.view().alerts).toEqual([]);
    await step(1); // condition has held 5 min
    expect(m.view().alerts).toMatchObject([{ key: "rss", level: "yellow", value: 1331 }]);
    r.state.rss = 1.7 * GB;
    await step(3);
    expect(m.view().alerts[0]!.level).toBe("yellow");
    await step(1);
    expect(m.view().alerts[0]!.level).toBe("red");
    const raise = alerts().filter((a) => a.phase === "raise");
    expect(raise.map((a) => a.level)).toEqual(["yellow", "red"]);
    // one FYI per raise; the escalation and the clear update it
    const docId = raise[0]!.docId!;
    expect(world.docs.get(docId)).toMatchObject({ type: "fyi", state: "building" });
    expect(world.docs.get(docId)!.title).toContain("[RED]");
    expect(world.docs.get(docId)!.body).toContain(`clears this after ${CLEAR_AFTER} samples in a row under yellow`);

    r.state.rss = 0.5 * GB;
    await step(CLEAR_AFTER - 1);
    expect(m.view().alerts).toHaveLength(1);
    await step(1);
    expect(m.view().alerts).toEqual([]);
    expect(alerts().at(-1)).toMatchObject({ key: "rss", phase: "clear", level: "red", docId });
    expect(world.docs.get(docId)!.title).toContain("[CLEARED]");
  });

  it("hysteresis: a sample back over yellow resets the clear count", async () => {
    const { r, m, step } = await setup();
    r.state.disk = 0.2; // disk alerts at once
    await step(1);
    expect(m.view().alerts).toMatchObject([{ key: "disk", level: "yellow" }]);
    r.state.disk = 0.5;
    await step(4);
    r.state.disk = 0.2;
    await step(1);
    r.state.disk = 0.5;
    await step(4);
    expect(m.view().alerts).toHaveLength(1);
    await step(1);
    expect(m.view().alerts).toEqual([]);
  });

  it("re-alerts a key that stays red at most every REALERT_MS (6 h)", async () => {
    const { r, step, alerts } = await setup();
    r.state.disk = 0.05;
    await step(1);
    await step(REALERT_MS / MIN - 1);
    expect(alerts().filter((a) => a.phase === "realert")).toHaveLength(0);
    await step(1);
    expect(alerts().filter((a) => a.phase === "realert")).toHaveLength(1);
  });

  it("slots: yellow at 80% for 15 min; red only when full with queued work for 15 min", async () => {
    const { r, m, step } = await setup();
    r.state.slots = { running: 30, max: 30 };
    await step(16);
    expect(m.view().alerts).toMatchObject([{ key: "slots", level: "yellow", value: 100 }]);
    r.state.queue = 2;
    await step(15);
    expect(m.view().alerts[0]!.level).toBe("yellow");
    await step(1);
    expect(m.view().alerts[0]!.level).toBe("red");
  });

  it("backup: yellow on error or a copy older than 2 h, red when older than 6 h (hourly copies) or a fresh town refuses", async () => {
    const { r, m, step } = await setup();
    r.state.backup = { lastAt: new Date(r.now() - 1.5 * 3600_000).toISOString(), verifiedAt: null, bytes: 1, dest: "s3://b/", error: null };
    await step(1);
    expect(m.view().alerts).toEqual([]);
    r.state.backup = { lastAt: new Date(r.now() - 0.5 * 3600_000).toISOString(), verifiedAt: null, bytes: 1, dest: "s3://b/", error: "verify town/x failed: boom" };
    await step(1);
    expect(m.view().alerts).toMatchObject([{ key: "backup", level: "yellow" }]);
    r.state.backup = { lastAt: new Date(r.now() - 3 * 3600_000).toISOString(), verifiedAt: null, bytes: 1, dest: "s3://b/", error: null };
    await step(1);
    expect(m.view().alerts).toMatchObject([{ key: "backup", level: "yellow" }]);
    // a fresh town refusing to upload over the copies is red at once (gr_z2v838adk9)
    r.state.backup = { lastAt: null, verifiedAt: null, bytes: null, dest: "s3://b/", error: "fresh town; restore first: the bucket holds 3" };
    await step(1);
    expect(m.view().alerts).toMatchObject([{ key: "backup", level: "red" }]);
    r.state.backup = { lastAt: new Date(r.now() - 7 * 3600_000).toISOString(), verifiedAt: null, bytes: 1, dest: "s3://b/", error: null };
    await step(1);
    expect(m.view().alerts).toMatchObject([{ key: "backup", level: "red" }]);
  });

  it("5xx: needs 50 responses in 5 min; yellow over 2%, red over 10%", async () => {
    const { r, m, step } = await setup();
    r.state.http = { total: 40, errors: 20 };
    await step(1);
    expect(m.view().alerts).toEqual([]);
    r.state.http = { total: 100, errors: 3 };
    await step(1);
    expect(m.view().alerts).toMatchObject([{ key: "5xx", level: "yellow", value: 3 }]);
    r.state.http = { total: 100, errors: 11 };
    await step(1);
    expect(m.view().alerts).toMatchObject([{ key: "5xx", level: "red", value: 11 }]);
  });

  it("ws: yellow over 20 errors in 5 min, red over 100", async () => {
    const { r, m, step } = await setup();
    r.state.ws = 20;
    await step(1);
    expect(m.view().alerts).toEqual([]);
    r.state.ws = 21;
    await step(1);
    expect(m.view().alerts).toMatchObject([{ key: "ws", level: "yellow", value: 21 }]);
    r.state.ws = 101;
    await step(1);
    expect(m.view().alerts[0]!.level).toBe("red");
  });

  it("sessions: yellow at 3 failures in 15 min; red when half of 4+ sessions ended in 30 min failed", async () => {
    const { r, m, step } = await setup();
    r.state.sessions = { failed15: 3, ended30: 10, failed30: 3 };
    await step(1);
    expect(m.view().alerts).toMatchObject([{ key: "sessions", level: "yellow", value: 3 }]);
    r.state.sessions = { failed15: 3, ended30: 6, failed30: 3 };
    await step(1);
    expect(m.view().alerts[0]!.level).toBe("red");
  });

  it("sessions: red needs at least 4 sessions ended", async () => {
    const { r, m, step } = await setup();
    r.state.sessions = { failed15: 3, ended30: 3, failed30: 3 };
    await step(1);
    expect(m.view().alerts).toMatchObject([{ key: "sessions", level: "yellow" }]);
  });

  describe("desk-steal", () => {
    // a desk session that ends `minAgo` before the next sample, with this steal share
    const end = (s: Awaited<ReturnType<typeof setup>>, share: number, minAgo = 0.5) =>
      s.r.state.desk.push({ id: `se_${s.r.state.desk.length}`, endedAt: s.r.now() + MIN - minAgo * MIN, share });

    it("red on one session at 50% steal share", async () => {
      const s = await setup();
      await s.step(1);
      end(s, 0.5);
      await s.step(1);
      expect(s.m.view().alerts).toMatchObject([{ key: "desk-steal", level: "red", value: 50 }]);
      expect(s.world.docs.get(s.alerts().at(-1)!.docId!)!.title).toContain("[RED] desk session steal 50%");
    });

    it("red on two sessions at 35% within an hour; yellow when they are further apart", async () => {
      const s = await setup();
      end(s, 0.36);
      await s.step(1);
      expect(s.m.view().alerts).toMatchObject([{ key: "desk-steal", level: "yellow", value: 36 }]);
      await s.step(30);
      end(s, 0.4);
      await s.step(1);
      expect(s.m.view().alerts).toMatchObject([{ key: "desk-steal", level: "red", value: 40 }]);

      await s.close();
      const t = await setup();
      end(t, 0.36);
      await t.step(1);
      await t.step(61);
      end(t, 0.4);
      await t.step(1);
      expect(t.m.view().alerts).toMatchObject([{ key: "desk-steal", level: "yellow", value: 40 }]);
    });

    it("yellow at 25%, nothing under it; samples with no new session change nothing", async () => {
      const s = await setup();
      end(s, 0.24);
      await s.step(1);
      expect(s.m.view().alerts).toEqual([]);
      end(s, 0.25);
      await s.step(1);
      expect(s.m.view().alerts).toMatchObject([{ key: "desk-steal", level: "yellow", value: 25 }]);
      await s.step(20);
      expect(s.m.view().alerts).toHaveLength(1);
    });

    it("clears after 5 clean sessions, not 5 samples", async () => {
      const s = await setup();
      end(s, 0.9);
      await s.step(1);
      expect(s.m.view().alerts).toMatchObject([{ level: "red" }]);
      const docId = s.alerts().at(-1)!.docId!;
      expect(s.world.docs.get(docId)!.body).toContain(`clears this after ${CLEAR_AFTER} desk sessions in a row under yellow`);
      await s.step(10);
      for (let i = 0; i < CLEAR_AFTER - 2; i++) { end(s, 0.1); await s.step(1); }
      end(s, 0.1, 0.4); end(s, 0.1, 0.2); // two in one sample count two
      await s.step(1);
      expect(s.m.view().alerts).toEqual([]);
      expect(s.alerts().at(-1)).toMatchObject({ key: "desk-steal", phase: "clear", level: "red" });
      expect(s.world.docs.get(docId)!.body).toContain(`after ${CLEAR_AFTER} desk sessions under yellow`);
    });

    it("clears as stale when no desk session ends for DESK_STEAL_EXPIRE_MS, also after a restart", async () => {
      const s = await setup();
      end(s, 0.9);
      await s.step(1);
      end(s, 0.1); // one clean session: value 0..10 but still red (needs 5)
      await s.step(1);
      expect(s.m.view().alerts).toMatchObject([{ key: "desk-steal", level: "red", value: 10 }]);
      await s.step(DESK_STEAL_EXPIRE_MS / MIN - 1);
      expect(s.m.view().alerts).toHaveLength(1);
      // a restart keeps the clock: lastReadAt is persisted
      const m2 = s.make();
      s.r.tick(); await m2.sample();
      expect(m2.view().alerts).toEqual([]);
      expect(s.alerts().at(-1)).toMatchObject({ key: "desk-steal", phase: "clear", level: "red", stale: true });
      expect(s.world.docs.get(s.alerts().at(-1)!.docId!)!.body).toContain("as stale");
    });
  });

  describe("steal (host CPU, 503 post-mortem 2026-10-31)", () => {
    // each sample advances the host's /proc/stat by `busy` and `steal` jiffies (100 a second)
    const advance = (r: ReturnType<typeof rig>, busy: number, steal: number) => {
      r.state.cpu = { cpu: (r.state.cpu?.cpu ?? 0) + busy, steal: (r.state.cpu?.steal ?? 0) + steal };
    };

    it("parses /proc/stat's cpu line: busy = user + nice + system, steal = the eighth field", () => {
      expect(parseHostCpu("cpu  100 5 20 9000 3 1 2 70 0 0\ncpu0 1 2 3")).toEqual({ cpu: 125, steal: 70 });
      expect(parseHostCpu("intr 1 2 3")).toBeNull();
      expect(parseHostCpu("cpu 1 2")).toBeNull();
    });

    it("yellow after 5 min over 25 %, red after 3 min over 50 %, clear after 5 samples; FYI points at the runbook", async () => {
      const s = await setup();
      advance(s.r, 0, 0);
      await s.step(1); // first reading: nothing to compare with
      const steal = () => s.m.view().alerts.filter((a) => a.key === "steal");
      for (let i = 0; i < 5; i++) { advance(s.r, 2000, 1000); await s.step(1); } // 33 %
      expect(steal()).toEqual([]);
      advance(s.r, 2000, 1000); await s.step(1);
      expect(steal()).toMatchObject([{ level: "yellow", value: 33 }]);
      for (let i = 0; i < 3; i++) { advance(s.r, 1000, 3000); await s.step(1); } // 75 %
      expect(steal()[0]!.level).toBe("yellow");
      advance(s.r, 1000, 3000); await s.step(1);
      expect(steal()).toMatchObject([{ level: "red", value: 75 }]);
      const doc = s.world.docs.get(s.alerts().filter((a) => a.key === "steal").at(-1)!.docId!)!;
      expect(doc.title).toContain('host CPU throttled (steal 75%): see deploy/README.md "Slow or 503"');
      for (let i = 0; i < CLEAR_AFTER; i++) { advance(s.r, 3000, 10); await s.step(1); }
      expect(steal()).toEqual([]);
      expect(s.alerts().at(-1)).toMatchObject({ key: "steal", phase: "clear" });
    });

    it("an idle minute (under 3 s of busy + steal) never alerts; no /proc/stat (off Linux) reads nothing", async () => {
      const s = await setup();
      advance(s.r, 0, 0);
      await s.step(1);
      for (let i = 0; i < 10; i++) { advance(s.r, 50, 200); await s.step(1); } // 80 % of almost nothing
      expect(s.m.view().alerts).toEqual([]);
      s.r.state.cpu = null;
      await s.step(10);
      expect(s.m.view().alerts).toEqual([]);
    });
  });

  describe("desk-bill", () => {
    const H = 60 * MIN;
    const PERF = { cpuKind: "performance", cpus: 1, memoryMb: 2048 } as const;
    // the real World.deskBill over sessions rows, on the monitor's clock; a $0.10/day cap so an hour of performance-1x
    // ($33/month = $0.0458/h) is 46 % of it
    async function billSetup() {
      const s = await setup();
      s.world.setDesksConfig({ backend: "fly", billCapUsd: 0.1 });
      s.r.probes.deskBill = (now) => { const b = s.world.deskBill(new Date(now)); return { todayUsd: b.todayUsd, capUsd: b.capUsd }; };
      const agentId = s.world.agents.all()[0]!.id;
      const run = (startMs: number, wallMs: number, size: typeof PERF | null = PERF) => {
        const se = s.world.ops.startSession(agentId, { purpose: "work", model: "m", backend: "docker", size });
        s.world.db.prepare("UPDATE sessions SET status = 'done', startedAt = ?, endedAt = ?, wallMs = ? WHERE id = ?")
          .run(new Date(startMs).toISOString(), new Date(startMs + wallMs).toISOString(), wallMs, se.id);
      };
      return { ...s, run };
    }

    it("yellow at 50% of the daily cap, in town only", async () => {
      const s = await billSetup();
      s.run(s.r.now() - 2 * H, 1.2 * H); // 1.2 h × $0.045833 = $0.055
      await s.step(1);
      expect(s.m.view().alerts).toMatchObject([{ key: "desk-bill", level: "yellow", value: 55 }]);
      expect(s.world.deskBill(new Date(s.r.now()))).toMatchObject({ todayUsd: 0.055, capUsd: 0.1, overCap: false });
      expect(deskSizeFor(s.world.desksConfig(), s.world.deskBill(new Date(s.r.now())))).toEqual({ size: PERF, fallback: false });
    });

    it("red at the cap: new desk sessions fall back to shared-cpu-2x, re-alert after REALERT_MS; resets at midnight UTC", async () => {
      const s = await billSetup();
      s.run(s.r.now() - 5 * H, 1.2 * H);
      s.run(s.r.now() - 3 * H, 1.2 * H);
      s.run(Date.parse("2026-10-27T22:00:00Z"), 1.5 * H); // yesterday's: not today's bill
      await s.step(1);
      expect(s.m.view().alerts).toMatchObject([{ key: "desk-bill", level: "red", value: 110 }]);
      expect(s.world.docs.get(s.alerts().at(-1)!.docId!)!.title).toContain("[RED] desk bill today 110% of the daily cap");
      expect(deskSizeFor(s.world.desksConfig(), s.world.deskBill(new Date(s.r.now())))).toEqual({ size: DESK_FALLBACK_SIZE, fallback: true });
      await s.step(60);
      expect(s.alerts().filter((a) => a.phase === "realert")).toHaveLength(0); // no re-alert after 1 h (REALERT_MS is 6 h)
      // sample at 21:01Z; three hours later the UTC day turns and the bill starts from 0
      await s.step(3 * 60);
      expect(s.world.deskBill(new Date(s.r.now()))).toMatchObject({ day: "2026-10-29", todayUsd: 0, overCap: false });
      expect(deskSizeFor(s.world.desksConfig(), s.world.deskBill(new Date(s.r.now())))).toEqual({ size: PERF, fallback: false });
      await s.step(CLEAR_AFTER);
      expect(s.m.view().alerts).toEqual([]);
      expect(s.alerts().at(-1)).toMatchObject({ key: "desk-bill", phase: "clear" });
    });

    it("sessions without a recorded size are priced at shared-cpu-2x; a running one counts up to now", async () => {
      const s = await billSetup();
      s.run(s.r.now() - 2 * H, H, null); // $13.39/720 = $0.018597
      const agentId = s.world.agents.all()[0]!.id;
      const live = s.world.ops.startSession(agentId, { purpose: "work", model: "m", backend: "docker", size: PERF });
      s.world.db.prepare("UPDATE sessions SET startedAt = ? WHERE id = ?").run(new Date(s.r.now() - 0.5 * H).toISOString(), live.id);
      expect(s.world.deskBill(new Date(s.r.now()))).toMatchObject({ todayUsd: 0.041513, sessions: 2 });
    });
  });

  it("the test alert is one event plus one FYI; the view and the result carry nothing else (no SMS or email from the server)", async () => {
    const { m, world } = await setup();
    const res = await m.test("Admin");
    expect(Object.keys(res).sort()).toEqual(["eventId", "fyiDocId"]);
    expect(res.fyiDocId).toBeTruthy();
    expect(world.db.prepare("SELECT type FROM events WHERE id = ?").get(res.eventId)).toEqual({ type: "alert" });
    expect(world.docs.get(res.fyiDocId!)!.title).toBe("[RED] Monitor test alert");
    expect(m.view()).toEqual({ lastSampleAt: null, alerts: [] });
  });

  it("FYIs go to the building named Prod, else the Town Hall board (a self-hosted town without Prod)", async () => {
    const s = await seededApp();
    close = s.close;
    const r = rig();
    const make = () => new Monitor({ world: s.world, metrics: [], now: r.now, log: r.log });
    s.world.buildings.all().filter((b) => b.name.trim().toLowerCase() === "prod").forEach((b) => s.world.buildings.patch(b.id, { name: `${b.name} old` }));
    const th = (await make().test("Admin")).fyiDocId!;
    expect(s.world.docs.get(th)).toMatchObject({ type: "fyi", buildingId: TOWN_HALL_ID });
    const other = s.world.buildings.all().find((b) => b.kind !== "town-hall")!;
    s.world.buildings.patch(other.id, { name: "Prod" });
    const prod = (await make().test("Admin")).fyiDocId!;
    expect(s.world.docs.get(prod)).toMatchObject({ type: "fyi", buildingId: other.id });
  });

  it("loads a meta row written before the server-side SMS/email path was removed (extra sent / selfTestAt keys are ignored)", async () => {
    const { make, world } = await setup();
    const old = { lastSampleAt: "2026-10-28T19:59:00.000Z", alerts: [{ key: "disk", level: "yellow", since: "2026-10-28T19:50:00.000Z", value: 20, docId: null, notifiedAt: 0, okCount: 0 }], sent: [1, 2], selfTestAt: "2026-10-28T19:00:00.000Z" };
    world.db.prepare("INSERT INTO meta (key, value) VALUES ('monitor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(old));
    const m = make();
    expect(m.view()).toEqual({ lastSampleAt: "2026-10-28T19:59:00.000Z", alerts: [{ key: "disk", level: "yellow", since: "2026-10-28T19:50:00.000Z", value: 20 }] });
    expect(JSON.stringify(m.view())).not.toContain("selfTestAt");
  });

  it("keeps open alerts across a restart and writes a gap event when sampling resumes", async () => {
    const { r, m, make, step, alerts } = await setup();
    r.state.disk = 0.2;
    await step(1);
    expect(m.view().alerts).toHaveLength(1);
    r.tick(10 * MIN);
    const m2 = make();
    expect(m2.view().alerts).toMatchObject([{ key: "disk", level: "yellow" }]);
    await m2.sample();
    expect(alerts().filter((a) => a.phase === "gap")).toHaveLength(1);
  });
});

describe("monitor routes", () => {
  it("health shows the desks block; an admin changes the town-wide desk bill cap, finance/fly follows", async () => {
    const s = await seededApp();
    const app = await buildApp({ world: s.world, dev: false, webDist: false });
    close = async () => { await app.close(); await s.close(); };
    s.world.setDesksConfig({ backend: "fly" });
    const h = await json(app, "GET", "/api/health");
    expect(h.body.desks).toMatchObject({ backend: "fly", size: "performance-1x", billCapUsd: 10, billTodayUsd: 0, billPct: 0, overCap: false });
    expect((await json(app, "PUT", "/api/town/desks", { body: { billCapUsd: 15 } })).status).toBe(401);
    const put = await json(app, "PUT", "/api/town/desks", { headers: s.auth, body: { billCapUsd: 15 } });
    expect(put.status).toBe(200);
    expect(put.body.desks).toMatchObject({ billCapUsd: 15, maxRunning: 30 }); // the slots are left alone
    expect((await json(app, "GET", "/api/health")).body.desks.billCapUsd).toBe(15);
    expect((await json(app, "GET", "/api/finance/fly")).body.capUsdPerDay).toBe(15);
    expect((await json(app, "PUT", "/api/town/desks", { headers: s.auth, body: {} })).status).toBe(400);
  });

  it("health shows the monitor block; the test endpoint needs an admin", async () => {
    const s = await seededApp();
    const r = rig();
    const m = new Monitor({ world: s.world, metrics: defaultMetrics(r.probes), now: r.now, log: r.log, buildingId: s.world.buildings.all()[0]!.id });
    const app = await buildApp({ world: s.world, dev: false, webDist: false, monitor: m });
    close = async () => { await app.close(); await s.close(); };
    await m.sample();
    const h = await json(app, "GET", "/api/health");
    expect(h.body.monitor).toEqual({ lastSampleAt: "2026-10-28T20:00:00.000Z", alerts: [] });
    expect((await json(app, "POST", "/api/admin/monitor/test")).status).toBe(401);
    const agentToken = s.world.tokens.getOrCreate("agent", s.by("Ada")?.id ?? s.world.agents.all().find((a) => a.kind === "resident")!.id);
    expect((await json(app, "POST", "/api/admin/monitor/test", { headers: { authorization: `Bearer ${agentToken}` } })).status).toBe(403);
    const ok = await json(app, "POST", "/api/admin/monitor/test", { headers: s.auth });
    expect(ok.status).toBe(200);
    expect(Object.keys(ok.body).sort()).toEqual(["eventId", "fyiDocId"]);
    expect(typeof ok.body.eventId).toBe("number");
    const desk = await json(app, "POST", "/api/admin/monitor/test?metric=desk-steal", { headers: s.auth });
    expect(desk.status).toBe(200);
    expect(JSON.parse((s.world.db.prepare("SELECT payload FROM events WHERE id = ?").get(desk.body.eventId) as { payload: string }).payload)).toMatchObject({ key: "desk-steal", phase: "test" });
    expect(s.world.docs.get(desk.body.fyiDocId)!.title).toBe("[RED] Monitor test alert for desk-steal");
    expect((await json(app, "POST", "/api/admin/monitor/test?metric=nope", { headers: s.auth })).status).toBe(400);
  });
});

describe("monitor counters", () => {
  it("Counters keeps a 5 min window in minute buckets", () => {
    let t = Date.parse("2026-10-28T20:00:00Z");
    const c = new Counters(() => t);
    c.response(200); c.response(503); c.wsError();
    t += 2 * MIN;
    c.response(500); c.response(404);
    expect(c.http(t)).toEqual({ total: 4, errors: 2 });
    expect(c.wsErrors(t)).toBe(1);
    t += 4 * MIN; // the first minute is out of the window
    expect(c.http(t)).toEqual({ total: 2, errors: 1 });
    expect(c.wsErrors(t)).toBe(0);
    t += 10 * MIN;
    c.response(200);
    expect(c.http(t)).toEqual({ total: 1, errors: 0 });
  });

  it("processProbes counts failed and ended sessions from the sessions table", async () => {
    const s = await seededApp();
    close = s.close;
    const now = Date.parse("2026-10-28T20:00:00Z");
    const agentId = s.world.agents.all()[0]!.id;
    const add = (id: string, status: string, minAgo: number | null) => s.world.db.prepare(
      "INSERT INTO sessions (id, agentId, purpose, status, model, startedAt, endedAt) VALUES (?, ?, 'work', ?, 'm', ?, ?)",
    ).run(id, agentId, status, new Date(now - 60 * MIN).toISOString(), minAgo == null ? null : new Date(now - minAgo * MIN).toISOString());
    add("se_a", "error", 5); add("se_b", "error", 20); add("se_c", "done", 10); add("se_d", "error", 40); add("se_e", "running", null);
    // sessions a restart cut end `interrupted` (core reconcile): they end, but never count as failed
    add("se_f", "interrupted", 2); add("se_g", "interrupted", 3); add("se_h", "interrupted", 4);
    const p = processProbes(s.world, "/nonexistent", () => null, new Counters(() => now));
    expect(p.sessions(now)).toEqual({ failed15: 1, ended30: 6, failed30: 2 });
    p.close();
  });

  it("processProbes reads finished desk sessions of 5 min or more, never host sessions", async () => {
    const s = await seededApp();
    close = s.close;
    const now = Date.parse("2026-10-28T20:00:00Z");
    const agentId = s.world.agents.all()[0]!.id;
    const add = (id: string, backend: string, wallMin: number, cpuMs: number | null, stealMs: number | null, endMinAgo: number | null = 1) => s.world.db.prepare(
      "INSERT INTO sessions (id, agentId, purpose, status, model, backend, startedAt, endedAt, wallMs, cpuMs, stealMs) VALUES (?, ?, 'work', 'done', 'm', ?, ?, ?, ?, ?, ?)",
    ).run(id, agentId, backend, new Date(now - 90 * MIN).toISOString(), endMinAgo == null ? null : new Date(now - endMinAgo * MIN).toISOString(), wallMin * MIN, cpuMs, stealMs);
    add("se_desk", "docker", 30, 1000, 3000);
    add("se_host", "host", 30, 1000, 3000);
    add("se_short", "docker", 4, 1000, 3000);
    add("se_nocpu", "docker", 30, null, null);
    add("se_old", "docker", 30, 1000, 3000, 120);
    add("se_running", "docker", 30, 1000, 3000, null);
    const p = processProbes(s.world, "/nonexistent", () => null, new Counters(() => now));
    expect(p.deskSessions(now - 60 * MIN)).toEqual([{ id: "se_desk", endedAt: now - MIN, share: 0.75 }]);
    p.close();
  });

  it("the app counts responses into the monitor's counters", async () => {
    const s = await seededApp();
    const r = rig();
    const m = new Monitor({ world: s.world, metrics: [], log: r.log, buildingId: null });
    const app = await buildApp({ world: s.world, dev: false, webDist: false, monitor: m });
    close = async () => { await app.close(); await s.close(); };
    await json(app, "GET", "/api/health");
    await json(app, "GET", "/api/nope");
    expect(m.counters.http(Date.now())).toEqual({ total: 2, errors: 0 });
  });
});
