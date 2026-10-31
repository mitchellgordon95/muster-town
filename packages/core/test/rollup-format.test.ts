import { parseRollup, rollupHasCards, rollupNeedsIds, rollupWarnings, withNeedsLine } from "@muster-town/schema";
import { describe, expect, it } from "vitest";
import { buildingRoleId, managerIntrayBlock } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const ITEM = (n: number, title: string) => `**${n}. ${title}**\n**What it is:** a ${title.toLowerCase()}.\n**What you'd see:** Map → Bank, 21 rows.\n![The Bank page](/api/media/mf_4flit5fmtz.png)\n**Your call:** None.`;
const ROLLUP = `Live: 869f76d.\n\n## Shipped\n\n${ITEM(1, "Spend chart")}\n\n${ITEM(2, "Cards")}\n\n**In flight:** Root resizes the panel.\n\n## Decided\n- dc_a → approved\n\n## Key results\n| KR | status |\n|---|---|\n| kr_x | on-track |\n\n## Needs from Mitchell\nNothing needed.`;
// the plain lists every manager but Pix wrote before the format became the default
const OLD = "## Shipped\n- 41236ee: no truncation\n\n## Decided\n- dc_a → approved\n\n## Key results\non-track\n\n## Needs from Mitchell\nNothing needed.";

