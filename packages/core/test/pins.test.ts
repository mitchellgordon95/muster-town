import type { Doc } from "@muster-town/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { pinnedPagesBlock, pinSuspended, resolvePins, type PinEntry, type PinnedDoc, type PinRow, type PinViewer } from "../src/pins.ts";

const AGENT = "ag_me";
const BUILDING = "bl_home";

function doc(i: number, type: "skill" | "wiki", body: string): Doc {
  const id = `dc_${i}`;
  return {
    id, type, title: type === "skill" ? `skill-${i}` : `Page ${i}`, state: "building", buildingId: BUILDING, authorId: "ag_author",
    body: type === "skill" ? `---\nname: skill-${i}\ndescription: Use for ${i}.\n---\n${body}` : body,
    provenance: { sourceIds: [], urls: [] }, tags: [], createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
  } as unknown as Doc;
}

/** A random town of docs (some invisible, some skills with files) and pins over them (some for other agents or buildings). */
const town = fc.integer({ min: 1, max: 8 }).chain((n) => fc.record({
  docs: fc.array(fc.record({ skill: fc.boolean(), body: fc.string({ maxLength: 400 }), visible: fc.boolean(), files: fc.nat(2) }), { minLength: n, maxLength: n }),
  pins: fc.array(fc.record({
    doc: fc.nat(n), // n = a doc that doesn't exist
    scope: fc.constantFrom("agent" as const, "building" as const, "town" as const),
    target: fc.constantFrom("mine", "other"),
    mode: fc.constantFrom("listed" as const, "always" as const),
    selfPinned: fc.boolean(), byHuman: fc.boolean(), at: fc.integer({ min: 0, max: 50 }),
  }), { maxLength: 20 }),
}).map(({ docs, pins }) => {
  const map = new Map<string, PinnedDoc>();
  const hidden = new Set<string>();
  docs.forEach((d, i) => {
    const dd = doc(i, d.skill ? "skill" : "wiki", d.body);
    map.set(dd.id, { doc: dd, files: d.skill ? Array.from({ length: d.files }, (_, k) => ({ path: `f${k}.sh`, chars: 1, updatedAt: dd.updatedAt })) : [] });
    if (!d.visible) hidden.add(dd.id);
  });
  const rows: PinRow[] = pins.map((p, i) => {
    const targetId = p.scope === "town" ? null : p.scope === "building" ? (p.target === "mine" ? BUILDING : "bl_other") : (p.target === "mine" ? AGENT : "ag_other");
    return {
      id: `sp_${i}`, docId: `dc_${p.doc}`, scope: p.scope, targetId, mode: p.mode,
      pinnedBy: p.scope === "agent" && p.selfPinned ? targetId! : "ag_boss", byHuman: p.byHuman, createdAt: `2026-11-01T00:00:${String(p.at).padStart(2, "0")}.000Z`,
    };
  });
  const viewer: PinViewer = { agentId: AGENT, buildingId: BUILDING, canSee: (d) => !hidden.has(d.id) };
  return { docs: map, pins: rows, viewer, hidden };
}));

const reaches = (p: PinRow) => p.scope === "town" || p.targetId === BUILDING || p.targetId === AGENT;

