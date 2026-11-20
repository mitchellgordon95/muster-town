import { afterEach, describe, expect, it, vi } from "vitest";
import { buildingBoard, buildingRoleId, createAssignment, createBuilding, emptyExplorations, exploreBlock, exploreGapMs, plantFlag, stamp, EXPLORE_MAX_GAP_MS, exploreOrder, exploreRuleAt, exploreTick, freeTokens, keyResultsBlock, newId, nowIso, EXPLORE_MIN_GAP_MS, JOURNAL_MAX_LINES, JOURNAL_TITLE, pagesForAssignment, reportReason, revisionsOf, topicPage, writeTopicPage } from "../src/index.ts";
import { ruleBlock } from "../src/lanes.ts";
import { creditBank, seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";

/** Mei manages the lab with spare desks; the Bank holds 10M; the other buildings have no manager, so only the lab explores. */
function setup() {
  const s = seededWorld();
  const { world, by, admin } = s;
  const mei = by("Mei");
  for (const b of world.buildings.all()) if (b.id !== LAB && b.kind !== "town-hall") world.buildings.upsert({ ...b, managerAgentId: null });
  world.ops.updateBuilding(admin, LAB, { managerAgentId: mei.id });
  world.permissions.grant({ kind: "agent", id: mei.id }, buildingRoleId(LAB, "manager"));
  world.buildings.upsert({ ...world.buildings.require(LAB), headcount: 20 });
  creditBank(world);
  const goalId = world.goalTree.attachmentOf(LAB);
  const explorers = () => world.assignments.where("buildingId = ? AND reservationId IS NOT NULL", [LAB]);
  return { ...s, mei, goalId, explorers };
}

describe("declarative exploration (docs/how-work-gets-done.md §3)", () => {
  it("the rule is inherited: on with 100k chunks by default, each setting from the nearest goal that sets it", () => {
    const { world, admin, goalId } = setup();
    expect(exploreRuleAt(world.goals, goalId)).toEqual({ on: true, onFrom: null, chunkTokens: 100_000, chunkFrom: null });
    world.goalTree.update(admin, "gl_town", { explore: false, exploreChunkTokens: 50_000 });
    if (goalId !== "gl_town") world.goalTree.update(admin, goalId, { explore: true });
    const rule = exploreRuleAt(world.goals, goalId);
    expect(rule).toMatchObject({ chunkTokens: 50_000, chunkFrom: "gl_town" });
    expect(rule.on).toBe(goalId !== "gl_town");
  });

  it("the tick reserves one chunk and queues one explorer on the building queue; the reservation claims free tokens", () => {
    const { world, goalId, explorers } = setup();
    const before = freeTokens(world, goalId).freeTokens;
    const { started } = exploreTick(world);
    expect(started).toHaveLength(1);
    const a = started[0]!;
    expect(a).toMatchObject({ buildingId: LAB, lane: "exploration", status: "pending" });
    const r = world.bankReservations.require(a.reservationId!);
    expect(r).toMatchObject({ goalId, buildingId: LAB, assignmentId: a.id, tokens: 100_000, closedAt: null });
    expect(freeTokens(world, goalId)).toMatchObject({ reservedTokens: 100_000, freeTokens: before - 100_000 });
    expect(world.events.list({ types: ["exploration.reserved"] })).toHaveLength(1);
    // the explorer runs on its own reservation even if nothing else is free; one open explorer per building
    expect(ruleBlock(world, a)).toBeNull();
    expect(exploreTick(world).started).toHaveLength(0);
    expect(exploreBlock(world, world.buildings.require(LAB))).toMatch(/explorer of this building is still open/);
    expect(explorers()).toHaveLength(1);
    // its brief: the explorer instruction, not the manager's findings note
    const brief = keyResultsBlock(world, world.buildings.require(LAB), a);
    expect(brief).toMatch(/end with ONE grant proposal/);
    expect(brief).toMatch(new RegExp(r.id));
    // required reading before proposing: the Bank and free tokens (§7), the caps (§8) (gr_yu6qw3j9x5, kr_h0pqsgkov8)
    expect(a.description).toContain("docs/how-work-gets-done.md");
    expect(a.description).toContain("§7");
    expect(a.description).toContain("§8");
    expect(a.description).toMatch(/Before you propose anything, read/);
  });

  it("closes the reservation when its work ends (spent booked, rest returns), then waits before the next explorer (60 min: it found nothing)", () => {
    const { world, mei, goalId, explorers } = setup();
    const t0 = new Date();
    const a = exploreTick(world, t0).started[0]!;
    world.sessions.upsert({
      id: newId("se"), agentId: mei.id, assignmentId: a.id, meetingId: null, purpose: "work", backend: "host", status: "done", model: "m",
      sdkSessionId: null, output: 30_000, costUsd: 0, turns: 0, reportId: null, error: null, startedAt: nowIso(), endedAt: nowIso(), funding: null, lane: "exploration", grantId: null,
    });
    // while it runs, the reservation claims only what its sessions haven't spent
    expect(freeTokens(world, goalId).reservedTokens).toBeLessThan(100_000);
    world.assignments.patch(a.id, { status: "done" });
    const t1 = new Date(t0.getTime() + 60_000);
    const { closed, started } = exploreTick(world, t1);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.closedAt).toBe(t1.toISOString());
    expect(closed[0]!.spentTokens).toBeGreaterThan(0);
    expect(started).toHaveLength(0);
    expect(freeTokens(world, goalId).reservedTokens).toBe(0);
    expect(exploreBlock(world, world.buildings.require(LAB), t1)).toMatch(/the last explorer found nothing; next may start at/);
    expect(exploreTick(world, new Date(t0.getTime() + EXPLORE_MIN_GAP_MS + 1000)).started).toHaveLength(0);
    expect(exploreTick(world, new Date(t0.getTime() + 2 * EXPLORE_MIN_GAP_MS + 1000)).started).toHaveLength(1);
    expect(explorers()).toHaveLength(2);
  });

  it("starts nothing when the rule is off, tokens are short, a proposal is open, other work is queued, or in the Town Hall", async () => {
    const { world, admin, mei, goalId } = setup();
    const lab = () => world.buildings.require(LAB);
    world.goalTree.update(admin, goalId, { explore: false });
    expect(exploreBlock(world, lab())).toMatch(/exploration is off/);
    world.goalTree.update(admin, goalId, { explore: null, exploreChunkTokens: 2_000_000 });
    if (goalId !== "gl_town") world.goalTree.update(admin, "gl_town", { explore: true });
    world.goalTree.update(admin, goalId, { exploreChunkTokens: 1_900_000 });
    world.goalTree.update(admin, goalId, { exploreCapTokensPerDay: 1_000_000 });
    expect(exploreBlock(world, lab())).toMatch(/cap/);
    world.goalTree.update(admin, goalId, { exploreCapTokensPerDay: null, exploreChunkTokens: null });
    expect(exploreBlock(world, lab())).toBeNull();
    // caps combine as the minimum: a looser cap below can't lift a tighter one above (gr_yu6qw3j9x5)
    if (goalId !== "gl_town") {
      world.goalTree.update(admin, "gl_town", { exploreCapTokensPerDay: 50_000 });
      world.goalTree.update(admin, goalId, { exploreCapTokensPerDay: 5_000_000 });
      expect(exploreBlock(world, lab())).toMatch(/cap set on goal gl_town/);
      world.goalTree.update(admin, "gl_town", { exploreCapTokensPerDay: null });
      world.goalTree.update(admin, goalId, { exploreCapTokensPerDay: null });
      expect(exploreBlock(world, lab())).toBeNull();
    }
    const g = world.grantDesk.create(mei, LAB, { keyResults: [{ text: "A visitor can see today's spend", howToCheck: "Open the banner" }], objective: "o", steps: [{ size: "M", title: "Step 1", description: "Do the work" }], stopCondition: "s", askTokens: 1_000 });
    world.grantDesk.propose(mei, g.id);
    expect(exploreBlock(world, lab())).toMatch(/proposal of this building is open/);
    world.grantDesk.decide(admin, g.id, { action: "reject", note: "no" });
    createAssignment(world, { agentId: mei.id, buildingId: LAB, title: "t", description: "d", createdBy: { kind: "system", id: "x" }, lane: { gap: "a gap" } });
    expect(exploreBlock(world, lab())).toMatch(/other work is queued/);
    const hall = world.buildings.first("kind = 'town-hall'")!;
    expect(exploreBlock(world, hall)).toMatch(/Town Hall never explores/);
  });

  it("a fork proposes a grant with its own key results for its building as the manager; an explorer's proposal is logged as exploration.proposed", async () => {
    const { world, mei, by } = setup();
    const a = exploreTick(world).started[0]!;
    const fork = world.agents.upsert({ ...by("Noor"), id: newId("ag"), name: "Mei 1", forkOf: mei.id, forkN: 1, homeBuildingId: LAB, currentAssignmentId: a.id });
    const out = await world.verbs.propose_grant(fork, { title: "A test grant proposal", keyResults: [{ text: "The lab's goal shows first on its board", howToCheck: "Open the lab board" }], objective: "Show the lab's goal first", steps: [{ size: "M", title: "Step 1", description: "Do the work" }], stopCondition: "two tries", askTokens: 200_000 });
    expect(world.grants.require(out.grantId).proposedBy).toBe(mei.id);
    expect(world.grants.require(out.grantId)).toMatchObject({ buildingId: LAB, status: "proposed" });
    const ev = world.events.list({ types: ["exploration.proposed"] });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ grantId: out.grantId, reservationId: a.reservationId });
  });

  it("a cap allowing one chunk a day rotates across buildings: least recently explored first, not rowid order (dc_q48pbvg0td)", () => {
    const { world, admin, seed } = setup();
    const other = createBuilding(world, { name: "Second lab", headcount: 20 }, seed.admin.id, { manager: {} });
    world.goalTree.update(admin, "gl_town", { exploreCapTokensPerDay: 100_000 });
    const first = exploreOrder(world).find((b) => b.kind !== "town-hall")!.id;
    const day = (n: number) => new Date(Date.UTC(2030, 0, 1 + n, 1));
    const turn = (n: number) => {
      const { started } = exploreTick(world, day(n));
      expect(started).toHaveLength(1); // the cap allows one chunk a day
      const a = started[0]!;
      // the explorer spends its chunk, so the day's cap stays used after its reservation closes
      world.sessions.upsert({
        id: newId("se"), agentId: a.agentId, assignmentId: a.id, meetingId: null, purpose: "work", backend: "host", status: "done", model: "m",
        sdkSessionId: null, output: 100_000, costUsd: 0, turns: 0, reportId: null, error: null, startedAt: day(n).toISOString(), endedAt: day(n).toISOString(), funding: null, lane: "exploration", grantId: null,
      });
      world.assignments.patch(a.id, { status: "done" });
      expect(exploreTick(world, new Date(day(n).getTime() + 60_000)).started).toHaveLength(0); // closes its reservation; the cap is used
      return started[0]!.buildingId;
    };
    const turns = [turn(0), turn(1), turn(2)];
    expect(new Set(turns.slice(0, 2))).toEqual(new Set([LAB, other.id]));
    expect(turns[0]).toBe(first);
    expect(turns[2]).toBe(turns[0]);
  });

});

