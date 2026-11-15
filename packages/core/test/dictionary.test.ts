/**
 * Build step 10 of docs/legible-delegation.md (§5 "A town dictionary"): the Town Hall's dictionary doc, the block every
 * manager's first message pins, and the ask linter's `dictionary` rule reading its avoid → use pairs.
 */
import { lintAskBody } from "@muster-town/schema";
import { describe, expect, it } from "vitest";
import { createBuilding, createResident, managerStateBlock, updateBuilding } from "../src/index.ts";
import { createAsk } from "../src/asks.ts";
import { dictionaryBlock, dictionaryPairs, ensureDictionary } from "../src/dictionary.ts";
import { seededWorld } from "./helpers.ts";

describe("the town dictionary (docs/legible-delegation.md §5)", () => {
  it("seeded at boot: one Town Hall dictionary doc with the words and the avoid → use list, made once", () => {
    const { world } = seededWorld();
    expect(dictionaryBlock(world)).toBe("");
    const d = ensureDictionary(world)!;
    expect(d).toMatchObject({ type: "dictionary", buildingId: "town-hall", title: "Town dictionary" });
    for (const w of ["ask", "notice", "record", "gate", "ceiling", "size", "verified", "claimed", "unknown", "fund / counter / reject", "adjust / cut", "hold", "slate", "ledger"]) expect(d.body).toContain(`- **${w}**:`);
    expect(d.body).toContain("- top-up → adjust");
    expect(ensureDictionary(world)!.id).toBe(d.id);
    expect(world.docs.count("type = 'dictionary'")).toBe(1);
    expect(dictionaryPairs(world)).toEqual(expect.arrayContaining([{ avoid: "top-up", use: "adjust" }, { avoid: "checkpoint card", use: "gate" }, { avoid: "approve a grant", use: "fund" }]));
  });

  it("the pinned block is in every manager's first message, under 120 words", () => {
    const { world, seed } = seededWorld();
    ensureDictionary(world);
    const b = createBuilding(world, { name: "Lab", headcount: 2 }, seed.admin.id);
    const pix = createResident(world, { buildingId: b.id, name: "Pix" });
    updateBuilding(world, b.id, { managerAgentId: pix.id });
    const block = dictionaryBlock(world);
    expect(block.split(/\s+/).filter(Boolean).length).toBeLessThan(120);
    expect(block).toContain("Avoid → use: top-up → adjust, checkpoint card → gate, approve a grant → fund");
    expect(managerStateBlock(world, pix, world.buildings.require(b.id))).toContain(block);
  });

  it("the lint rule warns on an avoided word and names the replacement", () => {
    const pairs = [{ avoid: "top-up", use: "adjust" }, { avoid: "checkpoint card", use: "gate" }];
    expect(lintAskBody("It needs a top up of 150k.", { dictionary: pairs }).filter((p) => p.startsWith("dictionary"))).toEqual(['dictionary: the dictionary avoids "top-up" in "It needs a top up of 150k.": use "adjust"']);
    expect(lintAskBody("Two top-ups came in.", { dictionary: pairs }).find((p) => p.startsWith("dictionary"))).toContain('use "adjust"');
    expect(lintAskBody("Raise the ceiling by 150k.", { dictionary: pairs }).filter((p) => p.startsWith("dictionary"))).toEqual([]);
    expect(lintAskBody("It needs a top-up.", {}).filter((p) => p.startsWith("dictionary"))).toEqual([]);
    // in the town, the pairs come from the Town Hall doc when a card is stored
    const { world } = seededWorld();
    ensureDictionary(world);
    const { ask } = createAsk(world, { type: "click", buildingId: null, sourceDocId: null, title: "Look at the checkpoint card", body: "Pix has waited since Monday. Open the checkpoint card once and this never comes back.", branches: [{ label: "Done" }, { label: "Decline" }], recommendation: "Done" });
    expect(ask.tags).toEqual([]);
    expect(ask.history.find((h) => h.action === "lint")!.note).toContain('"checkpoint card" in "Open the checkpoint card once and this never comes back.": use "gate"');
  });
});

describe("needs and asks in the dictionary (1:1 mt_t65exni4et)", () => {
  it("a dictionary seeded before needs gets the need line after ask, rewords the seed's ask line, keeps a human's edit, and is idempotent", () => {
    const { world } = seededWorld();
    const d = ensureDictionary(world)!;
    expect(d.body).toMatch(/^- \*\*need\*\*: a fact on a job's thread/m);
    // as seeded before needs
    const old = d.body.replace(/^- \*\*need\*\*:.*\n/m, "").replace(/^- \*\*ask\*\*:.*$/m, "- **ask**: something only a human can do, stored with its type, target, branches and recommendation. The human decides it.");
    world.docs.patch(d.id, { body: old });
    const fixed = ensureDictionary(world)!;
    expect(fixed.body).toMatch(/^- \*\*ask\*\*: the card in the decision queue: a view of one need.*\n- \*\*need\*\*: /m);
    expect(ensureDictionary(world)!.body).toBe(fixed.body);
    // a human's own ask line stays
    world.docs.patch(d.id, { body: old.replace(/^- \*\*ask\*\*:.*$/m, "- **ask**: Mitchell's words.") });
    expect(ensureDictionary(world)!.body).toMatch(/^- \*\*ask\*\*: Mitchell's words\.\n- \*\*need\*\*: /m);
  });
});
