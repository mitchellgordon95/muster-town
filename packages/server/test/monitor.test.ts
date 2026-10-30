import { afterEach, describe, expect, it } from "vitest";
import { TOWN_HALL_ID } from "@muster-town/core";
import { buildApp } from "../src/app.ts";
import { ALERT_ENV, CLEAR_AFTER, Counters, type DeskSession, Monitor, OUTBOUND_CAP, defaultMetrics, processProbes, type Probes, type Senders } from "../src/monitor.ts";
import { json, seededApp } from "./helpers.ts";

const MIN = 60_000;
const GB = 1024 * 1024 * 1024;
const fullEnv = Object.fromEntries(ALERT_ENV.map((k) => [k, "x"]));

function rig(o: { env?: Record<string, string>; probes?: Partial<Probes> } = {}) {
  let t = Date.parse("2026-10-28T20:00:00Z");
  const state = { rss: 0.2 * GB, lag: 0 as number | null, disk: 0.5 as number | null, slots: { running: 1, max: 30 }, queue: 0, backup: null as Probes["backup"] extends () => infer R ? R : never,
    http: { total: 0, errors: 0 }, ws: 0, sessions: { failed15: 0, ended30: 0, failed30: 0 }, desk: [] as DeskSession[] };
  const probes: Probes = {
    rssBytes: () => state.rss, lagP99Ms: () => state.lag, diskFree: () => state.disk, slots: () => state.slots,
    queueWaiting: () => state.queue, backup: () => state.backup, http: () => state.http, wsErrors: () => state.ws, sessions: () => state.sessions,
    deskSessions: (since) => state.desk.filter((d) => d.endedAt > since), ...o.probes,
  };
  const sent: { kind: "sms" | "email"; text: string }[] = [];
  const senders: Senders = { sms: async (text) => { sent.push({ kind: "sms", text }); }, email: async (subject) => { sent.push({ kind: "email", text: subject }); } };
  const logs: string[] = [];
  const log = { log: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) };
  return { state, sent, logs, senders, log, probes, now: () => t, tick: (ms = MIN) => { t += ms; }, env: o.env ?? fullEnv };
}

let close: (() => Promise<void>) | null = null;
afterEach(async () => { await close?.(); close = null; });