describe("the explore backoff after empty explorations (gr_6id9g7u9cj step 1)", () => {
  const MIN = 60_000;
  const T0 = Date.parse("2026-11-19T00:00:00.000Z");
  afterEach(() => vi.useRealTimers());
  /** The world's clock is the fake one: events, assignments and reservations all read it. */
  function clocked() {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const s = setup();
    const lab = () => s.world.buildings.require(LAB);
    const at = (ms: number) => { vi.setSystemTime(ms); return new Date(ms); };
    /** One explorer starts at `ms`, ends with no proposal, and its reservation closes a minute later. */
    const empty = (ms: number) => {
      const a = exploreTick(s.world, at(ms)).started[0];
      expect(a, `an explorer starts at ${new Date(ms).toISOString()}`).toBeDefined();
      s.world.assignments.patch(a!.id, { status: "done" });
      exploreTick(s.world, at(ms + MIN));
      return a!;
    };
    return { ...s, lab, at, empty };
  }

  it("the wait doubles from 30 min with each empty exploration in a row, to at most 24 h", () => {
    expect([0, 1, 2, 3, 5, 6, 10].map(exploreGapMs)).toEqual([30, 60, 120, 240, 960, 1440, 1440].map((m) => m * MIN));
    expect(EXPLORE_MAX_GAP_MS).toBe(24 * 60 * MIN);
  });

  it("after 1, 2 and 3 empty explorations the Queue tab names the wait and the next may start only then", () => {
    const { world, lab, at, empty } = clocked();
    let t = T0;
    for (const n of [1, 2, 3]) {
      empty(t);
      expect(emptyExplorations(world, LAB)).toBe(n);
      const next = t + exploreGapMs(n);
      const why = exploreBlock(world, lab(), at(next - MIN));
      expect(why).toBe(`the last ${n === 1 ? "explorer" : `${n} explorers`} found nothing; next may start at ${stamp(next)}`);
      expect(buildingBoard(world, LAB, at(next - MIN)).lanes[0]!.exploreBlock).toBe(why);
      expect(exploreBlock(world, lab(), at(next))).toBeNull();
      t = next;
    }
  });

  it("a day of ticks every 5 min starts at most 6 explorers when each finds nothing (Onboarding ran 29 on 2026-11-19)", () => {
    const { world, at } = clocked();
    let started = 0;
    for (let t = T0; t < T0 + 24 * 60 * MIN; t += 5 * MIN) {
      const { started: s } = exploreTick(world, at(t));
      for (const a of s) world.assignments.patch(a.id, { status: "done" });
      started += s.length;
    }
    expect(started).toBeLessThanOrEqual(6);
    expect(started).toBeGreaterThanOrEqual(4);
  });

  it("an exploration that ends in a proposal ends the streak", async () => {
    const { world, mei, by, empty } = clocked();
    empty(T0);
    empty(T0 + exploreGapMs(1));
    expect(emptyExplorations(world, LAB)).toBe(2);
    const a = exploreTick(world, new Date(T0 + exploreGapMs(1) + exploreGapMs(2))).started[0]!;
    const fork = world.agents.upsert({ ...by("Noor"), id: newId("ag"), name: "Mei 1", forkOf: mei.id, forkN: 1, homeBuildingId: LAB, currentAssignmentId: a.id });
    await world.verbs.propose_grant(fork, { title: "A test grant proposal", keyResults: [{ text: "The lab's goal shows first", howToCheck: "Open the lab board" }], objective: "o", steps: [{ size: "M", title: "Step 1", description: "Do the work" }], stopCondition: "s", askTokens: 200_000 });
    world.assignments.patch(a.id, { status: "done" });
    exploreTick(world, new Date(Date.now() + MIN));
    expect(emptyExplorations(world, LAB)).toBe(0);
  });

  describe("resets: something happened that makes a new look worth it", () => {
    /** Two empty explorations, then the signal 10 min after the second: the count is back to 0 and the base 30 min holds. */
    function afterSignal(signal: (s: ReturnType<typeof clocked>) => void) {
      const s = clocked();
      s.empty(T0);
      const t1 = T0 + exploreGapMs(1);
      s.empty(t1);
      expect(emptyExplorations(s.world, LAB)).toBe(2);
      s.at(t1 + 10 * MIN);
      signal(s);
      return { ...s, t1 };
    }

    it("a proposal filed by the building", () => {
      const { world } = afterSignal(({ world, mei }) => {
        const g = world.grantDesk.create(mei, LAB, { keyResults: [{ text: "k", howToCheck: "h" }], objective: "o", steps: [{ size: "M", title: "Step 1", description: "d" }], stopCondition: "s", askTokens: 1_000 });
        world.grantDesk.propose(mei, g.id);
      });
      expect(emptyExplorations(world, LAB)).toBe(0);
    });

    it("non-exploration work queued on it", () => {
      const { world, lab, at, t1 } = afterSignal(({ world, mei }) => {
        const a = createAssignment(world, { agentId: mei.id, buildingId: LAB, title: "t", description: "d", createdBy: { kind: "system", id: "x" }, laneOverride: { lane: "directed", grantId: null, gap: null, sourceId: null } });
        expect(a.lane).not.toBe("exploration");
        world.assignments.patch(a.id, { status: "done" });
      });
      expect(emptyExplorations(world, LAB)).toBe(0);
      expect(exploreBlock(world, lab(), at(t1 + 31 * MIN))).toBeNull();
    });

    it("a human's decision on one of its grants", () => {
      // a draft (not a proposal, which resets on its own) that a human's history entry, written straight here, decides
      const { world } = afterSignal(({ world, admin, mei }) => {
        const d = world.grantDesk.create(mei, LAB, { keyResults: [{ text: "k", howToCheck: "h" }], objective: "o", steps: [{ size: "M", title: "Step 1", description: "d" }], stopCondition: "s", askTokens: 1_000 });
        world.grants.upsert({ ...d, status: "rejected", history: [...d.history, { at: nowIso(), byId: world.holderOf(admin).id, byKind: "user", action: "reject", tokens: null, note: "no" }], updatedAt: nowIso() });
      });
      expect(emptyExplorations(world, LAB)).toBe(0);
    });

    it("a human's tell to its manager (an agent's tell does not reset)", () => {
      const { world, mei, admin, by } = afterSignal(() => {});
      const tell = (fromId: string, fromKind: "agent" | "user") => world.messages.upsert({ id: newId("ms"), kind: "tell", fromId, fromKind, toId: mei.id, body: "hi", meetingId: null, docId: null, origin: null, createdAt: nowIso(), readAt: null });
      tell(by("Noor").id, "agent");
      expect(emptyExplorations(world, LAB)).toBe(2);
      tell(world.holderOf(admin).id, "user");
      expect(emptyExplorations(world, LAB)).toBe(0);
    });

    it("a human's flag in the building", () => {
      const { world } = afterSignal(({ world, admin }) => { plantFlag(world, admin, LAB, "Please look at the queue"); });
      expect(emptyExplorations(world, LAB)).toBe(0);
    });

    it("a human's line in a 1:1 with its manager", () => {
      const { world } = afterSignal(({ world, admin }) => {
        const m = world.ops.openOneOnOne(admin, LAB);
        world.ops.meetingSay(admin, m.id, "What should the lab look at next?");
      });
      expect(emptyExplorations(world, LAB)).toBe(0);
    });
  });
});

