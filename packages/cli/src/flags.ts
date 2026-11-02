/**
 * Derive command-line flags from a verb's Zod input (zod 4): string / number / boolean / enum fields become
 * typed flags, arrays become repeatable flags, objects take JSON. `--json <object>` is merged underneath the flags.
 */
import { Command, Option } from "commander";
import { readFileSync } from "node:fs";
import { CliError } from "./profile.ts";

type FieldKind = "string" | "number" | "boolean" | "enum" | "array" | "json";
interface FieldSpec {
  key: string;
  flag: string;
  kind: FieldKind;
  /** for arrays: the element kind */
  item?: FieldKind;
  values?: string[];
  required: boolean;
  defaultValue?: unknown;
  description?: string;
}

/** Fields that are often long: `-` as their value reads stdin (any string field accepts it; help only mentions these). */
const LONG_TEXT = new Set(["body", "text", "description", "note", "why"]);

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Minimal structural view of a zod 4 schema (no runtime zod import: the CLI only reads `_zod.def`). */
interface ZodLike { _zod: { def: Record<string, any> & { type: string } }; description?: string }
const tn = (t: ZodLike) => t._zod.def.type;

function unwrap(t: ZodLike): { inner: ZodLike; optional: boolean; defaultValue?: unknown; description?: string } {
  let optional = false;
  let defaultValue: unknown;
  let description: string | undefined;
  for (;;) {
    description ??= t.description;
    const d = t._zod.def;
    if (d.type === "optional" || d.type === "nullable") { optional = true; t = d.innerType; continue; }
    if (d.type === "default" || d.type === "prefault") { optional = true; defaultValue = d.defaultValue; t = d.innerType; continue; }
    if (d.type === "readonly" || d.type === "catch" || d.type === "nonoptional") { t = d.innerType; continue; }
    if (d.type === "pipe") { t = d.in; continue; }
    if (d.type === "lazy") { t = d.getter(); continue; }
    return { inner: t, optional, defaultValue, description };
  }
}

function kindOf(t: ZodLike): { kind: FieldKind; values?: string[] } {
  const d = t._zod.def;
  switch (d.type) {
    case "string": return { kind: "string" };
    case "number": return { kind: "number" };
    case "boolean": return { kind: "boolean" };
    case "enum": return { kind: "enum", values: Object.values(d.entries).map(String) };
    case "literal": return d.values.length === 1 && typeof d.values[0] === "string" ? { kind: "enum", values: [d.values[0]] } : { kind: "json" };
    default: return { kind: "json" };
  }
}

export function fieldsOf(schema: unknown): FieldSpec[] {
  const obj = unwrap(schema as ZodLike).inner;
  if (tn(obj) !== "object") return [];
  const shape = obj._zod.def.shape as Record<string, ZodLike>;
  return Object.entries(shape).map(([key, t]) => {
    const u = unwrap(t);
    const base = { key, flag: kebab(key), required: !u.optional, defaultValue: u.defaultValue, description: u.description };
    if (tn(u.inner) === "array") {
      const el = kindOf(unwrap(u.inner._zod.def.element).inner);
      return { ...base, kind: "array" as const, item: el.kind, values: el.values };
    }
    return { ...base, ...kindOf(u.inner) };
  });
}

/** Add one option per field, plus --json. Booleans get --x and --no-x; nothing is commander-required (--json may supply it). */
export function addFieldOptions(cmd: Command, fields: FieldSpec[]): void {
  for (const f of fields) {
    const desc = [f.description, f.required ? "(required)" : "", f.defaultValue !== undefined ? `(default ${JSON.stringify(f.defaultValue)})` : ""].filter(Boolean).join(" ");
    if (f.kind === "boolean") {
      cmd.addOption(new Option(`--${f.flag}`, desc || f.key));
      cmd.addOption(new Option(`--no-${f.flag}`, `set ${f.key} to false`));
      continue;
    }
    const arg = f.kind === "number" ? "<n>" : f.kind === "json" ? "<json>" : f.kind === "array" ? "<value>" : "<text>";
    const extra = f.kind === "array" ? "(repeatable, or a JSON array)" : f.kind === "string" && LONG_TEXT.has(f.key) ? "('-' reads stdin)" : "";
    let o = new Option(`--${f.flag} ${arg}`, [desc, extra].filter(Boolean).join(" "));
    if (f.kind === "enum" && f.values) o = o.choices(f.values);
    if (f.kind === "array") o = o.argParser((v: string, prev: string[] | undefined) => [...(prev ?? []), v]);
    cmd.addOption(o);
  }
  cmd.option("--json <object>", "the whole input as a JSON object (flags override its fields)");
}

let stdinCache: string | null = null;
const readStdin = () => (stdinCache ??= readFileSync(0, "utf8"));

function parseJson(text: string, what: string): unknown {
  try { return JSON.parse(text); } catch { throw new CliError(`${what} is not valid JSON: ${text.slice(0, 80)}`, 2); }
}

function convert(f: FieldSpec, kind: FieldKind, raw: string): unknown {
  if (kind === "number") {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n)) throw new CliError(`--${f.flag} expects a number, got "${raw}"`, 2);
    return n;
  }
  if (kind === "boolean") return raw === "true" || raw === "1" || raw === "yes";
  if (kind === "json") return parseJson(raw, `--${f.flag}`);
  if (kind === "string" && raw === "-") return readStdin().replace(/\n$/, "");
  return raw;
}

/** Build the verb input from commander's parsed options. */
export function inputFromOptions(fields: FieldSpec[], opts: Record<string, unknown>): Record<string, unknown> {
  let input: Record<string, unknown> = {};
  if (typeof opts.json === "string") {
    const j = parseJson(opts.json, "--json");
    if (!j || typeof j !== "object" || Array.isArray(j)) throw new CliError("--json must be a JSON object", 2);
    input = { ...(j as Record<string, unknown>) };
  }
  for (const f of fields) {
    const camel = f.flag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    const v = opts[camel];
    if (v === undefined) continue;
    if (f.kind === "boolean") { input[f.key] = v; continue; }
    if (f.kind === "array") {
      const items = v as string[];
      if (items.length === 1 && items[0]!.trim().startsWith("[")) { input[f.key] = parseJson(items[0]!, `--${f.flag}`); continue; }
      input[f.key] = items.map((s) => convert(f, f.item ?? "string", s));
      continue;
    }
    input[f.key] = convert(f, f.kind, String(v));
  }
  const missing = fields.filter((f) => f.required && input[f.key] === undefined);
  if (missing.length) throw new CliError(`Missing ${missing.map((f) => `--${f.flag}`).join(", ")}`, 2);
  return input;
}
