/**
 * Desks on a rented sandbox provider instead of our own docker daemon (`desks.backend: "daytona"`).
 * `SandboxBackend` implements the same `DeskBackend` the docker one does: a persistent sandbox per agent with its
 * home on a volume, and the runtime runs `agent-town-desk run --session <id>` in it. Everything provider-specific
 * sits behind `SandboxApi` (injectable for tests); `DaytonaApi` is the real one.
 *
 * Differences from docker desks the rest of the runtime doesn't see:
 *  - the desk reaches the town over the internet (`desks.townUrl`), not `host.docker.internal`;
 *  - the session env is uploaded as a 0600 file the command sources and deletes, so secret values never sit in a
 *    command string (which the provider records) the way `docker exec -e KEY` keeps them out of argv;
 *  - the provider bills wall-clock time while a sandbox runs, so it is stopped shortly after its session ends.
 */
import type { Agent, Building } from "@muster-town/schema";
import { DESK_BIN, dockerSafe, type DeskBackend, type DeskChild, type DeskHandle, type LineSink } from "./backend.ts";

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

export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * A `pkill -f` regex for the process `argv` starts. The desk binary is a shell script that execs node, so the running
 * command line no longer starts with the binary's name: match the arguments after it. The first character is bracketed
 * so the regex doesn't match the shell that carries the pkill command itself.
 */
export function killPattern(argv: string[]): string {
  const p = argv.slice(1).join(" ") || argv[0];
  return `[${p[0]}]${p.slice(1)}`;
}

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
    const found = await this.api.find(name);
    if (!found) {
      await this.api.create({
        name, volume: this.volumeName(agent.id), mountPath: SANDBOX_HOME,
        labels: { "muster-town.desk": "1", "muster-town.agent": agent.id, "muster-town.collective": this.collective },
      });
    } else if (found.state === "error") {
      throw new Error(`sandbox ${name} is in an error state`);
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
    const exited: Promise<number> = (async () => {
      try {
        await this.api.writeSecretFile(name, envFile, body);
        return await this.api.run(name, command, onLine, abort.signal);
      } catch (e) {
        onLine?.("stderr", `sandbox exec failed: ${e instanceof Error ? e.message : String(e)}`);
        return -1;
      } finally {
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
    try { await this.api.quick(handle.name, `pkill -TERM -f ${shq(killPattern(argv))} || true`, 10); } catch { /* best effort */ }
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
      void this.api.stop(name).catch((e) => console.warn(`[runtime] stopping idle sandbox ${name} failed: ${e instanceof Error ? e.message : String(e)}`));
    }, this.idleStopMs);
    t.unref?.();
    this.idleTimers.set(name, t);
  }
}

// ---- Daytona ----

export interface DaytonaOptions {
  /** the snapshot desks are created from (built from packages/desk/Dockerfile: `npm run desk:snapshot`) */
  snapshot: string;
  apiKey?: string;
  apiUrl?: string;
  target?: string;
  /** provider-side idle auto-stop in minutes: a backstop for a sandbox left running when the server died */
  autoStopMinutes?: number;
  cpu?: number;
  memoryGiB?: number;
}

/** Splits a stream of chunks into lines. */
export function lineSplitter(emit: (line: string) => void): { push(chunk: string): void; flush(): void } {
  let buf = "";
  return {
    push(chunk) {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) { emit(buf.slice(0, i).replace(/\r$/, "")); buf = buf.slice(i + 1); }
    },
    flush() { if (buf) { emit(buf); buf = ""; } },
  };
}

// The SDK is loaded on first use, so hosts that never select this backend don't need it to start.
type DaytonaSdk = typeof import("@daytona/sdk");
type DaytonaClient = InstanceType<DaytonaSdk["Daytona"]>;
type DaytonaSandbox = Awaited<ReturnType<DaytonaClient["get"]>>;

export class DaytonaApi implements SandboxApi {
  private client: DaytonaClient | null = null;
  constructor(private readonly opts: DaytonaOptions) {}

  private async daytona(): Promise<DaytonaClient> {
    if (!this.client) {
      const { Daytona } = await import("@daytona/sdk");
      const apiKey = this.opts.apiKey ?? process.env.DAYTONA_API_KEY;
      if (!apiKey) throw new Error("DAYTONA_API_KEY is not set");
      this.client = new Daytona({ apiKey, ...(this.opts.apiUrl ? { apiUrl: this.opts.apiUrl } : {}), ...(this.opts.target ? { target: this.opts.target } : {}) });
    }
    return this.client;
  }

