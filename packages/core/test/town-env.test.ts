/** Rename P3: MUSTER_TOWN_<X> first, AGENT_TOWN_<X> as the fallback, for one release. */
import { describe, expect, it } from "vitest";
import { townEnv, townEnvBoth } from "@muster-town/schema";

describe("townEnv", () => {
  it("prefers the new name", () => {
    expect(townEnv("TOKEN", { MUSTER_TOWN_TOKEN: "new", AGENT_TOWN_TOKEN: "old" })).toBe("new");
  });
  it("falls back to the old name", () => {
    expect(townEnv("URL", { AGENT_TOWN_URL: "http://old" })).toBe("http://old");
  });
  it("a blank new name doesn't hide the old one", () => {
    expect(townEnv("TOKEN", { MUSTER_TOWN_TOKEN: "  ", AGENT_TOWN_TOKEN: "old" })).toBe("old");
    expect(townEnv("DEV", { MUSTER_TOWN_DEV: "" })).toBe("");
  });
  it("is undefined when neither is set, and doesn't read other names", () => {
    expect(townEnv("ADMINS", { AGENT_TOWN_ADMIN_NAME: "x", MUSTER_ADMINS: "y" })).toBeUndefined();
  });
  it("reads process.env by default", () => {
    process.env.MUSTER_TOWN_GITHUB_URL = "http://gh.test";
    try { expect(townEnv("GITHUB_URL")).toBe("http://gh.test"); } finally { delete process.env.MUSTER_TOWN_GITHUB_URL; }
  });
  it("townEnvBoth sets both spellings", () => {
    expect(townEnvBoth("TOKEN", "t")).toEqual({ MUSTER_TOWN_TOKEN: "t", AGENT_TOWN_TOKEN: "t" });
  });
});
