import { describe, expect, it } from "vitest";
import { blockedBy, classifyFailure, createAssignment, createBuilding, createResident } from "../src/index.ts";
import { backoffMs } from "../src/availability.ts";
import { creditBank, seededWorld } from "./helpers.ts";

// Promised and available (docs/bank.md, 2026-11-01): limits are observed per Bank input and model class, never predicted.
const FABLE = "claude-fable-5-1", OPUS = "claude-opus-5-5";
const AT = new Date("2026-11-01T02:28:00.000Z");
const HOUR = 3_600_000;

describe("classifyFailure", () => {
  it("reads what the provider said by what it means for the credential", () => {
    // the 2026-11-01 incident: a Fable-only limit, worded as a spend limit
    expect(classifyFailure("You've hit your monthly spend limit. Switch to another model to continue.", FABLE, AT)).toEqual({ kind: "model-limit", scope: "fable", resetsAt: null });
    expect(classifyFailure("You've hit your limit · resets 3pm (UTC)", OPUS, AT)).toEqual({ kind: "window", scope: "*", resetsAt: "2026-11-01T15:00:00.000Z" });
    expect(classifyFailure("Claude AI usage limit reached|1793512800", OPUS, AT)).toEqual({ kind: "window", scope: "*", resetsAt: "2026-11-01T06:00:00.000Z" });
    expect(classifyFailure("rate_limit_event seven_day_opus rejected", OPUS, AT)?.scope).toBe("opus");
    expect(classifyFailure("Your credit balance is too low to access the Anthropic API.", OPUS, AT)).toMatchObject({ kind: "billing", scope: "*" });
    expect(classifyFailure("authentication_error: invalid x-api-key", OPUS, AT)).toMatchObject({ kind: "auth", scope: "*" });
    expect(classifyFailure("OAuth token has expired", OPUS, AT)).toMatchObject({ kind: "auth" });
    // not about the credential: never a limit
    for (const t of ["Overloaded", "API Error: 529", "rate_limit_error: too many requests", "tool crashed", "", null]) expect(classifyFailure(t, OPUS, AT)).toBeNull();
  });

  it("with no reset named, the next try backs off: 1 h doubling to 24 h for limits, 6 h doubling to 48 h for billing and auth", () => {
    expect([1, 2, 3, 6, 9].map((f) => backoffMs("model-limit", f) / HOUR)).toEqual([1, 2, 4, 24, 24]);
    expect([1, 2, 3, 4].map((f) => backoffMs("billing", f) / HOUR)).toEqual([6, 12, 24, 48]);
  });
});

