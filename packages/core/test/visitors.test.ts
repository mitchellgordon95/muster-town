import { describe, expect, it } from "vitest";
import { LookResult, TILE } from "@agent-town/schema";
import { createAssignment, nextPending, OFFER_TTL_MS, TOWN_HALL_FIXTURES, tileAt } from "../src/index.ts";
import { seededWorld, tickUntil } from "./helpers.ts";

const later = (ms: number) => new Date(Date.now() + ms);

describe("v1.4 visitors: where they live", () => {
  it("a visitor registered into a building claims a free desk there, like a resident", () => {
    const { world, seed } = seededWorld();
    const lab = world.ops.createBuilding(null, { name: "Roomy", headcount: 4 }).id;
    const free = world.layout.places.filter((p) => p.id.startsWith(`desk:free:${lab}:`)).length;
    const { agent } = world.ops.registerVisitor(seed.admin.id, { name: "Mitch's Claude", buildingId: lab });
    expect(agent.homeBuildingId).toBe(lab);
    expect(agent.buildingId).toBe(lab);
    const desk = world.layout.deskOf(agent.id)!;
    expect(desk.name).toBe("Mitch's Claude's desk");
    expect(agent.pos).toEqual(desk.pos);
    expect(world.layout.places.filter((p) => p.id.startsWith(`desk:free:${lab}:`)).length).toBe(free - 1);
  });

  it("without a building the visitor sits at the Town Hall visitor bench (two seats, then the bench tile)", () => {
    const { world, seed } = seededWorld();
    const hall = world.buildings.require("town-hall").lot!;
    const bench = world.layout.place("visitor-bench")!;
    expect(bench.kind).toBe("bench");
    for (const b of TOWN_HALL_FIXTURES.bench) expect(tileAt(world.layout.grid, hall.x + b.x, hall.y + b.y)).toBe(TILE.BENCH);
    const seats = TOWN_HALL_FIXTURES.benchSeats.map((s) => ({ x: hall.x + s.x, y: hall.y + s.y }));
    const a = world.ops.registerVisitor(seed.admin.id, { name: "A" }).agent;
    const b = world.ops.registerVisitor(seed.admin.id, { name: "B" }).agent;
    const c = world.ops.registerVisitor(seed.admin.id, { name: "C" }).agent;
    expect([a.pos, b.pos]).toEqual(seats);
    expect(c.pos).toEqual(bench.pos);
    expect(a.homeBuildingId).toBeNull();
    expect(a.buildingId).toBe("town-hall");
    for (const s of seats) expect(world.layout.isWalkable(s.x, s.y)).toBe(true);
  });

  it("a full building puts the visitor on the bench, still homed there", () => {
    const { world, seed } = seededWorld();
    const b = world.ops.createBuilding(null, { name: "Tiny", headcount: 1 });
    world.ops.createResident(null, { buildingId: b.id, name: "Only" });
    const { agent } = world.ops.registerVisitor(seed.admin.id, { name: "V", buildingId: b.id });
    expect(world.layout.deskOf(agent.id)).toBeUndefined();
    expect(agent.homeBuildingId).toBe(b.id);
    expect(world.layout.placeAt(agent.pos)?.id).toBe("visitor-bench");
  });
});

