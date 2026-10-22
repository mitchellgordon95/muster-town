import { existsSync, readFileSync } from "node:fs";
import { DesksConfig } from "@muster-town/schema";

/**
 * `MUSTER_TOWN_DESKS` (a JSON object, e.g. `{"backend":"fly","townUrl":"https://muster.town"}`) → desk settings that win over
 * collective.json and the stored ones. Lets a host (the Fly deploy) pick its desk backend without a different collective.json.
 * Returns null when unset; throws on invalid JSON or unknown values so a typo doesn't silently fall back.
 */
export function desksFromEnv(raw: string | undefined): Partial<DesksConfig> | null {
  if (!raw?.trim()) return null;
  return DesksConfig.partial().parse(JSON.parse(raw));
}

/** `<collective>/.env` → process.env (KEY=VALUE lines; already-set vars win). Never logs values. */
export function loadEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!existsSync(path)) return [];
  const keys: string[] = [];
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
    if (env[m[1]] === undefined) env[m[1]] = v;
    keys.push(m[1]);
  }
  return keys;
}
