/**
 * The operating manual (Mitchell, 1:1 mt_t65exni4et, 2026-11-15: "operating manual lgtm"): a Town Hall doc tagged
 * `operating-manual`, pinned in every session's first message beside the policy ledger and the dictionary, read live.
 */
import { describe, expect, it } from "vitest";
import { createBuilding, createResident, managerStateBlock, sessionMemory, updateBuilding, workStateBlock } from "../src/index.ts";
import { createDoc, updateDoc } from "../src/domain.ts";
import { ensureDictionary } from "../src/dictionary.ts";
import { MANUAL_PIN_CAP, operatingManualBlock, operatingManualDoc } from "../src/operating-manual.ts";
import { seededWorld } from "./helpers.ts";

const BODY = "From 1:1s mt_t65exni4et.\n\n## Jobs\nEvery piece of work is a job.\n\n## Needs and asks\nA need is an entry on a thread.\n\n## Documents\nEverything written is a document.";

function town() {
  const { world, seed } = seededWorld();
  const sec = world.secretary.ensure()!;
  ensureDictionary(world);
  const b = createBuilding(world, { name: "Lab", headcount: 2 }, seed.admin.id);
  const pix = createResident(world, { buildingId: b.id, name: "Pix" });
  updateBuilding(world, b.id, { managerAgentId: pix.id });
  const fork = createResident(world, { buildingId: b.id, name: "Pix 2" });
  const manual = () => createDoc(world, { type: "article", state: "library", buildingId: "town-hall", title: "Operating manual: jobs, threads and asks", tags: ["operating-manual"], authorId: sec.id, authorKind: "agent", body: BODY });
  return { world, sec, pix, fork, building: world.buildings.require(b.id), manual };
}

describe("the operating manual in every first message", () => {
  it("nothing before the doc exists; then its text in full, with its id, beside the dictionary", () => {
    const { world, fork, building, manual } = town();
    expect(operatingManualBlock(world)).toBe("");
    const d = manual();
    const block = operatingManualBlock(world);
    expect(block).toContain(`## Operating manual (${d.id}, kept by the Secretary`);
    expect(block).toContain(BODY);
    const state = workStateBlock(fork, sessionMemory(world, fork, building));
    expect(state).toContain(BODY);
    expect(state).toContain("## Town dictionary");
  });

  it("a team-lead session's first message carries it too", () => {
    const { world, pix, building, manual } = town();
    manual();
    expect(managerStateBlock(world, pix, building)).toContain(BODY);
  });

  it("read live: a rewrite shows at the next session; a later copy never takes the first one's place", () => {
    const { world, sec, fork, building, manual } = town();
    const d = manual();
    updateDoc(world, d.id, { body: `${BODY}\n\n## Where to look\nThe hydrant.` });
    expect(workStateBlock(fork, sessionMemory(world, fork, building))).toContain("The hydrant.");
    createDoc(world, { type: "note", state: "building", buildingId: "town-hall", title: "copy", tags: ["operating-manual"], authorId: sec.id, authorKind: "agent", body: "a copy" });
    expect(operatingManualDoc(world)!.id).toBe(d.id);
  });

  it("only the Secretary's copy says the page is its own to rewrite", () => {
    const { world, sec, fork, manual } = town();
    const d = manual();
    expect(operatingManualBlock(world, sec)).toContain(`You own this page`);
    expect(operatingManualBlock(world, sec)).toContain(`id ${d.id}`);
    expect(operatingManualBlock(world, fork)).not.toContain("You own this page");
  });

  it("past the cap it pins the Needs and asks section in full and links the rest", () => {
    const { world, manual } = town();
    const d = manual();
    updateDoc(world, d.id, { body: `${BODY}\n\n## Appendix\n${"x".repeat(MANUAL_PIN_CAP)}` });
    const block = operatingManualBlock(world);
    expect(block).toContain("## Needs and asks\nA need is an entry on a thread.");
    expect(block).not.toContain("## Jobs");
    expect(block).toContain(`\`read\` ${d.id} for the rest`);
  });

  it("a draft is not the manual", () => {
    const { world, sec } = town();
    createDoc(world, { type: "article", state: "draft", buildingId: "town-hall", title: "draft", tags: ["operating-manual"], authorId: sec.id, authorKind: "agent", body: "draft" });
    expect(operatingManualDoc(world)).toBeUndefined();
  });
});