  private async sandbox(name: string): Promise<DaytonaSandbox> {
    return (await this.daytona()).get(name);
  }

  async available(): Promise<boolean> {
    try {
      const d = await this.daytona();
      await Promise.race([
        (async () => { for await (const _ of d.list({})) break; })(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000)),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async find(name: string): Promise<SandboxInfo | null> {
    const d = await this.daytona();
    try {
      const s = await d.get(name);
      const state = String(s.state ?? "");
      return { id: s.id, name, state: state === "started" ? "started" : state === "stopped" || state === "archived" ? "stopped" : state === "error" || state === "build_failed" ? "error" : "other" };
    } catch (e) {
      if (/not found|404/i.test(e instanceof Error ? e.message : String(e))) return null;
      throw e;
    }
  }

  async create(spec: { name: string; labels: Record<string, string>; volume: string; mountPath: string }): Promise<SandboxInfo> {
    const d = await this.daytona();
    let vol = await d.volume.get(spec.volume, true);
    // a new volume is `pending_create` for a few seconds, and creating a sandbox with it then fails
    for (let i = 0; i < 30 && String(vol.state) !== "ready"; i++) {
      if (String(vol.state) === "error") throw new Error(`volume ${spec.volume} is in an error state`);
      await new Promise((r) => setTimeout(r, 2000));
      vol = await d.volume.get(spec.volume);
    }
    const s = await d.create({
      name: spec.name, snapshot: this.opts.snapshot, labels: spec.labels,
      volumes: [{ volumeId: vol.id, mountPath: spec.mountPath }],
      autoStopInterval: this.opts.autoStopMinutes ?? 30,
    }, { timeout: 180 });
    return { id: s.id, name: spec.name, state: "started" };
  }

  async start(name: string): Promise<void> { await (await this.sandbox(name)).start(120); }
  async stop(name: string): Promise<void> { await (await this.sandbox(name)).stop(); }

  async writeSecretFile(name: string, path: string, content: string): Promise<void> {
    const s = await this.sandbox(name);
    await s.fs.uploadFile(Buffer.from(content), path);
    await s.fs.setFilePermissions(path, { mode: "600" });
  }

  async run(name: string, command: string, onLine?: LineSink, signal?: AbortSignal): Promise<number> {
    const s = await this.sandbox(name);
    const sessionId = `run-${Math.random().toString(36).slice(2, 10)}`;
    await s.process.createSession(sessionId);
    try {
      const started = await s.process.executeSessionCommand(sessionId, { command, runAsync: true });
      const cmdId = started.cmdId;
      const out = lineSplitter((l) => onLine?.("stdout", l));
      const err = lineSplitter((l) => onLine?.("stderr", l));
      const aborted = new Promise<"aborted">((r) => signal?.addEventListener("abort", () => r("aborted"), { once: true }));
      const done = await Promise.race([s.process.getSessionCommandLogs(sessionId, cmdId, (c) => out.push(c), (c) => err.push(c)).then(() => "done" as const), aborted]);
      out.flush(); err.flush();
      if (done === "aborted") return -1; // the log stream can hang on a command that never started; kill() also pkills it
      // the log stream ends when the command does; the exit code can lag it by a moment
      for (let i = 0; i < 20; i++) {
        const c = await s.process.getSessionCommand(sessionId, cmdId);
        if (typeof c.exitCode === "number") return c.exitCode;
        await new Promise((r) => setTimeout(r, 500));
      }
      return -1;
    } finally {
      await s.process.deleteSession(sessionId).catch(() => {});
    }
  }

  async quick(name: string, command: string, timeoutSec = 10): Promise<void> {
    const s = await this.sandbox(name);
    await s.process.executeCommand(command, undefined, undefined, timeoutSec);
  }

  async remove(name: string, opts: { volume?: string }): Promise<void> {
    const d = await this.daytona();
    try {
      await d.delete(await d.get(name), 60, true);
    } catch (e) {
      if (!/not found|404/i.test(e instanceof Error ? e.message : String(e))) throw e;
    }
    if (opts.volume) {
      try { await d.volume.delete(await d.volume.get(opts.volume)); } catch { /* already gone */ }
    }
  }
}
