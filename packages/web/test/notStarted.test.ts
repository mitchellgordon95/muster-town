import { describe, expect, test } from "vitest";
import { notStarted, notStartedWhy, workingCollective } from "../src/notStarted";

const list = [
  { slug: "workshop", name: "Workshop Collective", url: "/workshop/", started: true },
  { slug: "hollyville", name: "Hollyville", url: "/hollyville/", started: false },
  { slug: "trauma", name: "Trauma", url: "/trauma/", started: false },
];

describe("a never-run collective (gr_a6512x0je1)", () => {
  test("only a hosted collective whose health says started: false counts; the Workshop (no flag) never does", () => {
    expect(notStarted({ started: false })).toBe(true);
    expect(notStarted({ started: true })).toBe(false);
    expect(notStarted({})).toBe(false);
    expect(notStarted(null)).toBe(false);
  });
  test("why: no key names the founder's key; a key but no session yet does not", () => {
    expect(notStartedWhy({ funding: "none" })).toBe("its founder hasn't added a key yet.");
    expect(notStartedWhy({ funding: "api-key" })).toBe("no agent has worked here yet.");
  });
  test("the collective to watch instead: the first that has run and isn't this one", () => {
    expect(workingCollective(list, "/trauma/")).toEqual({ name: "Workshop Collective", url: "/workshop/" });
    expect(workingCollective(list, "/workshop/")).toBeNull();
    expect(workingCollective([{ slug: "next", name: "Your collective here", url: "", placeholder: true }], "/trauma/")).toBeNull();
    expect(workingCollective([], "/trauma/")).toBeNull();
  });
});
