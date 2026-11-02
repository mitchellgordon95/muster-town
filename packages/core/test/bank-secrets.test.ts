import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dataKeyFrom, decryptSecret } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

// docs/secrets.md "Bank secrets at rest": bank_inputs.apiKey and users.apiKey are v1: ciphertext under the data key
const KEY = randomBytes(32).toString("base64");
const T0 = new Date("2026-11-01T00:00:00Z");
const raw = (w: ReturnType<typeof seededWorld>["world"], table: "users" | "bank_inputs", id: string) =>
  (w.db.prepare(`SELECT apiKey FROM ${table} WHERE id = ?`).get(id) as { apiKey: string | null }).apiKey;

function setup(key: string | null = KEY) {
  const s = seededWorld();
  s.world.bankInputs.secret.dataKey = () => key ?? undefined;
  s.world.users.secret.dataKey = () => key ?? undefined;
  return s;
}

afterEach(() => { vi.restoreAllMocks(); });

describe("Bank secrets at rest", () => {
  it("stores a Bank input's key and a donor's key as v1: ciphertext bound to the row, and reads them back", () => {
    const { world, seed } = setup();
    const inp = world.bank.addInput(seed.admin.id, { label: "Key", source: "api-key", model: "m", tokens: 10, apiKey: "sk-ant-secret" }, T0);
    world.users.setApiKey(seed.admin.id, "sk-ant-donor");
    const ri = raw(world, "bank_inputs", inp.id)!, ru = raw(world, "users", seed.admin.id)!;
    expect(ri).toMatch(/^v1:/); expect(ri).not.toContain("sk-ant");
    expect(ru).toMatch(/^v1:/); expect(ru).not.toContain("sk-ant");
    expect(decryptSecret(dataKeyFrom(KEY)!, `bank_inputs:${inp.id}`, ri)).toBe("sk-ant-secret");
    expect(() => decryptSecret(dataKeyFrom(KEY)!, `bank_inputs:other`, ri)).toThrow();
    expect(world.bank.apiKeyFor(inp.id)).toBe("sk-ant-secret");
    expect(world.users.getApiKey(seed.admin.id)).toBe("sk-ant-donor");
    expect(world.bank.apiKeyCredential(inp.id)).toEqual({ kind: "api-key", secret: "sk-ant-secret", inputId: inp.id });
    world.bank.cancelInput(seed.admin.id, inp.id);
    expect(raw(world, "bank_inputs", inp.id)).toBeNull();
  });

  it("back-fills plaintext rows once, idempotently, and legacy plaintext reads as is before that", () => {
    const { world, seed } = setup();
    const inp = world.bank.addInput(seed.admin.id, { label: "Key", source: "api-key", model: "m", tokens: 10, apiKey: "sk-a" }, T0);
    world.db.prepare("UPDATE bank_inputs SET apiKey = 'sk-plain' WHERE id = ?").run(inp.id);
    world.db.prepare("UPDATE users SET apiKey = 'sk-donor', hasApiKey = 1 WHERE id = ?").run(seed.admin.id);
    expect(world.bank.apiKeyFor(inp.id)).toBe("sk-plain");
    const before = (world.db.prepare("SELECT COUNT(*) n FROM bank_inputs WHERE apiKey IS NOT NULL AND apiKey NOT LIKE 'v1:%'").get() as { n: number }).n;
    expect(world.secrets.encryptBankSecrets()).toEqual({ inputs: before, donors: 1 });
    expect(raw(world, "bank_inputs", inp.id)).toMatch(/^v1:/);
    expect(raw(world, "users", seed.admin.id)).toMatch(/^v1:/);
    expect(world.bank.apiKeyFor(inp.id)).toBe("sk-plain");
    expect(world.users.getApiKey(seed.admin.id)).toBe("sk-donor");
    const again = raw(world, "bank_inputs", inp.id);
    expect(world.secrets.encryptBankSecrets()).toEqual({ inputs: 0, donors: 0 });
    expect(raw(world, "bank_inputs", inp.id)).toBe(again);
  });

  it("a copy under another key reads its secrets as null with one warning per row, never throwing into fundingFor", () => {
    const { world, seed } = setup();
    const inp = world.bank.addInput(seed.admin.id, { label: "Key", source: "api-key", model: "m", tokens: 10, apiKey: "sk-a" }, T0);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    world.bankInputs.secret.dataKey = () => randomBytes(32).toString("base64");
    expect(world.bank.apiKeyFor(inp.id)).toBeNull();
    expect(world.bank.apiKeyFor(inp.id)).toBeNull();
    expect(world.bank.apiKeyCredential(inp.id)).toBeNull();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes(`bank input ${inp.id} unusable`))).toHaveLength(1);
    const b = world.buildings.all()[0]!;
    try { world.budget.fundingFor(b.id, { now: T0 }); } catch (e) { expect((e as Error).name).not.toBe("TypeError"); }
  });

  it("with no data key: stores plaintext (the Bank still runs), and the back-fill does nothing", () => {
    const { world, seed } = setup(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const inp = world.bank.addInput(seed.admin.id, { label: "Key", source: "api-key", model: "m", tokens: 10, apiKey: "sk-a" }, T0);
    expect(raw(world, "bank_inputs", inp.id)).toBe("sk-a");
    expect(world.bank.apiKeyFor(inp.id)).toBe("sk-a");
    expect(warn.mock.calls.some((c) => String(c[0]).includes("stored in plaintext"))).toBe(true);
    expect(world.secrets.encryptBankSecrets()).toEqual({ inputs: 0, donors: 0 });
  });
});