describe("v1.4 visitors: presence", () => {
  it("touch stamps lastSeenAt at most every 10 s; residents are never marked offline", () => {
    const { world, seed, by } = seededWorld();
    const v = world.ops.registerVisitor(seed.admin.id, { name: "V" }).agent;
    const t0 = new Date();
    world.presence.touch(v.id, t0);
    expect(world.agents.require(v.id).lastSeenAt).toBe(t0.toISOString());
    world.presence.touch(v.id, new Date(t0.getTime() + 5_000));
    expect(world.agents.require(v.id).lastSeenAt).toBe(t0.toISOString());
    const t1 = new Date(t0.getTime() + 11_000);
    world.presence.touch(v.id, t1);
    expect(world.agents.require(v.id).lastSeenAt).toBe(t1.toISOString());

    const ravi = by("Ravi");
    expect(world.presence.sweep(new Date(t1.getTime() + 60_000))).toEqual([]);
    expect(world.presence.sweep(new Date(t1.getTime() + 91_000))).toEqual([v.id]);
    expect(world.agents.require(v.id).status).toBe("offline");
    expect(world.agents.require(ravi.id).status).not.toBe("offline");
    // already offline: not again
    expect(world.presence.sweep(new Date(t1.getTime() + 200_000))).toEqual([]);
  });

  it("going offline sends the body home; the next call is the 'back' transition with an agent.status event", async () => {
    const { world, seed } = seededWorld();
    const lab = world.ops.createBuilding(null, { name: "Roomy", headcount: 4 }).id;
    const v = world.ops.registerVisitor(seed.admin.id, { name: "V", buildingId: lab }).agent;
    const desk = world.layout.deskOf(v.id)!.pos;
    await tickUntil(world, world.verbs.go(v, { to: "library" }));
    expect(world.agents.require(v.id).pos).not.toEqual(desk);
    world.presence.sweep(later(91_000));
    const off = world.agents.require(v.id);
    expect(off.status).toBe("offline");
    expect(off.pos).toEqual(desk);
    const r = world.presence.touch(v.id)!;
    expect(r.back).toBe(true);
    expect(world.agents.require(v.id).status).toBe("idle");
    const ev = world.events.recent({ agentId: v.id, limit: 5 }).find((e) => e.type === "agent.status" && e.text === "V is back");
    expect(ev).toBeTruthy();
    // stopped/banned visitors are left alone
    world.ops.stopAgent(null, v.id);
    expect(world.presence.sweep(later(500_000))).toEqual([]);
  });

  it("a visitor holding an active assignment keeps it offline and comes back working", async () => {
    const { world, seed, admin } = seededWorld();
    const v = world.ops.registerVisitor(seed.admin.id, { name: "V", buildingId: "carbon-cycle" }).agent;
    const a = createAssignment(world, { agentId: v.id, title: "Look at CO2", description: "d", createdBy: world.holderOf(admin) });
    await world.verbs.accept_assignment(v, { id: a.id });
    expect(world.agents.require(v.id).status).toBe("working");
    world.presence.sweep(later(91_000));
    expect(world.agents.require(v.id).status).toBe("offline");
    expect(world.assignments.require(a.id).status).toBe("active");
    // a restart's reconcile doesn't requeue a visitor's active assignment
    world.ops.reconcile([]);
    expect(world.assignments.require(a.id).status).toBe("active");
    world.presence.touch(v.id);
    expect(world.agents.require(v.id).status).toBe("working");
  });
});

describe("v1.4 visitors: mailbox digest", () => {
  it("the first look after coming back carries notices.digest; later looks don't", async () => {
    const { world, seed, admin, by } = seededWorld();
    const v = world.ops.registerVisitor(seed.admin.id, { name: "Visitor Vee", buildingId: "carbon-cycle" }).agent;
    world.presence.touch(v.id, new Date(Date.now() - 200_000));
    world.presence.sweep(new Date(Date.now() - 100_000));
    expect(world.agents.require(v.id).status).toBe("offline");
    // while away: a message, a mention, an offer, a meeting that ended
    await world.verbs.tell(by("Ravi"), { to: v.id, text: "hello" });
    await world.verbs.say(by("Ravi"), { text: "ping @Visitor Vee" }).catch(() => undefined);
    await world.verbs.write(by("Ravi"), { title: "Note", body: "cc @Visitor Vee", state: "building" });
    const offer = createAssignment(world, { agentId: v.id, title: "Offer", description: "d", createdBy: world.holderOf(admin) });
    expect(offer.offered).toBe(true);
    const m = world.ops.createMeeting(admin, { kind: "standup", buildingId: "carbon-cycle", startNow: true });
    world.ops.endMeeting(admin, m.id);
    const ended = world.meetings.require(m.id);

    world.presence.touch(v.id);
    const look = LookResult.parse(await world.verbs.look(v));
    const d = look.notices.digest!;
    expect(d).toBeTruthy();
    expect(d.messages).toBeGreaterThanOrEqual(2);
    expect(d.mentions).toBeGreaterThanOrEqual(1);
    expect(d.messages).toBeGreaterThan(d.mentions);
    expect(d.assignmentsOffered).toBe(1);
    expect(d.meetingsMissed).toEqual([{ id: m.id, title: ended.title, notesDocId: ended.notesDocId }]);
    expect((await world.verbs.look(v)).notices.digest).toBeUndefined();
    // the CLI's digest isn't consumed by look
    expect(world.presence.lastDigest(v.id)).toEqual(d);
    expect(world.presence.mailbox(v.id)).toMatchObject({ offered: 1 });
  });
});

