import { World } from "@muster-town/core";
import type { FastifyInstance } from "fastify";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app.ts";
import type { RuntimeHooks } from "../src/context.ts";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export async function seededApp(opts: { runtime?: RuntimeHooks | null; dev?: boolean } = {}) {
  const world = World.open(":memory:");
  const seed = world.seedDefaults({ importDir: join(REPO_ROOT, "buildings/carbon-cycle"), townJsonPath: join(REPO_ROOT, "town.json") });
  const app = await buildApp({ world, dev: opts.dev ?? true, runtime: opts.runtime ?? null, webDist: false });
  const auth = { authorization: `Bearer ${seed.adminToken}` };
  const by = (name: string) => world.agents.first("name = ?", [name])!;
  const close = async () => { await app.close(); world.close(); };
  return { world, seed, app, auth, by, close };
}

export async function json<T = any>(app: FastifyInstance, method: string, url: string, opts: { headers?: Record<string, string>; body?: unknown } = {}) {
  const res = await app.inject({ method: method as "GET", url, headers: opts.headers, payload: opts.body as object | undefined });
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as T) : (null as T) };
}