async function setup(o: Parameters<typeof rig>[0] = {}) {
  const s = await seededApp();
  close = s.close;
  const r = rig(o);
  const buildingId = s.world.buildings.all()[0]!.id;
  const make = () => new Monitor({ world: s.world, metrics: defaultMetrics(r.probes), env: r.env, senders: r.senders, now: r.now, log: r.log, buildingId });
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
    expect(r.sent).toEqual([]); // yellow stays in town
    r.state.rss = 1.7 * GB;
    await step(3);
    expect(m.view().alerts[0]!.level).toBe("yellow");
    await step(1);
    expect(m.view().alerts[0]!.level).toBe("red");
    expect(r.sent.map((x) => x.kind)).toEqual(["sms", "email"]);
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
    expect(r.sent).toHaveLength(4); // red clear goes out too
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

  it("re-alerts a key that stays red at most hourly", async () => {
    const { r, step, alerts } = await setup();
    r.state.disk = 0.05;
    await step(1);
    await step(59);
    expect(alerts().filter((a) => a.phase === "realert")).toHaveLength(0);
    await step(1);
    expect(alerts().filter((a) => a.phase === "realert")).toHaveLength(1);
    expect(r.sent).toHaveLength(4);
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

  it("backup: yellow on error, red when the last copy is older than 26 h", async () => {
    const { r, m, step } = await setup();
    r.state.backup = { lastAt: new Date(r.now() - 2 * 3600_000).toISOString(), bytes: 1, dest: "s3://b/", error: "boom" };
    await step(1);
    expect(m.view().alerts).toMatchObject([{ key: "backup", level: "yellow" }]);
    r.state.backup = { lastAt: new Date(r.now() - 27 * 3600_000).toISOString(), bytes: 1, dest: "s3://b/", error: null };
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
    expect(r.sent.map((x) => x.kind)).toEqual(["sms", "email"]);
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

    it("red on one session at 50% steal share, SMS + email", async () => {
      const s = await setup();
      await s.step(1);
      end(s, 0.5);
      await s.step(1);
      expect(s.m.view().alerts).toMatchObject([{ key: "desk-steal", level: "red", value: 50 }]);
      expect(s.r.sent.map((x) => x.kind)).toEqual(["sms", "email"]);
      expect(s.world.docs.get(s.alerts().at(-1)!.docId!)!.title).toContain("[RED] desk session steal 50%");
    });

    it("red on two sessions at 35% within an hour; yellow when they are further apart", async () => {
      const s = await setup();
      end(s, 0.36);
      await s.step(1);
      expect(s.m.view().alerts).toMatchObject([{ key: "desk-steal", level: "yellow", value: 36 }]);
      expect(s.r.sent).toEqual([]); // yellow stays in town
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
      expect(s.r.sent).toHaveLength(4); // raise + clear, SMS and email each
    });
  });

  it("caps outbound at 10 messages an hour", async () => {
    const { m, r } = await setup();
    const results = [];
    for (let i = 0; i < 7; i++) results.push(await m.test("Admin"));
    expect(r.sent).toHaveLength(OUTBOUND_CAP);
    expect(results.at(-1)).toMatchObject({ sms: "skipped", email: "skipped" });
    expect(results[0]).toMatchObject({ sms: "sent", email: "sent" });
    r.tick(61 * MIN);
    expect(await m.test("Admin")).toMatchObject({ sms: "sent", email: "sent" });
  });

  it("without the secrets: outbound false, one boot log line, red stays in town", async () => {
    const { r, make, world, buildingId } = await setup({ env: {} });
    void buildingId;
    const m = make();
    expect(m.outbound).toBe(false);
    expect(r.logs.filter((l) => l === "monitor: outbound disabled")).toHaveLength(2); // one per Monitor built
    const res = await m.test("Admin");
    expect(res).toMatchObject({ sms: "skipped", email: "skipped" });
    expect(res.fyiDocId).toBeTruthy();
    expect(world.db.prepare("SELECT type FROM events WHERE id = ?").get(res.eventId)).toEqual({ type: "alert" });
    expect(r.sent).toEqual([]);
    expect(JSON.stringify(m.view())).not.toContain("ALERT_");
  });

  it("FYIs go to the building named Prod, else the Town Hall board (a self-hosted town without Prod)", async () => {
    const s = await seededApp();
    close = s.close;
    const r = rig({ env: {} });
    const make = () => new Monitor({ world: s.world, metrics: [], env: {}, now: r.now, log: r.log });
    s.world.buildings.all().filter((b) => b.name.trim().toLowerCase() === "prod").forEach((b) => s.world.buildings.patch(b.id, { name: `${b.name} old` }));
    const th = (await make().test("Admin")).fyiDocId!;
    expect(s.world.docs.get(th)).toMatchObject({ type: "fyi", buildingId: TOWN_HALL_ID });
    const other = s.world.buildings.all().find((b) => b.kind !== "town-hall")!;
    s.world.buildings.patch(other.id, { name: "Prod" });
    const prod = (await make().test("Admin")).fyiDocId!;
    expect(s.world.docs.get(prod)).toMatchObject({ type: "fyi", buildingId: other.id });
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
  it("health shows the monitor block; the test endpoint needs an admin", async () => {
    const s = await seededApp();
    const r = rig({ env: {} });
    const m = new Monitor({ world: s.world, metrics: defaultMetrics(r.probes), env: {}, now: r.now, log: r.log, buildingId: s.world.buildings.all()[0]!.id });
    const app = await buildApp({ world: s.world, dev: false, webDist: false, monitor: m });
    close = async () => { await app.close(); await s.close(); };
    await m.sample();
    const h = await json(app, "GET", "/api/health");
    expect(h.body.monitor).toEqual({ lastSampleAt: "2026-10-28T20:00:00.000Z", outbound: false, alerts: [] });
    expect((await json(app, "POST", "/api/admin/monitor/test")).status).toBe(401);
    const agentToken = s.world.tokens.getOrCreate("agent", s.by("Ada")?.id ?? s.world.agents.all().find((a) => a.kind === "resident")!.id);
    expect((await json(app, "POST", "/api/admin/monitor/test", { headers: { authorization: `Bearer ${agentToken}` } })).status).toBe(403);
    const ok = await json(app, "POST", "/api/admin/monitor/test", { headers: s.auth });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ sms: "skipped", email: "skipped" });
    expect(typeof ok.body.eventId).toBe("number");
    const desk = await json(app, "POST", "/api/admin/monitor/test?metric=desk-steal", { headers: s.auth });
    expect(desk.status).toBe(200);
    expect(desk.body).toMatchObject({ sms: "skipped", email: "skipped" });
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
    const p = processProbes(s.world, "/nonexistent", () => null, new Counters(() => now));
    expect(p.sessions(now)).toEqual({ failed15: 1, ended30: 3, failed30: 2 });
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
    const r = rig({ env: {} });
    const m = new Monitor({ world: s.world, metrics: [], env: {}, log: r.log, buildingId: null });
    const app = await buildApp({ world: s.world, dev: false, webDist: false, monitor: m });
    close = async () => { await app.close(); await s.close(); };
    await json(app, "GET", "/api/health");
    await json(app, "GET", "/api/nope");
    expect(m.counters.http(Date.now())).toEqual({ total: 2, errors: 0 });
  });
});