describe("the rollup format (1:1 mt_vcn0e66r1t)", () => {
  it("parses Shipped items into what it is / what you'd see / picture / your call", () => {
    const p = parseRollup(ROLLUP);
    expect(p.missingSections).toEqual([]);
    expect(p.before).toBe("Live: 869f76d.");
    expect(p.items).toHaveLength(2);
    expect(p.items[0]).toMatchObject({ title: "Spend chart", whatItIs: "a spend chart.", whatYoudSee: "Map → Bank, 21 rows.", yourCall: "None.", pictures: [{ alt: "The Bank page", src: "/api/media/mf_4flit5fmtz.png" }], missing: [] });
    expect(p.items[1]!.after).toBe("**In flight:** Root resizes the panel.");
    expect(p.after.startsWith("## Decided")).toBe(true);
    expect(rollupHasCards(p)).toBe(true);
    expect(rollupWarnings(p)).toEqual([]);
  });
  it("accepts plain labels (rollup 16, dc_55a4u8lzn4) and other numbering", () => {
    const p = parseRollup("## Shipped\n1. **Pictures**\nWhat it is: uploads.\nWhat you'd see: thumbnails.\nYour call: none.\n## Decided\nx");
    expect(p.items[0]).toMatchObject({ title: "Pictures", whatItIs: "uploads.", yourCall: "none.", missing: [] });
    expect(p.missingSections).toEqual(["Key results", "Needs from Mitchell"]);
  });
  it("old-style lists have no cards and warn nothing per item; unlabelled items, too many items or pictures warn", () => {
    const old = parseRollup(OLD);
    expect(old.items).toEqual([]);
    expect(rollupHasCards(old)).toBe(false);
    const bare = parseRollup(`## Shipped\n1. Thing one\nIt shipped.\n${[2, 3, 4].map((n) => ITEM(n, `Item ${n}`)).join("\n\n")}\n## Decided\n## Key results\n## Needs from Mitchell`);
    expect(rollupHasCards(bare)).toBe(false);
    expect(bare.items[0]).toMatchObject({ whatItIs: "It shipped.", missing: ["What it is", "What you'd see", "Your call"] });
    const w = rollupWarnings(bare);
    expect(w[0]).toMatch(/Shipped item 1 \("Thing one"\) lacks \*\*What it is:\*\*, \*\*What you'd see:\*\*, \*\*Your call:\*\*/);
    expect(w).toContainEqual(expect.stringMatching(/4 Shipped items; keep it to 3/));
    expect(w).toContainEqual(expect.stringMatching(/3 pictures; keep it to 2/));
  });
  it("submit_report refuses a rollup without the four headings, warns on unlabelled items, and keeps accepting old rollups", async () => {
    const { world, by, admin } = seededWorld();
    const mei = by("Mei"), noor = by("Noor");
    world.ops.updateBuilding(admin, LAB, { managerAgentId: mei.id });
    world.permissions.grant({ kind: "agent", id: mei.id }, buildingRoleId(LAB, "manager"));
    const r = await world.verbs.submit_report(noor, { title: "Done", body: "## What I did\nx", verdict: "stop" });
    const prov = { sourceIds: [r.id], urls: [] };
    await expect(world.verbs.submit_report(mei, { title: "x", body: "## Shipped\nx\n## Decided\nx", verdict: "stop", rollup: true, provenance: prov }))
      .rejects.toThrow(/Missing: ## Key results, ## Needs from Mitchell/);
    const old = await world.verbs.submit_report(mei, { title: "Old", body: OLD, verdict: "stop", rollup: true, provenance: prov });
    expect(old).not.toHaveProperty("warnings");
    expect(old.note).not.toMatch(/Format warnings/);
    const bare = await world.verbs.submit_report(mei, { title: "Bare", body: "## Shipped\n1. Thing\nIt shipped.\n## Decided\nx\n## Key results\nx\n## Needs from Mitchell\nNothing needed.", verdict: "stop", rollup: true, provenance: prov });
    expect(bare.warnings).toEqual([`Shipped item 1 ("Thing") lacks **What it is:**, **What you'd see:**, **Your call:**`]);
    expect(bare.note).toMatch(/Format warnings \(filed anyway/);
    expect(world.docs.require(bare.id).tags).toContain("rollup");
    const good = await world.verbs.submit_report(mei, { title: "Good", body: ROLLUP, verdict: "stop", rollup: true, provenance: prov });
    expect(good).not.toHaveProperty("warnings");
    // a resident's ordinary report is never checked
    await expect(world.verbs.submit_report(noor, { title: "Plain", body: "no headings", verdict: "stop" })).resolves.toMatchObject({ intray: LAB });
  }, 30_000);
  it("the manager's in-tray block describes the format", () => {
    const { world, by, admin } = seededWorld();
    const mei = by("Mei");
    world.ops.updateBuilding(admin, LAB, { managerAgentId: mei.id });
    const block = managerIntrayBlock(world, world.buildings.require(LAB), mei.id);
    for (const s of ["## Shipped", "## Decided", "## Key results", "## Needs from Mitchell", "**What it is:**", "**What you'd see:**", "**Your call:**"]) expect(block).toContain(s);
    expect(block).not.toContain("Four short sections");
  }, 30_000);
});

describe("Needs from Mitchell carries only what has no other channel (1:1 mt_uf1bwd3exq)", () => {
  const body = (needs: string) => `## Shipped\nNone.\n## Decided\n- dc_a → approved\n## Key results\nx\n## Needs from Mitchell\n${needs}`;
  it("reads the Needs ids and inserts the generated line at the end of the section", () => {
    expect(rollupNeedsIds(body("- Fund gr_abc123 (dc_x1, gr_abc123)"))).toEqual(["gr_abc123", "dc_x1"]);
    expect(rollupNeedsIds("## Shipped\ngr_zz\n## Needs from Mitchell\nNothing needed.")).toEqual([]);
    expect(withNeedsLine(body("Nothing needed."), "_L_")).toBe(`${body("Nothing needed.")}\n\n_L_`);
    expect(withNeedsLine("## Needs from Mitchell\n- a\n\n## Key results\nx", "_L_")).toBe("## Needs from Mitchell\n- a\n\n_L_\n\n## Key results\nx");
  });
  it("refuses a Needs item naming a pending proposal, outbox request or Town Hall rollup; allows the rest; appends the in-tray line", async () => {
    const { world, by, admin } = seededWorld();
    const mei = by("Mei"), noor = by("Noor");
    world.ops.updateBuilding(admin, LAB, { managerAgentId: mei.id });
    world.permissions.grant({ kind: "agent", id: mei.id }, buildingRoleId(LAB, "manager"));
    const r = await world.verbs.submit_report(noor, { title: "Done", body: "## What I did\nx", verdict: "stop" });
    const prov = { sourceIds: [r.id], urls: [] };
    const roll = (needs: string) => world.verbs.submit_report(mei, { title: "R", body: body(needs), verdict: "stop", rollup: true, provenance: prov });
    // nothing waiting yet
    const first = await roll("Nothing needed.");
    expect(world.docs.require(first.id).body).toBe(`${body("Nothing needed.")}\n\n_Nothing else waiting in your in-tray._`);
    const g = await world.verbs.propose_grant(mei, { keyResults: [{ text: "k", howToCheck: "h" }], objective: "o", stopCondition: "s", askTokens: 1000 });
    const req = await world.verbs.request_human(mei, { title: "Look outside", body: "b", kind: "observation" });
    await expect(roll(`- Fund ${g.grantId}, please.`)).rejects.toThrow(new RegExp(`${g.grantId} \\(a grant proposal in the Town Hall in-tray\\)`));
    await expect(roll(`- Do ${req.id}`)).rejects.toThrow(/an open outbox request/);
    await expect(roll(`- Decide ${first.id}`)).rejects.toThrow(/a report in the Town Hall in-tray.*The rule: "## Needs from Mitchell" carries at most 2 items/);
    // allowed: a reserved decision, a question in words, a 1:1 invite; a decided report or a resident's report is fine to name
    const ok = await roll(`- Decide whether forks get town.redeploy (reserved), see ${r.id}.\n- Open a 1:1 with Pix on visitor agents.`);
    expect(ok).not.toHaveProperty("warnings");
    expect(world.docs.require(ok.id).body).toMatch(new RegExp(`Open a 1:1 with Pix on visitor agents\\.\\n\\n_Already waiting in your in-tray: 1 proposal \\(${g.grantId}\\), 1 request \\(${req.id}\\), 1 rollup \\(${first.id}\\)\\._$`));
    // more than two Needs items are filed with a warning
    const many = await roll("- a\n- b\n- c");
    expect(many.warnings).toEqual(["3 Needs items; keep it to 2"]);
  }, 30_000);
});
