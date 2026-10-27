import { describe, expect, it } from "vitest";
import { collectivePrefix } from "../src/api";

// docs/hosted-collectives.md: the Workshop's client talks to the root /api, a hosted collective's to /<slug>/api
describe("collectivePrefix", () => {
  it("the Workshop (the Vite base) is the root; any other first segment is a hosted collective", () => {
    expect(collectivePrefix("/workshop/", "/workshop/")).toBe("");
    expect(collectivePrefix("/workshop", "/workshop/")).toBe("");
    expect(collectivePrefix("/", "/workshop/")).toBe("");
    expect(collectivePrefix("/demo/", "/workshop/")).toBe("/demo");
    expect(collectivePrefix("/demo", "/workshop/")).toBe("/demo");
    // a client built for the root has no hosted collectives above it
    expect(collectivePrefix("/demo/", "/")).toBe("");
  });
});