describe("the exploration journal (gr_6id9g7u9cj step 2)", () => {
  const MIN = 60_000;
  afterEach(() => vi.useRealTimers());
  const report = (world: ReturnType<typeof setup>["world"], mei: { id: string }, assignmentId: string, title: string, body: string) =>
    world.docs.upsert({ ...world.docs.all()[0]!, id: newId("dc"), type: "report", state: "building", title, body, authorId: mei.id, authorKind: "agent", buildingId: LAB, assignmentId, topicOf: undefined, tags: [], createdAt: nowIso(), updatedAt: nowIso() } as never);
  const spend = (world: ReturnType<typeof setup>["world"], mei: { id: string }, assignmentId: string, output: number) => world.sessions.upsert({
    id: newId("se"), agentId: mei.id, assignmentId, meetingId: null, purpose: "work", backend: "host", status: "done", model: "m",
    sdkSessionId: null, output, costUsd: 0, turns: 0, reportId: null, error: null, startedAt: nowIso(), endedAt: nowIso(), funding: null, lane: "exploration", grantId: null,
  });

  it("every goal-directed building with a manager gets the page; each explorer gets it attached and is told to read it first", () => {
    const { world, explorers } = setup();
    const a = exploreTick(world).started[0]!;
    const page = topicPage(world, LAB, JOURNAL_TITLE)!;
    expect(page).toMatchObject({ type: "wiki", topicOf: LAB, state: "building" });
    expect(page.body).toContain("(no explorations yet)");
    expect(topicPage(world, "town-hall", JOURNAL_TITLE)).toBeUndefined();
    expect(explorers()[0]!.pages).toEqual([page.id]);
    expect(a.description).toMatch(/First read the building's "Exploration journal"/);
    expect(a.description).toMatch(/Do not re-explore a direction the journal rules out unless what it waited on has moved/);
    expect(a.description).toMatch(/name the journal lines you built on/);
    // the fork's first message opens it in full
    const asg = world.assignments.require(a.id);
    expect(pagesForAssignment(world, LAB, asg).map((d) => d.id)).toEqual([page.id]);
  });

  it("each closed exploration adds one line on top: date, direction, outcome (nothing: the reason / proposed gr_x), tokens", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const T = Date.parse("2026-11-19T10:00:00Z");
    vi.setSystemTime(T);
    const { world, mei, by } = setup();
    const a = exploreTick(world, new Date(T)).started[0]!;
    spend(world, mei, a.id, 20_000);
    report(world, mei, a.id, "Nothing to propose: CI is already fast", "## What I did\nLooked.\n## Findings\n- **CI takes 4 min.** Under the 5-min goal, so no grant. More text.\n## What I need from you\nNothing needed.");
    world.assignments.patch(a.id, { status: "done" });
    vi.setSystemTime(T + MIN);
    exploreTick(world, new Date(T + MIN));
    let body = topicPage(world, LAB, JOURNAL_TITLE)!.body;
    const first = body.split("\n").find((l) => l.startsWith("- 2026"))!;
    expect(first).toMatch(/^- 2026-11-19 10:01 UTC \| "Nothing to propose: CI is already fast" \(dc_\w+\) \| nothing: CI takes 4 min\. \| [\d,]+ tokens$/);
    // a second exploration that proposes a grant goes on top; the page keeps a revision
    const t2 = T + exploreGapMs(1) + MIN;
    vi.setSystemTime(t2);
    const b = exploreTick(world, new Date(t2)).started[0]!;
    const fork = world.agents.upsert({ ...by("Noor"), id: newId("ag"), name: "Mei 1", forkOf: mei.id, forkN: 1, homeBuildingId: LAB, currentAssignmentId: b.id });
    await world.verbs.propose_grant(fork, { title: "Cache the typecheck", keyResults: [{ text: "Typecheck under 30 s", howToCheck: "Run it" }], objective: "o", steps: [{ size: "M", title: "Step 1", description: "Do it" }], stopCondition: "s", askTokens: 200_000 });
    report(world, mei, b.id, "Proposed: cache the typecheck", "## Findings\nIt is slow.");
    world.assignments.patch(b.id, { status: "done" });
    vi.setSystemTime(t2 + MIN);
    exploreTick(world, new Date(t2 + MIN));
    const page = topicPage(world, LAB, JOURNAL_TITLE)!;
    body = page.body;
    const lines = body.split("\n").filter((l) => l.startsWith("- 2026"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/\| "Proposed: cache the typecheck" \(dc_\w+\) \| proposed gr_\w+ "Cache the typecheck" \|/);
    expect(lines[1]).toBe(first);
    expect(revisionsOf(world, page.id).length).toBeGreaterThanOrEqual(1);
  });

  it("keeps the last 60 lines and any text a manager wrote above them", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let t = Date.parse("2026-11-19T00:00:00Z");
    vi.setSystemTime(t);
    const { world, mei } = setup();
    exploreTick(world, new Date(t));
    const old = Array.from({ length: 60 }, (_, i) => `- 2026-11-0${1 + (i % 9)} 00:00 UTC | "old ${i}" (dc_x) | nothing: x | 1 tokens`);
    writeTopicPage(world, mei as never, LAB, JOURNAL_TITLE, `Manager's note: CI speed is ruled out until 12-01.\n\n${old.join("\n")}`);
    const a = world.assignments.where("buildingId = ? AND reservationId IS NOT NULL", [LAB])[0]!;
    world.assignments.patch(a.id, { status: "done" });
    t += MIN; vi.setSystemTime(t);
    exploreTick(world, new Date(t));
    const body = topicPage(world, LAB, JOURNAL_TITLE)!.body;
    const lines = body.split("\n").filter((l) => /^- 20\d\d/.test(l));
    expect(lines).toHaveLength(JOURNAL_MAX_LINES);
    expect(lines[0]).toMatch(/\| no report \| nothing: the session ended without a report \|/);
    expect(lines.at(-1)).toBe(old[58]);
    expect(body.startsWith("Manager's note: CI speed is ruled out until 12-01.")).toBe(true);
  });

  it("a new page is seeded from the explorations that closed in the last 7 days", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const T = Date.parse("2026-11-10T00:00:00Z");
    vi.setSystemTime(T);
    const { world, mei } = setup();
    const a = exploreTick(world, new Date(T)).started[0]!;
    report(world, mei, a.id, "Old direction", "## Findings\nOld.");
    world.assignments.patch(a.id, { status: "done" });
    exploreTick(world, new Date(T + MIN));
    const t2 = T + 8 * 24 * 60 * MIN;
    vi.setSystemTime(t2);
    const b = exploreTick(world, new Date(t2)).started[0]!;
    report(world, mei, b.id, "Recent direction", "## Findings\nRecent.");
    world.assignments.patch(b.id, { status: "done" });
    exploreTick(world, new Date(t2 + MIN));
    // drop the page, as if it predates the change: the seed holds only the last 7 days
    world.docs.delete(topicPage(world, LAB, JOURNAL_TITLE)!.id);
    exploreTick(world, new Date(t2 + 2 * MIN));
    const body = topicPage(world, LAB, JOURNAL_TITLE)!.body;
    expect(body).toContain('"Recent direction"');
    expect(body).not.toContain('"Old direction"');
  });

  it("reportReason takes the first sentence of Findings", () => {
    expect(reportReason("## What I did\nx\n## Findings\n\n1. **The loop stopped.** It hit the cap.\n## What I need from you\nNothing.")).toBe("The loop stopped.");
    expect(reportReason("No sections here. Second.")).toBe("No sections here.");
  });
});
