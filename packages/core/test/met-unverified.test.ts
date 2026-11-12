/**
 * "Met, unverified" (1:1 mt_msnjkpgwdb decision 9): a grant closed as done marks a key result met only when its
 * evidence names a live check; on code and tests alone it is "met, unverified", shown as such, and nobody is asked
 * about it. A human can still flip it to met or missed; only missed wakes the manager.
 */
import { describe, expect, it } from "vitest";
import { isJudgedKr, krStatusWords, krVerdict } from "@muster-town/schema";
import { buildingQueue, createBuilding, createResident, jobThread, keyResultEntry, namesLiveCheck, openManagerEntries, statusAtClose, updateBuilding } from "../src/index.ts";
import { checkRollupAsks } from "../src/asks.ts";
import { krCountsByGrant } from "../src/finance-spend.ts";
import { creditBank, seededWorld } from "./helpers.ts";

describe("namesLiveCheck: does evidence name a live check (pure core)", () => {
  const LIVE = [
    "https://muster.town/workshop/#/grant/gr_x shows the banner",
    "GET https://muster.town/api/jobs/gr_9mp6v6vv8k returns rule ceiling and one entry per report",
    "Seen on https://town.example.org/api/health: startedAt 16:58Z",
    "Checked live: the in-tray shows no approve-only rows.",
    "PR #439 merged; verified it live after the redeploy.",
    "Notice nt_ab12cd34ef says step 2 of 4 landed.",
    "Event 71234 is the wake; the manager session started.",
    "The live town shows 100 % on the Uptime block.",
    "Measured in prod: 12 ms per tick.",
  ];
  const NOT_LIVE = [
    "",
    "   ",
    "PR #432, commit 6b101b0a, tests green.",
    "https://github.com/mitchellgordon95/agent-town/pull/435 merged",
    "Code on main (hud.tsx:177-184); unit tests pass.",
    "Ran it at http://localhost:4322/api/jobs/gr_x and it returned the thread.",
    "See dc_k90p1i7q74 for the report.",
    "Closed as done by Mitchell from the Town Hall.",
    "It will go live with the next redeploy.",
  ];
  it("a live URL, a notice or event id, or the words that someone saw it live count", () => {
    for (const e of LIVE) expect(namesLiveCheck(e), e).toBe(true);
  });
  it("a PR, a commit, a code host link, a local address, a doc id or a bare close do not", () => {
    for (const e of NOT_LIVE) expect(namesLiveCheck(e), e).toBe(false);
  });
  it("properties: adding live evidence never makes it unverified; code-only text stays unverified however much of it there is; it is total", () => {
    for (const a of NOT_LIVE) {
      for (const b of LIVE) {
        expect(namesLiveCheck(`${a}\n${b}`)).toBe(true);
        expect(namesLiveCheck(`${b} ${a}`)).toBe(true);
      }
      for (const b of NOT_LIVE) expect(namesLiveCheck(`${a}\n${b}`), `${a} | ${b}`).toBe(false);
    }
    for (const junk of ["https://", "http://)", "nt_", "event", "live", "\n\n", "🙂".repeat(50)]) expect(typeof namesLiveCheck(junk)).toBe("boolean");
  });
  it("statusAtClose: met when the close note or the key result's own claimed evidence names a live check, else met-unverified", () => {
    expect(statusAtClose("All done.", "")).toBe("met-unverified");
    expect(statusAtClose("All done.", "https://muster.town/api/uptime returns 100")).toBe("met");
    expect(statusAtClose("Checked live on the Town health tab.", "PR #441")).toBe("met");
    expect(statusAtClose("PR #441 merged.", "tests green")).toBe("met-unverified");
  });
  it("the status reads as judged, shipped, and in words", () => {
    expect(isJudgedKr("met-unverified")).toBe(true);
    expect(krVerdict("met-unverified")).toBe("shipped");
    expect(krStatusWords("met-unverified")).toBe("met, unverified");
    expect(krStatusWords("not-started")).toBe("not started");
  });
});

const KRS = [
  { text: "A banner on the lab", howToCheck: "Open the lab" },
  { text: "A resume after a restart", howToCheck: "Cut a session and watch it resume" },
];
function lab() {
  const s = seededWorld();
  const { world, seed, admin } = s;
  const b = createBuilding(world, { name: "Closey", headcount: 3, model: "claude-opus-5-5", cheapModel: "claude-haiku-5-5" }, seed.admin.id);
  const pix = createResident(world, { buildingId: b.id, name: "Pix" });
  updateBuilding(world, b.id, { managerAgentId: pix.id });
  creditBank(world);
  const g0 = world.grantDesk.propose(null, world.grantDesk.create(null, b.id, { keyResults: KRS, objective: "A banner", approach: "a", steps: [{ size: "M", title: "Build it", description: "Ship it" }], stopCondition: "s", askTokens: 150_000 }).id);
  const g = world.grantDesk.decide(admin, g0.id, { action: "fund" });
  const krs = () => world.grantDesk.keyResultsOf(g.id);
  return { ...s, b: world.buildings.require(b.id), pix: world.agents.require(pix.id), g, krs };
}

