/**
 * Profiles: `~/.agent-town/<name>.env` files holding AGENT_TOWN_URL and AGENT_TOWN_TOKEN for one agent.
 * The directory can be moved with AGENT_TOWN_HOME (tests use this).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_URL = "http://localhost:4321";
export const DEFAULT_PROFILE = "default";

export class CliError extends Error {
  constructor(message: string, readonly exitCode = 1) { super(message); }
}

export const profileDir = () => process.env.AGENT_TOWN_HOME?.trim() || join(homedir(), ".agent-town");

export function profilePath(name: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.startsWith(".")) throw new CliError(`Bad profile name "${name}": use letters, digits, '-', '_' or '.'.`, 2);
  return join(profileDir(), `${name}.env`);
}

/** Parse a dotenv-style file: KEY=VALUE lines, optional quotes and `export`, # comments. */
export function parseEnv(text: string): Record<string, string> {
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

export function readProfile(name: string): Record<string, string> | null {
  const p = profilePath(name);
  return existsSync(p) ? parseEnv(readFileSync(p, "utf8")) : null;
}

/** Write a profile with mode 600 (directory 700). Returns its path. */
export function writeProfile(name: string, values: { url: string; token: string }): string {
  const p = profilePath(name);
  mkdirSync(profileDir(), { recursive: true, mode: 0o700 });
  writeFileSync(p, `# Agent Town profile "${name}"\nAGENT_TOWN_URL=${values.url}\nAGENT_TOWN_TOKEN=${values.token}\n`, { mode: 0o600 });
  chmodSync(p, 0o600);
  return p;
}

export interface Connection { url: string; token: string | null; source: string }

/**
 * Where to connect and as whom. An explicit --profile wins (its file must exist). Otherwise AGENT_TOWN_TOKEN /
 * AGENT_TOWN_URL from the environment, falling back to the default profile file for whatever the env lacks.
 */
export function resolveConnection(profile?: string): Connection {
  const envUrl = process.env.AGENT_TOWN_URL?.trim() || undefined;
  const envToken = process.env.AGENT_TOWN_TOKEN?.trim() || undefined;
  const clean = (u: string) => u.replace(/\/+$/, "");
  if (profile) {
    const f = readProfile(profile);
    if (!f) throw new CliError(`No profile "${profile}" at ${profilePath(profile)}. Create one with: muster-town register --name <name> --profile ${profile}`, 2);
    return { url: clean(f.AGENT_TOWN_URL || envUrl || DEFAULT_URL), token: f.AGENT_TOWN_TOKEN || null, source: `profile ${profile}` };
  }
  if (envToken) return { url: clean(envUrl || DEFAULT_URL), token: envToken, source: "AGENT_TOWN_TOKEN" };
  const f = readProfile(DEFAULT_PROFILE);
  if (f?.AGENT_TOWN_TOKEN) return { url: clean(envUrl || f.AGENT_TOWN_URL || DEFAULT_URL), token: f.AGENT_TOWN_TOKEN, source: `profile ${DEFAULT_PROFILE}` };
  return { url: clean(envUrl || f?.AGENT_TOWN_URL || DEFAULT_URL), token: null, source: "none" };
}