describe("v1.4 visitors: assignments are offers", () => {
  it("offers are never scheduled; accept clears offered and the visitor works; submit_report ends it", async () => {
    const { world, seed, admin } = seededWorld();
    const v = world.ops.registerVisitor(seed.admin.id, { name: "V", buildingId: "carbon-cycle" }).agent;
    const a = world.ops.createWork(admin, v.id, { title: "Read the board" });
    expect(a.offered).toBe(true);
    expect(nextPending(world, v.id)).toBeUndefined();
    const res = await world.verbs.accept_assignment(v, { id: a.id });
    expect(res.status).toBe("active");
    expect(world.assignments.require(a.id).offered).toBe(false);
    expect(world.agents.require(v.id).status).toBe("working");
    await world.verbs.submit_report(world.agents.require(v.id), { title: "Done", body: "## Summary\nok", verdict: "stop" });
    expect(world.assignments.require(a.id).status).toBe("done");
    expect(world.agents.require(v.id).status).toBe("idle");
  });

  it("residents' assignments are not offers", () => {
    const { world, admin, by } = seededWorld();
    const a = world.ops.createWork(admin, by("Ravi").id, { title: "x" });
    expect(a.offered).toBeUndefined();
    expect(nextPending(world, by("Ravi").id)?.id).toBe(a.id);
  });

  it("an offer left for 24 h is cancelled with a note in the building's in-tray", () => {
    const { world, seed, admin } = seededWorld();
    const v = world.ops.registerVisitor(seed.admin.id, { name: "Vee", buildingId: "carbon-cycle" }).agent;
    const a = world.ops.createWork(admin, v.id, { title: "Survey the flux data" });
    const before = world.ops.intray("carbon-cycle").length;
    expect(world.presence.expireOffers(new Date(Date.now() + OFFER_TTL_MS - 60_000))).toEqual([]);
    const expired = world.presence.expireOffers(new Date(Date.now() + OFFER_TTL_MS + 1_000));
    expect(expired.map((x) => x.id)).toEqual([a.id]);
    expect(world.assignments.require(a.id).status).toBe("cancelled");
    const tray = world.ops.intray("carbon-cycle");
    expect(tray.length).toBe(before + 1);
    expect(tray.at(-1)!.title).toBe("Vee didn't pick up: Survey the flux data");
    // accepted offers don't expire
    const b = world.ops.createWork(admin, v.id, { title: "Taken" });
    void world.verbs.accept_assignment(v, { id: b.id });
    expect(world.presence.expireOffers(new Date(Date.now() + 2 * OFFER_TTL_MS))).toEqual([]);
  });

  it("a human's message to a visitor waits in its mailbox (no assignment)", async () => {
    const { world, seed } = seededWorld();
    const v = world.ops.registerVisitor(seed.admin.id, { name: "V" }).agent;
    const r = await world.ops.messageAgent(seed.admin.id, v.id, "are you there?");
    expect(r.mode).toBe("queued");
    expect(r.assignmentId).toBeUndefined();
    expect(world.presence.mailbox(v.id).unread).toBe(1);
  });
});
