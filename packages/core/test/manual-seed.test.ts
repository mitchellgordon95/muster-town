import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findManual } from "../src/index.ts";
import { freshWorld, tempDir } from "./helpers.ts";

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

  it("does nothing without the file", () => {
    const { world } = freshWorld();
    world.seedDefaults({ manualPath: join(tempDir(), "missing.md") });
    expect(findManual(world)).toBeNull();
  });
});
