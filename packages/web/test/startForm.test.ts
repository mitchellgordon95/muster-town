import { describe, expect, it } from "vitest";
import { addressOf, errorField, SIGN_IN_TO_START, startBody, startProblems, waitForTown } from "../src/home/startForm";

const draft = { name: "Garden Club!", goal: "Map every community garden in town", apiKey: "" };

describe("Start form (home/startForm.ts)", () => {
  it("derives the address from the name like POST /api/collectives", () => {
    expect(addressOf("Garden Club!")).toBe("garden-club");
    expect(addressOf("  Café   Ünïon -- 2026 ")).toBe("cafe-union-2026");
    expect(addressOf("!!!")).toBe("");
    expect(addressOf("x".repeat(60))).toHaveLength(40);
  });

  it("accepts a name and a goal; the key is optional", () => {
    expect(startProblems(draft)).toEqual({});
    expect(startBody(draft)).toEqual({ name: "Garden Club!", goal: draft.goal, slug: "garden-club" });
  });

  it("refuses an empty name or goal, a reserved or too-short address", () => {
    expect(startProblems({ ...draft, name: " ", goal: "" })).toMatchObject({ name: expect.any(String), goal: expect.any(String) });
    expect(startProblems({ ...draft, name: "Workshop" }).name).toMatch(/reserved/);
    expect(startProblems({ ...draft, name: "!" }).name).toMatch(/2 to 40/);
    expect(startProblems({ ...draft, name: "a" }).name).toMatch(/2 to 40/);
  });

  it("takes an API key, refuses subscription tokens and anything else, and sends the key only when given", () => {
    const key = "sk-ant-api03-abcdefghijklmnop";
    expect(startProblems({ ...draft, apiKey: key })).toEqual({});
    expect(startBody({ ...draft, apiKey: ` ${key} ` }).apiKey).toBe(key);
    expect(startProblems({ ...draft, apiKey: "sk-ant-oat01-abcdefghijklmnop" }).apiKey).toMatch(/subscription token/);
    expect(startProblems({ ...draft, apiKey: "hello" }).apiKey).toMatch(/sk-ant-api/);
  });

  it("puts a server error on the field it is about", () => {
    expect(errorField(409, "muster.town/garden-club is taken: pick another name for the address.")).toBe("name");
    expect(errorField(400, "An Anthropic API key starts with sk-ant-api (create one in the Claude Console).")).toBe("apiKey");
    expect(errorField(429, "You already run muster.town/x/: one collective per person for now.")).toBe("form");
    expect(SIGN_IN_TO_START).toBe("/auth/github?return_to=%2F%23start");
  });

  it("waits for the new town's /<slug>/api/health to say ok before landing (flag dc_1kylouq1l7), and gives up after its tries", async () => {
    const asked: string[] = [];
    // not up yet: the root redirects (manual: an opaque redirect, not ok), then the homepage HTML, then the town's JSON
    const replies = [new Response(null, { status: 302 }), new Response("<!doctype html>", { status: 200 }), Response.json({ ok: true })];
    const fetch = (async (u: string) => { asked.push(u); return replies.shift() ?? Response.json({ ok: true }); }) as unknown as typeof globalThis.fetch;
    expect(await waitForTown("/garden-club/", { fetch, delayMs: 0 })).toBe(true);
    expect(asked).toEqual(["/garden-club/api/health", "/garden-club/api/health", "/garden-club/api/health"]);
    const down = (async () => { throw new TypeError("network"); }) as unknown as typeof globalThis.fetch;
    expect(await waitForTown("/garden-club", { fetch: down, tries: 3, delayMs: 0 })).toBe(false);
  });
});