describe("a grant closed as done: met, or met, unverified", () => {
  it("each open key result is met when its evidence names a live check, else met, unverified; both are archived, and the close entry says which", () => {
    const { world, pix, g, krs } = lab();
    const [banner, resume] = krs();
    // a fork claimed the first with live evidence; the second stands on code
    world.grantDesk.updateKeyResult(pix, banner!.id, { status: "claimed", note: "https://muster.town/closey shows the banner" });
    world.grantDesk.updateKeyResult(pix, resume!.id, { status: "claimed", note: "PR #390, unit tests pass" });
    world.grantDesk.closeDone(pix, g.id, { note: "Both merged in PR #390." });
    const after = krs();
    expect(after.map((k) => k.status)).toEqual(["met", "met-unverified"]);
    expect(after.every((k) => !!k.archivedAt)).toBe(true);
    expect(after[1]).toMatchObject({ evidence: "claimed", statusNote: "Both merged in PR #390." });
    const close = jobThread(world, g.id)!.entries.find((e) => e.moved.action === "close")!;
    expect(close.note).toContain(`Key results: 1 met, 1 met, unverified (${resume!.id}): no live check named.`);
    // nothing of it is in the manager's queue, and no ask was filed about it
    expect(openManagerEntries(world, g.buildingId)).toEqual([]);
    expect(world.asks.count("targetKind = 'keyResult'")).toBe(0);
    expect(buildingQueue(world, g.buildingId)).toEqual([]);
  });

  it("a close whose note names a live check marks them met; a human's bare close marks them met, unverified", () => {
    const one = lab();
    one.world.grantDesk.closeDone(one.pix, one.g.id, { note: "Checked live: both show on the lab page." });
    expect(one.krs().map((k) => k.status)).toEqual(["met", "met"]);
    const two = lab();
    two.world.grantDesk.closeDone(two.admin, two.g.id, { note: "" });
    expect(two.krs().map((k) => k.status)).toEqual(["met-unverified", "met-unverified"]);
  });

  it("nobody is asked about it: an ask that targets a met, unverified key result is refused", () => {
    const { world, pix, g, krs } = lab();
    world.grantDesk.closeDone(pix, g.id, { note: "Merged." });
    const kr = krs()[0]!;
    expect(() => checkRollupAsks(world, "", [{ type: "click", targetId: kr.id, title: "Keep it met?", body: "Pix has waited since today.", branches: [{ label: "Keep met" }, { label: "Flip" }], recommendation: "Keep met" }]))
      .toThrow(/is "met, unverified".*asks no human about it/);
  });

  it("a human flips it: to met it is verified and wakes nobody; to missed it wakes the manager; an agent can't set or change it", () => {
    const { world, admin, pix, g, krs, b } = lab();
    world.grantDesk.closeDone(pix, g.id, { note: "Merged." });
    const [a, c] = krs();
    const last = () => world.events.list({ buildingId: b.id, types: ["kr.updated"], limit: 100 }).at(-1)!;
    expect(world.grantDesk.updateKeyResult(admin, a!.id, { status: "met", note: "saw it" })).toMatchObject({ status: "met", evidence: "verified" });
    expect(keyResultEntry(world, last())!.level).toBe("none");
    world.grantDesk.updateKeyResult(admin, c!.id, { status: "missed", note: "never resumed" });
    expect(keyResultEntry(world, last())).toMatchObject({ level: "manager", moved: { action: "marked", status: "missed" } });
    expect(openManagerEntries(world, b.id)).toHaveLength(1);
    expect(() => world.grantDesk.updateKeyResult(pix, a!.id, { status: "claimed" })).toThrow(/building\.fund/);
    expect(() => world.grantDesk.updateKeyResult(admin, a!.id, { status: "met-unverified" })).toThrow(/set when a grant closes/);
  });

  it("Bank Spending counts it apart from met", () => {
    const { world, pix, g, krs } = lab();
    world.grantDesk.updateKeyResult(pix, krs()[0]!.id, { status: "claimed", note: "seen live on the lab page" });
    world.grantDesk.closeDone(pix, g.id, { note: "Merged." });
    expect(krCountsByGrant(world.keyResults.where("grantId = ?", [g.id])).get(g.id)).toEqual({ met: 1, unverified: 1, missed: 0, claimed: 0, open: 0 });
  });
});
