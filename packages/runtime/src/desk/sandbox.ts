/**
 * Desks on a rented sandbox provider instead of our own docker daemon (`desks.backend: "fly"`).
 * `SandboxBackend` implements the same `DeskBackend` the docker one does: a persistent sandbox per agent with its
 * home on a volume, and the runtime runs `agent-town-desk run --session <id>` in it. Everything provider-specific
 * sits behind `SandboxApi` (injectable for tests); `FlyApi` (fly.ts) is the real one.
 *
 * Differences from docker desks the rest of the runtime doesn't see:
 *  - the desk reaches the town over the internet (`desks.townUrl`), not `host.docker.internal`;
 *  - the session env is uploaded as a 0600 file the command sources and deletes, so the session's own command line
 *    carries no secret. Known gap: the upload itself is an exec whose argv holds the file base64-encoded (the Machines
 *    API has no file-write call), so a provider that records exec commands sees the values; a fetch-by-one-time-code
 *    from the town would close it;
 *  - the provider bills wall-clock time while a sandbox runs, so it is stopped shortly after its session ends.
 */
import type { Agent, Building } from "@muster-town/schema";
import { DESK_BIN, dockerSafe, killPattern, killTreeCommand, shq, type DeskBackend, type DeskChild, type DeskHandle, type LineSink } from "./backend.ts";

export type SandboxState = "started" | "stopped" | "other" | "error";
export interface SandboxInfo { id: string; name: string; state: SandboxState }

/** What `SandboxBackend` needs from a provider. Names are `desk-<collective>-<agent>`; the home volume is `deskhome-<agent>`. */
export interface SandboxApi {
  available(): Promise<boolean>;
  find(name: string): Promise<SandboxInfo | null>;
  create(spec: { name: string; labels: Record<string, string>; volume: string; mountPath: string }): Promise<SandboxInfo>;
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  /** write `content` to `path` in the sandbox with mode 0600 */
  writeSecretFile(name: string, path: string, content: string): Promise<void>;
  /** run `command` (a shell line) to the end; stdout and stderr go to `onLine`; resolves with the exit code */
  run(name: string, command: string, onLine?: LineSink, signal?: AbortSignal): Promise<number>;
  /** one-shot command, output dropped; best effort */
  quick(name: string, command: string, timeoutSec?: number): Promise<void>;
  remove(name: string, opts: { volume?: string }): Promise<void>;
}

export interface SandboxBackendOptions {
  api: SandboxApi;
  collective: string;
  /** stop a sandbox this long after its last session ends (the provider bills while it runs) */
  idleStopMs?: number;
  /** activity ping while a session runs, so the provider's own idle auto-stop doesn't cut it off (0 = none, for providers without one) */
  heartbeatMs?: number;
}

export const SANDBOX_HOME = "/home/agent";

export { shq };

export { killPattern };

