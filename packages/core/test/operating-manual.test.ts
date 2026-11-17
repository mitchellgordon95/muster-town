/**
 * The operating manual (Mitchell, 1:1 mt_t65exni4et, 2026-11-15: "operating manual lgtm"): a Town Hall doc tagged
 * `operating-manual`, a town pin always on (design dc_8194l8soj4 §3), so every session's "## Pinned pages" carries it
 * beside the policy ledger and the dictionary, read live. Grant gr_y4s2j99vgm step 2.
 */
import { describe, expect, it } from "vitest";
import { createBuilding, createResident, managerStateBlock, managerSystemPrompt, pinnedPagesBlock, sessionMemory, updateBuilding, workStateBlock, workSystemPrompt } from "../src/index.ts";
import { createDoc, updateDoc } from "../src/domain.ts";
import { ensureDictionary } from "../src/dictionary.ts";
import { operatingManualDoc } from "../src/operating-manual.ts";
import { seededWorld } from "./helpers.ts";

const BODY = "From 1:1s mt_t65exni4et.\n\n## Jobs\nEvery piece of work is a job.\n\n## Needs and asks\nA need is an entry on a thread.\n\n## Documents\nEverything written is a document.";
const RULE = "- Forks never push to main without CI (origin: dc_x, 2026-11-01)";

function town() {
  const { world, seed, admin } = seededWorld();
  const sec = world.secretary.ensure()!;
  const dict = ensureDictionary(world)!;
  const ledger = world.secretary.ensurePolicyLedger()!;
  updateDoc(world, ledger.id, { body: `${ledger.body}${RULE}\n` });
  const b = createBuilding(world, { name: "Lab", headcount: 2 }, seed.admin.id);
  const pix = createResident(world, { buildingId: b.id, name: "Pix" });
  updateBuilding(world, b.id, { managerAgentId: pix.id });
  const fork = createResident(world, { buildingId: b.id, name: "Pix 2" });
  world.agents.patch(fork.id, { forkOf: pix.id });
  const manual = (state: "library" | "draft" = "library") => createDoc(world, { type: "article", state, buildingId: "town-hall", title: "Operating manual: jobs, threads and asks", tags: ["operating-manual"], authorId: sec.id, authorKind: "agent", body: BODY });
  const pinned = (id: string) => pinnedPagesBlock(world.skills.forAgent(id));
  return { world, seed, admin, sec, pix, fork: world.agents.require(fork.id), dict, ledger, building: world.buildings.require(b.id), manual, pinned };
}

/** Headings of the blocks step 2 deleted (design dc_8194l8soj4 §6): none may open a line of a prompt again. */
const OLD_HEADINGS = /^## (Operating manual|Policy ledger|Town dictionary|Skills)\b/m;

describe("the operating manual, the ledger and the dictionary as town pins (grant gr_y4s2j99vgm step 2)", () => {
  it("a manager's session has one ## Pinned pages with the manual and the ledger in full and the dictionary listed, and none of the old blocks", () => {
    const { world, pix, building, dict, ledger, manual, pinned } = town();
    const d = manual();
    expect(world.pins.where("docId = ?", [d.id])).toMatchObject([{ scope: "town", targetId: null, mode: "always", seeded: true, pinnedBy: "system" }]);
    const system = managerSystemPrompt(pix, building, world.town.get(), { skills: pinned(pix.id) });
    const first = managerStateBlock(world, pix, building);
    const both = `${system}\n\n${first}`;
    expect(both.match(/^## Pinned pages$/gm)).toHaveLength(1);
    expect(both).not.toMatch(OLD_HEADINGS);
    expect(system).toContain(`### Operating manual: jobs, threads and asks (${d.id}, town pin, always on)\n${BODY}`);
    expect(system).toContain(`(${ledger.id}, town pin, always on)\n${RULE}`);
    expect(system).toContain(`- Town dictionary (${dict.id}, town pin): One meaning per word.`);
    // the ledger's head line (how the ledger works) stays out: only its rules
    expect(system).not.toContain("One rule per line, with where it came from");
  });

  it("a fork's work session carries the same block (its manager's pins), and its first message none of the old blocks", () => {
    const { world, pix, fork, building, manual, pinned } = town();
    manual();
    const block = pinned(fork.forkOf!);
    expect(block).toBe(pinned(pix.id));
    expect(workSystemPrompt(fork, building, world.town.get(), { skills: block })).toContain(BODY);
    expect(workStateBlock(fork, sessionMemory(world, fork, building))).not.toMatch(OLD_HEADINGS);
  });

  it("read live: a rewrite shows at the next session; a later copy is neither the manual nor pinned", () => {
    const { world, sec, pix, manual, pinned } = town();
    const d = manual();
    updateDoc(world, d.id, { body: `${BODY}\n\n## Where to look\nThe hydrant.` });
    expect(pinned(pix.id)).toContain("The hydrant.");
    const copy = createDoc(world, { type: "note", state: "building", buildingId: "town-hall", title: "copy", tags: ["operating-manual"], authorId: sec.id, authorKind: "agent", body: "a copy" });
    expect(operatingManualDoc(world)!.id).toBe(d.id);
    expect(world.pins.where("docId = ?", [copy.id])).toEqual([]);
  });

  it("the page's writer is told it keeps it (the generic canWrite line): the Secretary, not a manager", () => {
    const { sec, pix, manual, pinned } = town();
    const d = manual();
    expect(pinned(sec.id)).toContain(`You keep this page: when what it says changes, rewrite it whole with \`write\` (id ${d.id}).`);
    expect(pinned(pix.id)).not.toContain("You keep this page");
  });

  it("a draft is not the manual; publishing it seeds its pin once, and a pin a human removes is not re-created", async () => {
    const { world, admin, sec, manual } = town();
    const d = manual("draft");
    expect(operatingManualDoc(world)).toBeUndefined();
    expect(world.pins.where("docId = ?", [d.id])).toEqual([]);
    await world.verbs.write(sec, { id: d.id, type: "article", title: d.title, body: BODY, state: "building" });
    const [pin] = world.pins.where("docId = ?", [d.id]);
    expect(pin).toMatchObject({ mode: "always", seeded: true });
    expect(world.skills.removePin(admin, pin!)).toEqual({ removed: true });
    await world.verbs.write(sec, { id: d.id, type: "article", title: d.title, body: `${BODY}\nMore.`, state: "building" });
    expect(world.pins.where("docId = ?", [d.id])).toEqual([]);
  });

  it("a visitor's welcome carries the pinned block in place of the manual", async () => {
    const { world, seed, building, manual } = town();
    manual();
    const r = world.ops.registerVisitor(seed.admin.id, { name: "Vee", inheritsOwner: false, buildingId: building.id });
    const welcome = (await world.verbs.look(world.agents.require(r.agent.id), {}) as { welcome?: { pinned?: string; manual?: string } }).welcome;
    expect(welcome?.pinned).toContain(BODY);
    expect(welcome?.manual).toBeUndefined();
  });
});
