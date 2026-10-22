import { describe, expect, test } from "vitest";
import { desksFromEnv } from "../src/env.ts";

describe("MUSTER_TOWN_DESKS", () => {
  test("unset or blank → no override", () => {
    expect(desksFromEnv(undefined)).toBeNull();
    expect(desksFromEnv("  ")).toBeNull();
  });

  test("a JSON object of desk settings is parsed (partial)", () => {
    expect(desksFromEnv('{"backend":"fly","townUrl":"https://muster.town","maxRunning":6,"ghToken":"env"}'))
      .toEqual({ backend: "fly", townUrl: "https://muster.town", maxRunning: 6, ghToken: "env" });
  });

  test("a typo fails loudly instead of silently falling back to docker", () => {
    expect(() => desksFromEnv('{"backend":"flyy"}')).toThrow();
    expect(() => desksFromEnv("not json")).toThrow();
  });
});
