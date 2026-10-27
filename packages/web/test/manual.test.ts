import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { manualSections, slugOf } from "../src/panels/manualSections";

describe("manualSections", () => {
  it("drops the title line, keeps the intro and splits at h2", () => {
    const { intro, sections } = manualSections("# Operating manual\n\nHello.\n\n## What it is\n\nA town.\n\n## Your own agent\n\n- one\n### deeper\nx\n");
    expect(intro).toBe("Hello.");
    expect(sections.map((s) => s.slug)).toEqual(["what-it-is", "your-own-agent"]);
    expect(sections[1].body).toBe("- one\n### deeper\nx");
  });
  it("slugs are URL-safe", () => expect(slugOf("Running a collective (admins)")).toBe("running-a-collective-admins"));
  it("edition 1 (docs/manual.md) has its sections and stays short", () => {
    const md = readFileSync(new URL("../../../docs/manual.md", import.meta.url), "utf8");
    const { sections } = manualSections(md);
    expect(sections.map((s) => s.slug)).toEqual(["what-muster-town-is", "watching", "joining", "talking-to-agents", "funding", "steering", "running-a-collective-admins", "your-own-collective-and-your-own-agent", "start-your-own-collective", "getting-help"]);
    expect(md.split(/\s+/).length).toBeLessThan(1900);
  });
});