export class SandboxBackend implements DeskBackend {
  /** the runtime's "container backend" kind: sessions are recorded as backend `docker` whichever provider runs them */
  readonly kind = "docker" as const;
  private readonly api: SandboxApi;
  private readonly collective: string;
  private readonly idleStopMs: number;
  private readonly heartbeatMs: number;
  private readonly active = new Map<string, number>();
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: SandboxBackendOptions) {
    this.api = opts.api;
    this.collective = dockerSafe(opts.collective);
    this.idleStopMs = opts.idleStopMs ?? 3 * 60_000;
    this.heartbeatMs = opts.heartbeatMs ?? 5 * 60_000;
  }

  sandboxName(agentId: string): string { return `desk-${this.collective}-${dockerSafe(agentId)}`; }
  volumeName(agentId: string): string { return `deskhome-${dockerSafe(agentId)}`; }

  available(): Promise<boolean> {
    return this.api.available().catch(() => false);
  }

  async ensure(agent: Agent, _building: Building): Promise<DeskHandle> {
    const name = this.sandboxName(agent.id);
    this.cancelIdleStop(name);
    let found = await this.api.find(name);
    if (found?.state === "error") {
      // a Machine that failed (e.g. never started after create) stays in that state for good: replace it, home volume kept
      console.warn(`[sandbox ${name}] in an error state; removing it and creating a fresh one (home volume kept)`);
      await this.api.remove(name, {});
      found = null;
    }
    if (!found) {
      await this.api.create({
        name, volume: this.volumeName(agent.id), mountPath: SANDBOX_HOME,
        labels: { "muster-town.desk": "1", "muster-town.agent": agent.id, "muster-town.collective": this.collective },
      });
    } else if (found.state !== "started") {
      await this.api.start(name);
    }
    return { name, agentId: agent.id };
  }

  exec(handle: DeskHandle, argv: string[], env: Record<string, string>, onLine?: LineSink): DeskChild {
    const name = handle.name;
    this.cancelIdleStop(name);
    this.active.set(name, (this.active.get(name) ?? 0) + 1);
    const envFile = `/tmp/.desk-env-${Math.random().toString(36).slice(2)}`;
    const body = Object.entries(env).map(([k, v]) => `export ${k}=${shq(v)}`).join("\n") + "\n";
    // a subshell, because the provider runs commands in a long-lived shell that must not be replaced or left with the env
    const command = `( . ${envFile}; rm -f ${envFile}; ${argv.map(shq).join(" ")} )`;
    const abort = new AbortController();
    const heartbeat = this.heartbeatMs > 0 ? setInterval(() => { void this.api.quick(name, "true", 10).catch(() => {}); }, this.heartbeatMs) : null;
    heartbeat?.unref?.();
    const startedAt = Date.now();
    const exited: Promise<number> = (async () => {
      let code = -1;
      try {
        await this.api.writeSecretFile(name, envFile, body);
        code = await this.api.run(name, command, onLine, abort.signal);
        return code;
      } catch (e) {
        onLine?.("stderr", `sandbox exec failed: ${e instanceof Error ? e.message : String(e)}`);
        return -1;
      } finally {
        console.log(`[sandbox ${name}] process ended (exit ${code}) after ${Math.round((Date.now() - startedAt) / 1000)}s; stopping the sandbox in ${Math.round(this.idleStopMs / 1000)}s unless it is used again`);
        if (heartbeat) clearInterval(heartbeat);
        void this.api.quick(name, `rm -f ${envFile}`, 10).catch(() => {});
        const left = (this.active.get(name) ?? 1) - 1;
        if (left <= 0) { this.active.delete(name); this.scheduleIdleStop(name); } else this.active.set(name, left);
      }
    })();
    return {
      wait: () => exited,
      kill: () => { abort.abort(); void this.killExec(handle, argv); },
    };
  }

  async killExec(handle: DeskHandle, argv: string[]): Promise<void> {
    try { await this.api.quick(handle.name, killTreeCommand(killPattern(argv)), 15); } catch { /* best effort */ }
  }

  /** A sandbox (and a session in it) outlives the server process: after a restart, stop the leftover session. */
  async killOrphan(agentId: string, sessionId: string): Promise<void> {
    const name = this.sandboxName(agentId);
    try {
      const found = await this.api.find(name);
      if (found?.state !== "started") return;
      await this.killExec({ name, agentId }, [DESK_BIN, "run", "--session", sessionId]);
    } catch { /* best effort */ }
  }

  async remove(agentId: string, opts: { purge?: boolean } = {}): Promise<void> {
    const name = this.sandboxName(agentId);
    this.cancelIdleStop(name);
    try {
      await this.api.remove(name, { volume: opts.purge ? this.volumeName(agentId) : undefined });
    } catch (e) {
      console.warn(`[runtime] removing sandbox ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private cancelIdleStop(name: string): void {
    const t = this.idleTimers.get(name);
    if (t) { clearTimeout(t); this.idleTimers.delete(name); }
  }

  private scheduleIdleStop(name: string): void {
    this.cancelIdleStop(name);
    const t = setTimeout(() => {
      this.idleTimers.delete(name);
      if (this.active.has(name)) return;
      console.log(`[sandbox ${name}] idle: stopping`);
      void this.api.stop(name).catch((e) => console.warn(`[runtime] stopping idle sandbox ${name} failed: ${e instanceof Error ? e.message : String(e)}`));
    }, this.idleStopMs);
    t.unref?.();
    this.idleTimers.set(name, t);
  }
}
