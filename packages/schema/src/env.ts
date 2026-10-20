/**
 * Town env vars during the Agent Town → Muster Town rename: `MUSTER_TOWN_<X>` wins, `AGENT_TOWN_<X>` still works
 * for one release (drop the fallback in rename P6).
 */
export type TownEnvName =
  | "TOKEN" | "URL" | "HOME" | "EXPORT" | "DATA" | "COLLECTIVE" | "DEV"
  | "ADMIN_NAME" | "ADMINS" | "PUBLIC_URL" | "SESSION_SECRET" | "GITHUB_URL";

export const ENV_PREFIX = "MUSTER_TOWN_";
export const OLD_ENV_PREFIX = "AGENT_TOWN_";

type Env = Record<string, string | undefined>;
const processEnv = (): Env => (globalThis as { process?: { env: Env } }).process?.env ?? {};

/**
 * `MUSTER_TOWN_<name>`, else `AGENT_TOWN_<name>`, else undefined. A blank new name (unset, or only whitespace)
 * falls through to the old one, so an empty `MUSTER_TOWN_TOKEN=` in a .env doesn't hide a real `AGENT_TOWN_TOKEN`.
 * Values are returned as set (not trimmed); callers trim where they always did.
 */
export function townEnv(name: TownEnvName, env: Env = processEnv()): string | undefined {
  const v = env[ENV_PREFIX + name];
  if (v !== undefined && v.trim() !== "") return v;
  return env[OLD_ENV_PREFIX + name] ?? v;
}

/** Both names for one value, for env handed to another process (desk exec) that may run old or new code. */
export function townEnvBoth(name: TownEnvName, value: string): Record<string, string> {
  return { [ENV_PREFIX + name]: value, [OLD_ENV_PREFIX + name]: value };
}

