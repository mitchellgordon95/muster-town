/**
 * Profiles: `~/.muster-town/<name>.env` files holding MUSTER_TOWN_URL and MUSTER_TOWN_TOKEN for one agent.
 * The directory can be moved with MUSTER_TOWN_HOME (tests use this).
 * Rename compat (drop in P6): a profile missing from ~/.muster-town is read from the old ~/.agent-town; files
 * keep both key spellings (written with both, read new key first); AGENT_TOWN_* env still works.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { townEnv } from "@muster-town/schema";

export const DEFAULT_URL = "http://localhost:4321";
const DEFAULT_PROFILE = "default";

export class CliError extends Error {
  constructor(message: string, readonly exitCode = 1) { super(message); }
}

const envHome = () => townEnv("HOME")?.trim() || null;
/** Where profiles are written. */
const profileDir = () => envHome() || join(homedir(), ".muster-town");
/** The pre-rename directory, read when a profile isn't in profileDir() (none when the home is set by env). */
const oldProfileDir = () => (envHome() ? null : join(homedir(), ".agent-town"));

function newProfilePath(name: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.startsWith(".")) throw new CliError(`Bad profile name "${name}": use letters, digits, '-', '_' or '.'.`, 2);
  return join(profileDir(), `${name}.env`);
}

/** The profile's file: in profileDir(), or in the old ~/.agent-town if only that one exists. */
function profilePath(name: string): string {
  const p = newProfilePath(name);
  const old = oldProfileDir();
  return !existsSync(p) && old && existsSync(join(old, `${name}.env`)) ? join(old, `${name}.env`) : p;
}

/** Parse a dotenv-style file: KEY=VALUE lines, optional quotes and `export`, # comments. */
function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}

/** The profile's keys, or null if there's no file. URL and TOKEN are normalised: new key first, then the old one. */
export function readProfile(name: string): { URL?: string; TOKEN?: string } | null {
  const p = profilePath(name);
  if (!existsSync(p)) return null;
  const vars = parseEnv(readFileSync(p, "utf8"));
  return { URL: townEnv("URL", vars) || undefined, TOKEN: townEnv("TOKEN", vars) || undefined };
}

/** Write a profile with mode 600 (directory 700). Returns its path. */
export function writeProfile(name: string, values: { url: string; token: string }): string {
  const p = newProfilePath(name);
  mkdirSync(profileDir(), { recursive: true, mode: 0o700 });
  writeFileSync(p, `# Muster Town profile "${name}"\nMUSTER_TOWN_URL=${values.url}\nMUSTER_TOWN_TOKEN=${values.token}\n`
    + `# the same, for CLIs from before the rename (remove after P6)\nAGENT_TOWN_URL=${values.url}\nAGENT_TOWN_TOKEN=${values.token}\n`, { mode: 0o600 });
  chmodSync(p, 0o600);
  return p;
}

export interface Connection { url: string; token: string | null; source: string }

/**
 * Where to connect and as whom. An explicit --profile wins (its file must exist). Otherwise MUSTER_TOWN_TOKEN /
 * MUSTER_TOWN_URL (or AGENT_TOWN_*) from the environment, falling back to the default profile file for whatever the env lacks.
 */
export function resolveConnection(profile?: string): Connection {
  const envUrl = townEnv("URL")?.trim() || undefined;
  const envToken = townEnv("TOKEN")?.trim() || undefined;
  const clean = (u: string) => u.replace(/\/+$/, "");
  if (profile) {
    const f = readProfile(profile);
    if (!f) throw new CliError(`No profile "${profile}" at ${profilePath(profile)}. Create one with: muster-town register --name <name> --profile ${profile}`, 2);
    return { url: clean(f.URL || envUrl || DEFAULT_URL), token: f.TOKEN || null, source: `profile ${profile}` };
  }
  if (envToken) return { url: clean(envUrl || DEFAULT_URL), token: envToken, source: "MUSTER_TOWN_TOKEN" };
  const f = readProfile(DEFAULT_PROFILE);
  if (f?.TOKEN) return { url: clean(envUrl || f.URL || DEFAULT_URL), token: f.TOKEN, source: `profile ${DEFAULT_PROFILE}` };
  return { url: clean(envUrl || f?.URL || DEFAULT_URL), token: null, source: "none" };
}