describe("resolvePins / pinnedPagesBlock: pins in, one ## Pinned pages block out (design dc_8194l8soj4 §5, §8)", () => {
  it("each doc at most once", () => {
    fc.assert(fc.property(town, ({ docs, pins, viewer }) => {
      const ids = resolvePins(pins, docs, viewer).map((e) => e.doc.id);
      expect(new Set(ids).size).toBe(ids.length);
    }));
  });

  it("a doc the viewer can't see, a missing doc, a pin for someone else or a suspended pin never shows", () => {
    fc.assert(fc.property(town, ({ docs, pins, viewer, hidden }) => {
      for (const e of resolvePins(pins, docs, viewer)) {
        expect(hidden.has(e.doc.id)).toBe(false);
        const live = pins.filter((p) => p.docId === e.doc.id && reaches(p) && !pinSuspended(p, e.files.length));
        expect(live.length).toBeGreaterThan(0);
      }
    }));
  });

  it("always beats listed: a doc shows always when any live pin of it is always", () => {
    fc.assert(fc.property(town, ({ docs, pins, viewer }) => {
      for (const e of resolvePins(pins, docs, viewer)) {
        const anyAlways = pins.some((p) => p.docId === e.doc.id && p.mode === "always" && reaches(p) && !pinSuspended(p, e.files.length));
        expect(e.mode === "always").toBe(anyAlways);
      }
    }));
  });

  it("stable order: always before listed, town → building → agent; the input order of the pins doesn't matter", () => {
    fc.assert(fc.property(town, fc.integer(), ({ docs, pins, viewer }, seed) => {
      const out = resolvePins(pins, docs, viewer);
      const rank = (e: PinEntry) => (e.mode === "always" ? 0 : 3) + { town: 0, building: 1, agent: 2 }[e.scope];
      for (let i = 1; i < out.length; i++) expect(rank(out[i - 1]!)).toBeLessThanOrEqual(rank(out[i]!));
      const shuffled = [...pins].sort((a, b) => ((a.id.length * 31 + seed) % 7) - ((b.id.length * 17 + seed) % 7) || (a.id < b.id ? 1 : -1));
      expect(resolvePins(shuffled, docs, viewer).map((e) => [e.doc.id, e.mode, e.scope])).toEqual(out.map((e) => [e.doc.id, e.mode, e.scope]));
    }));
  });

  it("adding a pin never removes an entry", () => {
    fc.assert(fc.property(town, fc.nat(), fc.constantFrom("listed" as const, "always" as const), ({ docs, pins, viewer }, k, mode) => {
      const before = resolvePins(pins, docs, viewer).map((e) => e.doc.id);
      const extra: PinRow = { id: "sp_new", docId: `dc_${k % (docs.size + 1)}`, scope: "town", targetId: null, mode, pinnedBy: "us_admin", byHuman: true, createdAt: "2026-11-02T00:00:00.000Z" };
      const after = new Set(resolvePins([...pins, extra], docs, viewer).map((e) => e.doc.id));
      for (const id of before) expect(after.has(id)).toBe(true);
    }));
  });

  it("the block: one heading; always text stays under the cap; every always entry is in full or listed", () => {
    fc.assert(fc.property(town, fc.integer({ min: 0, max: 2000 }), ({ docs, pins, viewer }, cap) => {
      const entries = resolvePins(pins, docs, viewer);
      const block = pinnedPagesBlock(entries, cap);
      if (!entries.length) { expect(block).toBe(""); return; }
      expect(block.match(/^## /gm)).toEqual(["## "]);
      expect(block.startsWith("## Pinned pages\n")).toBe(true);
      let full = 0;
      for (const e of entries) {
        const head = `### ${e.heading} (${e.doc.id}, ${e.scope} pin, always on)\n`;
        const line = `- ${e.title} (${e.doc.id}, ${e.scope} pin)`;
        const shown = e.mode === "always" && block.includes(head);
        if (shown) full += head.length + e.text.length;
        expect(shown || block.includes(line)).toBe(true);
      }
      expect(full).toBeLessThanOrEqual(cap);
    }));
  });

  it("listed lines: at most `listedPerScope` per scope, the newest kept, the rest counted in one search line", () => {
    fc.assert(fc.property(town, fc.integer({ min: 0, max: 4 }), ({ docs, pins, viewer }, k) => {
      const entries = resolvePins(pins, docs, viewer);
      const block = pinnedPagesBlock(entries, 0, k);
      let dropped = 0;
      for (const scope of ["town", "building", "agent"] as const) {
        // cap 0: an always entry overflows into a listed line and is never dropped; listed ones keep the newest k
        const inScope = entries.filter((e) => e.scope === scope);
        const listed = inScope.filter((e) => e.mode === "listed");
        const kept = new Set([...inScope.filter((e) => e.mode === "always"), ...listed.slice(Math.max(0, listed.length - k))]);
        for (const e of inScope) expect(block.includes(`(${e.doc.id}, ${scope} pin)`)).toBe(kept.has(e));
        dropped += Math.max(0, listed.length - k);
      }
      expect(block.includes("older listed page")).toBe(dropped > 0);
    }));
  });

  it("examples: a wiki page is listed by its title alone, so a rewrite leaves the line as it was", () => {
    const d = { ...doc(2, "wiki", "Status as of now."), title: "The Bank" };
    const pin: PinRow = { id: "sp_2", docId: d.id, scope: "building", targetId: BUILDING, mode: "listed", pinnedBy: "system", byHuman: true, createdAt: d.createdAt };
    const viewer: PinViewer = { agentId: AGENT, buildingId: BUILDING, canSee: () => true };
    const block = pinnedPagesBlock(resolvePins([pin], new Map([[d.id, { doc: d, files: [] }]]), viewer));
    const rewritten = pinnedPagesBlock(resolvePins([pin], new Map([[d.id, { doc: { ...d, body: "Other words." }, files: [] }]]), viewer));
    expect(block).toContain(`- The Bank (${d.id}, building pin)\n`.trimEnd());
    expect(rewritten).toBe(block);
  });

  it("examples: a skill shows by its SKILL.md name; files added after an agent's pin into others suspend it", () => {
    const d = doc(1, "skill", "Steps.");
    const docs = new Map([[d.id, { doc: d, files: [{ path: "run.sh", chars: 3, updatedAt: d.updatedAt }] }]]);
    const pin: PinRow = { id: "sp_1", docId: d.id, scope: "building", targetId: BUILDING, mode: "always", pinnedBy: "ag_boss", byHuman: false, createdAt: d.createdAt };
    const viewer: PinViewer = { agentId: AGENT, buildingId: BUILDING, canSee: () => true };
    expect(resolvePins([pin], docs, viewer)).toEqual([]);
    const [e] = resolvePins([{ ...pin, byHuman: true }], docs, viewer);
    expect(pinnedPagesBlock([e!])).toContain(`### Skill: skill-1 (${d.id}, building pin, always on)\nSteps.\n(Bundled files: run.sh`);
    expect(pinnedPagesBlock([{ ...e!, mode: "listed" }])).toContain(`- skill-1 (${d.id}, building pin): Use for 1. [1 file: run.sh]`);
  });
});
