import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { clientErrorOf, clientErrors, errorSignature, markNewSinceDeploy, MAX_NEW_KINDS_PER_DAY, normalizeMessage, recordClientError, topFrame } from "../src/client-errors.ts";
import { seededWorld } from "./helpers.ts";

// Browser errors (grant gr_cyqzweu6ed step 1): one row per kind, counts and commits only.
const V8 = "Error: boom\n    at CrashTestPanel (https://muster.town/workshop/assets/index-Bx9_k2Qa.js:12:3456)\n    at renderWithHooks (https://muster.town/workshop/assets/index-Bx9_k2Qa.js:1:99)";
const FF = "CrashTestPanel@https://muster.town/workshop/assets/index-Zz81_aQk.js:1:2222\nrenderWithHooks@https://muster.town/workshop/assets/index-Zz81_aQk.js:1:9";

describe("client errors: the pure core", () => {
  it("reads the top frame from V8 and Firefox stacks, without build hash or line:col", () => {
    expect(topFrame(V8)).toBe("CrashTestPanel (index.js)");
    expect(topFrame(FF)).toBe("CrashTestPanel (index.js)");
    expect(topFrame("TypeError: x is undefined")).toBe("");
    expect(topFrame("Error\n    at https://muster.town/assets/vendor-Ab12Cd34.js:1:2")).toBe("vendor.js");
  });

  it("blanks ids, numbers, hashes, URLs and long quoted text in a message", () => {
    expect(normalizeMessage("Cannot read properties of undefined (reading 'title')")).toBe("Cannot read properties of undefined (reading 'title')");
    expect(normalizeMessage("grant gr_cyqzweu6ed not found at step 3")).toBe("grant <id> not found at step <n>");
    expect(normalizeMessage("fetch https://muster.town/api/docs/dc_x?y=1 failed  with\n500")).toBe("fetch <url> failed with <n>");
    expect(normalizeMessage("commit 0c51d5a3 is gone")).toBe("commit <hex> is gone");
    expect(normalizeMessage(`Unexpected "${"my secret draft text ".repeat(3)}"`)).toBe('Unexpected "…"');
  });

  it("property: the signature ignores which id or number an occurrence carried, and stays short", () => {
    fc.assert(fc.property(fc.stringMatching(/^[a-z]{2}_[a-z0-9]{10}$/), fc.nat(), fc.string({ maxLength: 3000 }), (id, n, junk) => {
      const a = clientErrorOf({ source: "panel", message: `no doc ${id} at ${n}`, stack: V8 })!;
      const b = clientErrorOf({ source: "panel", message: "no doc dc_aaaaaaaaaa at 1", stack: FF })!;
      expect(errorSignature(a)).toBe(errorSignature(b));
      const r = clientErrorOf({ source: "error", message: junk || "x", stack: junk });
      if (r) expect(errorSignature(r).length).toBeLessThanOrEqual(340);
    }));
  });

  it("refuses a post with no known source or no message; keeps only a panel kind and a route with ids blanked", () => {
    expect(clientErrorOf(null)).toBeNull();
    expect(clientErrorOf({ source: "nope", message: "x" })).toBeNull();
    expect(clientErrorOf({ source: "error", message: "   " })).toBeNull();
    const r = clientErrorOf({ source: "panel", message: "x", panel: "grant", route: "#/doc/dc_abc123def4/2?q=secret", userId: "us_x" })!;
    expect(r).toEqual({ source: "panel", message: "x", frame: "", panel: "grant", route: "#/doc/<id>/<n>" });
    expect(clientErrorOf({ source: "panel", message: "x", panel: "<script>" })!.panel).toBeNull();
  });
});

describe("client errors: the store", () => {
  it("counts a known kind, takes the live commit as its last, and appends client.error.new only for a new kind", () => {
    const { world } = seededWorld();
    const t0 = Date.parse("2026-11-24T12:00:00Z");
    const crash = clientErrorOf({ source: "panel", message: "crash test: this panel throws on purpose", stack: V8, panel: "crash-test", route: "#/crash-test" })!;
    expect(recordClientError(world, crash, { commit: "aaaa1111", now: t0 })).toMatchObject({ recorded: true, isNew: true });
    expect(recordClientError(world, clientErrorOf({ source: "panel", message: "crash test: this panel throws on purpose", stack: FF, panel: "crash-test" })!, { commit: "bbbb2222", now: t0 + 60_000 }).isNew).toBe(false);
    recordClientError(world, clientErrorOf({ source: "rejection", message: "Failed to fetch" })!, { commit: "bbbb2222", now: t0 + 120_000 });
    const v = clientErrors(world, { now: t0 + 180_000 });
    expect(v.total).toBe(3);
    expect(v.kinds.map((k) => [k.panel, k.count, k.firstCommit, k.lastCommit])).toEqual([["crash-test", 2, "aaaa1111", "bbbb2222"], [null, 1, "bbbb2222", "bbbb2222"]]);
    expect(world.events.list({ types: ["client.error.new"] }).map((e) => e.payload.source)).toEqual(["panel", "rejection"]);
    // a day later, unseen kinds leave the 24-hour list
    expect(clientErrors(world, { now: t0 + 25 * 3_600_000 }).kinds).toEqual([]);
  });

  it("keeps at most MAX_NEW_KINDS_PER_DAY new kinds a UTC day; a known kind still counts", () => {
    const { world } = seededWorld();
    const t0 = Date.parse("2026-11-24T01:00:00Z");
    for (let i = 0; i < MAX_NEW_KINDS_PER_DAY; i++) recordClientError(world, clientErrorOf({ source: "error", message: `kind ${"abcdefghij"[i % 10]}${"abcdefghij"[Math.floor(i / 10)]}` })!, { commit: null, now: t0 });
    expect(recordClientError(world, clientErrorOf({ source: "error", message: "one too many" })!, { commit: null, now: t0 }).recorded).toBe(false);
    expect(recordClientError(world, clientErrorOf({ source: "error", message: "kind aa" })!, { commit: null, now: t0 }).recorded).toBe(true);
    expect(recordClientError(world, clientErrorOf({ source: "error", message: "next day" })!, { commit: null, now: t0 + 86_400_000 }).isNew).toBe(true);
  });

  it("marks kinds first seen since the running server started, and counts them as newSinceDeploy", () => {
    const { world } = seededWorld();
    const t0 = Date.parse("2026-11-24T12:00:00Z");
    recordClientError(world, clientErrorOf({ source: "error", message: "old bug" })!, { commit: "aaaa1111", now: t0 });
    recordClientError(world, clientErrorOf({ source: "error", message: "new bug" })!, { commit: "bbbb2222", now: t0 + 3_600_000 });
    recordClientError(world, clientErrorOf({ source: "error", message: "old bug" })!, { commit: "bbbb2222", now: t0 + 3_700_000 });
    const deployedAt = new Date(t0 + 1_800_000).toISOString();
    const v = clientErrors(world, { now: t0 + 4_000_000, deployedAt });
    expect(v.deployedAt).toBe(deployedAt);
    expect(v.newSinceDeploy).toBe(1);
    expect(v.kinds.map((k) => [k.message, k.newSinceDeploy])).toEqual([["old bug", false], ["new bug", true]]);
    // an unknown start marks nothing new
    expect(clientErrors(world, { now: t0 + 4_000_000 }).newSinceDeploy).toBe(0);
    expect(markNewSinceDeploy([{ firstSeen: "2026-11-24T00:00:00Z" }], "not a time").newSinceDeploy).toBe(0);
  });
});
