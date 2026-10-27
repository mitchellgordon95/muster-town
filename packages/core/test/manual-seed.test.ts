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
    expect(doc).toMatchObject({ type: "article", state: "library", title: "Operating manual", tags: ["manual"], buildingId: world.buildings.first("kind = 'town-hall'")!.id });
    expect(doc.body.startsWith("## What Muster Town is")).toBe(true);
    // edited live, then the file changes and the server restarts: the edit stays, no second copy
    world.docs.patch(doc.id, { body: "edited in town" });
    writeFileSync(file, "# Operating manual\n\nEdition 2.\n");
    world.seedDefaults({ manualPath: file });
    expect(world.docs.where("title = 'Operating manual'")).toHaveLength(1);
    expect(findManual(world)!.body).toBe("edited in town");
  });

  it("updates a live manual that still equals an earlier repo edition, and leaves a hand-edited one alone", () => {
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
