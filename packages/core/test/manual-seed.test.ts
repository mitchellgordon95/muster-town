import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findManual } from "../src/index.ts";
import { PAST_MANUAL_EDITIONS } from "../src/seed.ts";
import { freshWorld, REPO_ROOT, tempDir } from "./helpers.ts";

describe("operating manual seed", () => {
  it("seeds docs/manual.md once as a Town Hall library article tagged manual, and never overwrites the live doc", () => {
    const { world } = freshWorld();
    const file = join(tempDir(), "manual.md");
    writeFileSync(file, "# Operating manual\n\n## What Muster Town is\n\nEdition 1.\n");
    world.seedDefaults({ manualPath: file });
    const doc = findManual(world)!;
    expect(doc).toMatchObject({ type: "article", state: "library", title: "Operating manual", tags: ["manual", expect.stringMatching(/^seeded:[0-9a-f]{16}$/)], buildingId: world.buildings.first("kind = 'town-hall'")!.id });
    expect(doc.body.startsWith("## What Muster Town is")).toBe(true);
    // edited live, then the file changes and the server restarts: the edit stays, no second copy
    world.docs.patch(doc.id, { body: "edited in town" });
    writeFileSync(file, "# Operating manual\n\nEdition 2.\n");
    world.seedDefaults({ manualPath: file });
    expect(world.docs.where("title = 'Operating manual'")).toHaveLength(1);
    expect(findManual(world)!.body).toBe("edited in town");
  });

  it("updates the live manual whenever the file changes and the doc still holds what the seed last wrote", () => {
    const { world } = freshWorld();
    const file = join(tempDir(), "manual.md");
    writeFileSync(file, "# Operating manual\n\nEdition 1.\n");
    world.seedDefaults({ manualPath: file });
    const first = findManual(world)!;
    for (const n of [2, 3]) {
      writeFileSync(file, `# Operating manual\n\nEdition ${n}.\n`);
      world.seedDefaults({ manualPath: file });
      expect(findManual(world)).toMatchObject({ id: first.id, body: `Edition ${n}.\n` });
    }
    expect(findManual(world)!.tags.filter((t) => t.startsWith("seeded:"))).toHaveLength(1);
    // a human edit keeps the stale tag, so the next file edition leaves it alone
    world.docs.patch(first.id, { body: "edited in town" });
    writeFileSync(file, "# Operating manual\n\nEdition 4.\n");
    world.seedDefaults({ manualPath: file });
    expect(findManual(world)!.body).toBe("edited in town");
  });

  it("migrates a legacy untagged manual: one matching an old hash is updated once and then tracked, a hand-edited one is left alone", () => {
    const { world } = freshWorld();
    const file = join(tempDir(), "manual.md");
    const old = "## What Muster Town is\n\nEdition 1.\n";
    PAST_MANUAL_EDITIONS.push(createHash("sha256").update(old).digest("hex"));
    try {
      writeFileSync(file, `# Operating manual\n\n${old}`);
      world.seedDefaults({ manualPath: file });
      const id = findManual(world)!.id;
      writeFileSync(file, "# Operating manual\n\n## What Muster Town is\n\nEdition 2.\n");
      world.seedDefaults({ manualPath: file });
      expect(findManual(world)).toMatchObject({ id, body: "## What Muster Town is\n\nEdition 2.\n" });
      expect(world.docs.where("title = 'Operating manual'")).toHaveLength(1);
    } finally { PAST_MANUAL_EDITIONS.pop(); }
    // legacy: drop the tag and put back the old edition, as a doc seeded before the tag would look
    const { world: w2 } = freshWorld();
    writeFileSync(file, "# Operating manual\n\nEdition 1.\n");
    w2.seedDefaults({ manualPath: file });
    const legacy = findManual(w2)!;
    w2.docs.patch(legacy.id, { body: old, tags: ["manual"] });
    PAST_MANUAL_EDITIONS.push(createHash("sha256").update(old).digest("hex"));
    try {
      writeFileSync(file, "# Operating manual\n\nEdition 2.\n");
      w2.seedDefaults({ manualPath: file });
    } finally { PAST_MANUAL_EDITIONS.pop(); }
    expect(findManual(w2)).toMatchObject({ body: "Edition 2.\n", tags: ["manual", expect.stringMatching(/^seeded:/)] });
    // now tracked by its tag, with no help from the list
    writeFileSync(file, "# Operating manual\n\nEdition 3.\n");
    w2.seedDefaults({ manualPath: file });
    expect(findManual(w2)!.body).toBe("Edition 3.\n");
    // an untagged hand-edited doc matches neither and stays
    w2.docs.patch(legacy.id, { body: "edited in town", tags: ["manual"] });
    writeFileSync(file, "# Operating manual\n\nEdition 4.\n");
    w2.seedDefaults({ manualPath: file });
    expect(findManual(w2)).toMatchObject({ body: "edited in town", tags: ["manual"] });
  });

  it("tags an untagged live manual that already equals the file without bumping it", () => {
    const { world } = freshWorld();
    const file = join(tempDir(), "manual.md");
    writeFileSync(file, "# Operating manual\n\nEdition 1.\n");
    world.seedDefaults({ manualPath: file });
    const doc = findManual(world)!;
    world.docs.patch(doc.id, { tags: ["manual"] });
    world.seedDefaults({ manualPath: file });
    expect(findManual(world)).toMatchObject({ updatedAt: doc.updatedAt, tags: ["manual", expect.stringMatching(/^seeded:/)] });
  });

  it("knows the outgoing edition: the repo manual itself is never listed as a past edition", () => {
    const body = readFileSync(join(REPO_ROOT, "docs/manual.md"), "utf8").replace(/^# [^\n]*\n+/, "");
    expect(PAST_MANUAL_EDITIONS).not.toContain(createHash("sha256").update(body).digest("hex"));
  });

  it("does nothing without the file", () => {
    const { world } = freshWorld();
    world.seedDefaults({ manualPath: join(tempDir(), "missing.md") });
    expect(findManual(world)).toBeNull();
  });
});
