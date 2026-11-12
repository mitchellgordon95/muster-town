/**
 * The Secretary runs after every human decision on a Town Hall ask (1:1 mt_msnjkpgwdb decisions 10 and 20a): one
 * debounced run that settles the asks the decision made moot (click and policy only), re-ranks, and tells the filing
 * building. It never touches a money, credential or meeting ask, nor a request a human must carry out.
 */
import { describe, expect, it } from "vitest";
import { buildingRoleId, openManagerEntries } from "../src/index.ts";
import { createAsk, decideAsk, rankedAsks } from "../src/asks.ts";
import { decideRetainer } from "../src/retainers.ts";
import { DECISION_RUN_DEBOUNCE_MS, DECISION_RUNS_PER_DAY } from "../src/secretary.ts";
import { creditBank, seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const RUN = "Settle and re-rank after a decision";

function setup(opts: { fundRetainer?: boolean } = {}) {
  const s = seededWorld();
  const { world, admin } = s;
  creditBank(world, 10_000_000);
  const manager = world.agents.first("homeBuildingId = ? AND kind != 'human'", [LAB])!;
  world.permissions.grant(manager, buildingRoleId(LAB, "manager"));
  world.buildings.patch(LAB, { managerAgentId: manager.id });
  const sec = world.secretary.ensure()!;
  const schedule = world.secretary.ensureRankSchedule()!;
  if (opts.fundRetainer ?? true) decideRetainer(world, admin, schedule.id, { action: "approve", note: "" });
  const proposal = (objective: string) => world.grantDesk.propose(manager, world.grantDesk.create(manager, LAB, {
    keyResults: [{ text: "Banner shows Usage", howToCheck: "Open the lab banner" }], objective, approach: "a banner line", steps: [{ size: "M", title: "Step 1", description: "Do the work" }], stopCondition: "two failed tries", askTokens: 300_000,
  }).id);
  const click = (title: string, extra: { targetKind?: "request" | "rule"; targetId?: string; type?: "click" | "policy" | "credential" } = {}) => createAsk(world, {
    type: extra.type ?? "click", targetKind: extra.targetKind ?? null, targetId: extra.targetId ?? null, buildingId: LAB, sourceDocId: null, by: manager.id,
    title, body: "Pix has waited on this since today.", branches: [{ label: "Done" }, { label: "Decline" }], recommendation: "Done",
  }).ask;
  const runs = () => world.assignments.where("agentId = ? AND title = ?", [sec.id, RUN], "ORDER BY createdAt, rowid");
  return { ...s, world, manager, sec, schedule, proposal, click, runs };
}

describe("a human decision on an ask wakes one Secretary run, debounced", () => {
  it("the first decision queues one run on the ranking retainer that waits out the debounce; decisions meanwhile add a line, not a run", () => {
    const { world, admin, sec, schedule, proposal, click, runs } = setup();
    const a = click("Press Let in for the test account"), b = click("Confirm the banner colour");
    const g = proposal("A banner");
    click("Stays open, so there is something left to rank");
    const at = new Date();
    decideAsk(world, admin, a.id, "Done", "let in");
    const [run] = runs();
    expect(runs()).toHaveLength(1);
    expect(run).toMatchObject({ agentId: sec.id, status: "pending", lane: "retainer", sourceId: schedule.id, queue: "agent", model: schedule.model });
    const wait = Date.parse((run!.waitFor as { after: string }).after) - at.getTime();
    expect(wait).toBeGreaterThan(DECISION_RUN_DEBOUNCE_MS - 5_000);
    expect(wait).toBeLessThanOrEqual(DECISION_RUN_DEBOUNCE_MS + 5_000);
    expect(run!.description).toContain("Settle what the decision made moot");
    expect(run!.description).toContain(`(ask ${a.id})`);
    // it traces to the human who decided, so what the Secretary tells a building reaches its manager
    expect(run!.origin).toMatchObject({ userId: world.holderOf(admin).id });
    // a second and a third decision inside the window: the same run, one more line each (a grant decision counts too)
    decideAsk(world, admin, b.id, "Decline", "");
    world.grantDesk.decide(admin, g.id, { action: "reject", note: "not now" });
    expect(runs()).toHaveLength(1);
    const lines = runs()[0]!.description.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(`(ask ${b.id})`);
    expect(lines[2]).toContain(`(about ${g.id})`);
  });

  it("a decision while a run is under way queues one more; nothing is queued with the retainer unapproved, the Secretary stopped, or no ask left open", () => {
    const one = setup();
    const a = one.click("One"), b = one.click("Two");
    one.click("Three");
    decideAsk(one.world, one.admin, a.id, "Done");
    one.world.assignments.patch(one.runs()[0]!.id, { status: "active" });
    decideAsk(one.world, one.admin, b.id, "Done");
    expect(one.runs().map((r) => r.status)).toEqual(["active", "pending"]);

    const unfunded = setup({ fundRetainer: false });
    const c = unfunded.click("One");
    unfunded.click("Two");
    decideAsk(unfunded.world, unfunded.admin, c.id, "Done");
    expect(unfunded.runs()).toEqual([]);

    const stopped = setup();
    const d = stopped.click("One");
    stopped.click("Two");
    stopped.world.setStatus(stopped.sec.id, "stopped");
    decideAsk(stopped.world, stopped.admin, d.id, "Done");
    expect(stopped.runs()).toEqual([]);

    const last = setup();
    for (const live of rankedAsks(last.world)) last.world.asks.patch(live.id, { status: "retired" });
    const e = last.click("The only one");
    decideAsk(last.world, last.admin, e.id, "Done");
    expect(last.runs()).toEqual([]);
  });

  it("at most DECISION_RUNS_PER_DAY runs a day draw on the ranking retainer: past the cap a decision waits for the next ranking", () => {
    const { world, admin, click, runs } = setup();
    click("Stays open");
    for (let i = 0; i < DECISION_RUNS_PER_DAY + 2; i++) {
      decideAsk(world, admin, click(`Click ${i}`).id, "Done");
      // each run finished before the next decision, so the debounce does not merge them
      for (const r of runs().filter((x) => x.status === "pending")) world.assignments.patch(r.id, { status: "done" });
    }
    expect(runs()).toHaveLength(DECISION_RUNS_PER_DAY);
  });

  it("an agent's or the town's act is not a human decision: a manager withdrawing its proposal queues nothing", () => {
    const { world, manager, proposal, click, runs } = setup();
    click("Still open");
    const g = proposal("A banner");
    world.grantDesk.withdraw(manager, g.id, "wrong plan");
    expect(world.asks.count("targetId = ? AND status = 'retired'", [g.id])).toBe(1);
    expect(runs()).toEqual([]);
  });
});

describe("the decision run: rank lists what was decided and its candidates; overtaken closes them", () => {
  it("the rank read names each decision since the last ranking and the open asks it may have overtaken", async () => {
    const { world, admin, sec, proposal, click } = setup();
    const g = proposal("A banner");
    const waits = click(`Let the test account in so ${g.id} can be checked live`);
    const other = click("Unrelated click");
    world.grantDesk.decide(admin, g.id, { action: "reject", note: "not now" });
    const read = await world.verbs.rank(sec, {}) as { inputs: string };
    const section = read.inputs.slice(read.inputs.indexOf("Decided since the last ranking"));
    expect(section).toContain(`may have overtaken: ${waits.id} (click)`);
    expect(section).not.toContain(other.id);
  });

  it("overtaken closes a click ask with the note, tells its building on its thread, and reopens what was deferred behind it; one call can also re-rank", async () => {
    const { world, admin, sec, manager, proposal, click, runs } = setup();
    const g = proposal("A banner");
    const waits = click(`Let the test account in so ${g.id} can be checked live`);
    const keep = click("Unrelated click");
    const behind = click("Rename the banner");
    await world.verbs.rank(sec, { defer: [{ askId: behind.id, until: waits.id }] });
    world.grantDesk.decide(admin, g.id, { action: "reject", note: "not now" });
    const before = runs().length;
    const out = await world.verbs.rank(sec, {
      overtaken: [{ askId: waits.id, because: `${g.id} rejected by Mitchell`, note: "The grant it was for is rejected, so nobody needs the account let in." }],
      order: [keep.id, behind.id],
    }) as unknown as { overtaken: string[]; ranked: number };
    expect(out).toMatchObject({ overtaken: [waits.id], ranked: 2 });
    const closed = world.asks.require(waits.id);
    expect(closed).toMatchObject({ status: "retired", decidedBy: null });
    expect(closed.retiredBy).toBe(`Overtaken by ${g.id} rejected by Mitchell: The grant it was for is rejected, so nobody needs the account let in.`);
    expect(closed.history.at(-1)).toMatchObject({ action: "retire", by: sec.id });
    // deferred behind it: open again, and ranked
    expect(world.asks.require(behind.id)).toMatchObject({ status: "open", rank: 2 });
    expect(world.asks.require(keep.id).rank).toBe(1);
    // the filing building hears it: one entry on its own thread for its manager, which it acknowledges
    const [heard] = openManagerEntries(world, LAB).filter((e) => e.moved.rule === "overtaken");
    expect(heard).toMatchObject({ authorKind: "secretary", authorId: sec.id, level: "manager", jobId: `jb_${LAB}`, moved: { askIds: [waits.id] } });
    expect(heard!.body).toContain("nobody needs the account let in");
    await world.verbs.review(manager, { docId: heard!.id, decision: "approve", note: "" });
    // the Secretary's own close is not a human decision: no further run
    expect(runs()).toHaveLength(before);
  });

  it("it never closes a money, credential or meeting ask, nor a request a human must carry out; a refused call changes nothing", async () => {
    const { world, sec, manager, proposal, click } = setup();
    const g = proposal("A banner");
    const money = world.asks.first("targetId = ? AND status = 'open'", [g.id])!;
    const cred = click("Paste the monitor's API key", { type: "credential" });
    const ok = click("A plain click");
    const req = await world.verbs.request_human(manager, { title: "Photograph the gauge", body: "please", location: "x" });
    const doAsk = world.asks.first("targetKind = 'request' AND targetId = ?", [req.id])!;
    const because = "ak_decided by Mitchell";
    for (const bad of [money, cred, doAsk]) {
      await expect(world.verbs.rank(sec, { overtaken: [{ askId: ok.id, because, note: "moot" }, { askId: bad.id, because, note: "moot" }] })).rejects.toThrow(/only a human settles it/);
      expect(world.asks.require(bad.id).status).toBe("open");
      // all or nothing: the click listed beside it stays open too
      expect(world.asks.require(ok.id).status).toBe("open");
    }
    await expect(world.verbs.rank(sec, { overtaken: [{ askId: ok.id, because, note: "moot" }], order: [ok.id] })).rejects.toThrow(/being closed as overtaken/);
    await expect(world.verbs.rank(manager, { overtaken: [{ askId: ok.id, because, note: "moot" }] })).rejects.toThrow(/Secretary/);
    expect(world.asks.require(ok.id).status).toBe("open");
  });
});