/** The incident's shape: a building whose manager runs on Fable and whose forks run on Opus, funded only by the subscription. */
function town() {
  const { world, seed } = seededWorld();
  creditBank(world);
  const b = createBuilding(world, { name: "Lab", model: OPUS, cheapModel: "claude-haiku-5-5" }, seed.admin.id);
  const pix = createResident(world, { buildingId: b.id, name: "Pix", title: "t", direction: "d", model: FABLE });
  const sub = world.bank.subscriptionInput()!;
  const by = { kind: "system" as const, id: "system" };
  const mine = createAssignment(world, { agentId: pix.id, title: "Fable work", description: "d", createdBy: by });
  const forks = createAssignment(world, { agentId: pix.id, title: "Opus fork work", description: "d", createdBy: by, queue: "building" });
  /** a session on `model` that ended with `error` (or succeeded) on the subscription input */
  const session = (model: string, error?: string) => {
    const s = world.ops.startSession(pix.id, { purpose: "work", model, funding: "subscription", credentialInputId: sub.id });
    const counts = { input: 0, output: 1000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
    return world.ops.endSession(s.id, error ? { status: "error", error } : { status: "done", counts, byModel: { [model]: counts } });
  };
  return { world, seed, b, pix, sub, mine, forks, session };
}

describe("availability per input and model (the Fable limit of 2026-11-01)", () => {
  it("a Fable limit holds Fable work with its reason; Opus work on the same subscription keeps running", () => {
    const { world, b, pix, sub, mine, forks, session } = town();
    expect(world.budget.canStart(pix.id, mine)).toBe(true);
    session(FABLE, "You've hit your monthly spend limit. Switch to another model to continue.");
    const [limit] = world.bank.availability.open(sub.id);
    expect(limit).toMatchObject({ scope: "fable", kind: "model-limit", until: null, failures: 1 });
    expect(Date.parse(limit!.probeAt!) - Date.parse(limit!.lastAt)).toBe(HOUR);
    // Fable: held, with the limit's words, and the map's red line goes to the Bank
    expect(world.budget.canStart(pix.id, mine)).toBe(false);
    expect(world.assignments.require(mine.id).heldReason).toMatch(/^Test subscription: Fable limited, tries again /);
    expect(blockedBy(world, world.assignments.require(mine.id))).toMatchObject({ kind: "budget", placeId: "bank", text: expect.stringMatching(/Fable limited/) });
    // Opus: the building-queue row a fork runs is not held, though its manager is
    expect(world.budget.holdReason(forks)).toBeNull();
    expect(blockedBy(world, world.assignments.require(forks.id))).toBeNull();
    expect(world.budget.fundingFor(b.id, { model: OPUS }).auth).toBe("subscription");
    expect(world.events.list({ types: ["bank.limit"] })).toHaveLength(1);
  });

  it("an Opus success clears nothing for Fable; a Fable success (the probe) clears the Fable limit", () => {
    const { world, sub, session } = town();
    session(FABLE, "Switch to another model to continue.");
    session(OPUS);
    expect(world.bank.availability.open(sub.id)).toHaveLength(1);
    session(FABLE);
    expect(world.bank.availability.open(sub.id)).toHaveLength(0);
    expect(world.events.list({ types: ["bank.limit"] }).at(-1)?.text).toMatch(/Fable available again/);
  });

  it("no reset known: after probeAt one session may try; failing again doubles the wait", () => {
    const { world, b, sub, session } = town();
    session(FABLE, "Switch to another model to continue.");
    const first = world.bank.availability.open(sub.id)[0]!;
    const probe = new Date(Date.parse(first.probeAt!) + 1000);
    expect(() => world.budget.fundingFor(b.id, { model: FABLE })).toThrow(/Fable limited/);
    expect(world.budget.fundingFor(b.id, { model: FABLE, now: probe }).auth).toBe("subscription");
    session(FABLE, "Switch to another model to continue.");
    const second = world.bank.availability.open(sub.id)[0]!;
    expect(second).toMatchObject({ id: first.id, failures: 2 });
    expect(Date.parse(second.probeAt!) - Date.parse(second.lastAt)).toBe(2 * HOUR);
  });

  it("a plan window limits every model until the reset it names; then work runs again", () => {
    const { world, b, pix, sub, forks, session } = town();
    session(OPUS, "You've hit your limit · resets 11:59pm (UTC)");
    const limit = world.bank.availability.open(sub.id)[0]!;
    expect(limit).toMatchObject({ scope: "*", kind: "window", probeAt: null });
    expect(world.budget.holdReason(forks)).toMatch(/^Test subscription: limited, resets /);
    expect(world.budget.canStart(pix.id)).toBe(false);
    expect(world.budget.fundingFor(b.id, { model: OPUS, now: new Date(Date.parse(limit.until!) + 1000) }).auth).toBe("subscription");
  });

  it("fails over only to a key that serves the same model; never to another model", () => {
    const { world, seed, b, sub, session } = town();
    const key = world.bank.addInput(seed.admin.id, { label: "Key", source: "api-key", model: OPUS, tokens: 1_000_000, apiKey: "sk-ant-api03-k" });
    session(FABLE, "Switch to another model to continue.");
    expect(world.budget.fundingFor(b.id, { model: FABLE })).toMatchObject({ auth: "api-key", credential: { inputId: key.id } });
    world.bank.availability.limit({ inputId: key.id, scope: "fable", kind: "model-limit", until: null, reason: "x" });
    expect(() => world.budget.fundingFor(b.id, { model: FABLE })).toThrow(/Fable limited/);
    expect(world.budget.fundingFor(b.id, { model: OPUS }).credential.inputId).toBe(sub.id);
  });

  it("billing and auth: a broken key is skipped for every model and tried again after 6 h", () => {
    const { world, seed, b } = town();
    world.bank.cancelInput(seed.admin.id, world.bank.subscriptionInput()!.id);
    const k1 = world.bank.addInput(seed.admin.id, { label: "Old key", source: "api-key", model: OPUS, tokens: 1_000_000, apiKey: "sk-ant-api03-a" });
    const k2 = world.bank.addInput(seed.admin.id, { label: "New key", source: "api-key", model: OPUS, tokens: 1_000_000, apiKey: "sk-ant-api03-b" });
    expect(world.budget.fundingFor(b.id, { model: OPUS }).credential.inputId).toBe(k1.id);
    world.bank.availability.recordFailure({ inputId: k1.id, model: OPUS, text: "Your credit balance is too low" });
    expect(world.budget.fundingFor(b.id, { model: OPUS }).credential.inputId).toBe(k2.id);
    world.bank.availability.recordFailure({ inputId: k2.id, model: OPUS, text: "authentication_error: invalid x-api-key" });
    expect(() => world.budget.fundingFor(b.id, { model: OPUS })).toThrow(/^Old key: out of credit, tries again /);
    expect(world.budget.fundingFor(b.id, { model: OPUS, now: new Date(Date.now() + 6 * HOUR + 1000) }).credential.inputId).toBe(k1.id);
  });

  it("rate_limit_event: rejected records the named window with its reset; allowed clears it", () => {
    const { world, sub } = town();
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    world.bank.availability.observeRateLimit(sub.id, { status: "rejected", rateLimitType: "seven_day_opus", resetsAt });
    expect(world.bank.availability.limitFor(sub.id, OPUS)).toMatchObject({ scope: "opus", until: new Date(resetsAt * 1000).toISOString() });
    expect(world.bank.availability.available(sub.id, FABLE)).toBe(true);
    world.bank.availability.observeRateLimit(sub.id, { status: "allowed_warning", rateLimitType: "seven_day_opus" });
    expect(world.bank.availability.available(sub.id, OPUS)).toBe(false);
    world.bank.availability.observeRateLimit(sub.id, { status: "allowed", rateLimitType: "seven_day_opus" });
    expect(world.bank.availability.available(sub.id, OPUS)).toBe(true);
  });
});
