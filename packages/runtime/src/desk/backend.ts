/**
 * Where resident work sessions run. `DockerBackend`: a persistent container per agent (the desk), with
 * the agent's home on a volume; the runtime `docker exec`s `agent-town-desk run --session <id>` in it (DESK_BIN).
 * `HostBackend`: the in-process SDK session (no code tools), the fallback when there is no container runtime.
 */
import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Agent, Building } from "@muster-town/schema";

export interface DeskHandle {
  /** container name */
  name: string;
  agentId: string;
}

/** A running `exec` in a desk. `wait` resolves with the exit code (-1 if it couldn't start). */
export interface DeskChild {
  wait(): Promise<number>;
  kill(): void;
}

export type LineSink = (stream: "stdout" | "stderr", line: string) => void;

/** A container backend: one desk per agent. */
export interface DeskBackend {
  readonly kind: "docker";
  /** whether the container runtime answers (e.g. `docker info` exits 0 within 5 s) */
  available(): Promise<boolean>;
  /** the agent's desk exists and is running (created on first use) */
  ensure(agent: Agent, building: Building): Promise<DeskHandle>;
  /** run `argv` in the desk with `env`; stdout/stderr lines go to `onLine` */
  exec(handle: DeskHandle, argv: string[], env: Record<string, string>, onLine?: LineSink): DeskChild;
  /** best-effort: stop the process started by `exec` (the CLI child is killed separately) */
  killExec?(handle: DeskHandle, argv: string[]): Promise<void>;
  /** best-effort: stop `agent-town-desk run --session <id>` left running in the agent's desk by a previous server process */
  killOrphan?(agentId: string, sessionId: string): Promise<void>;
  /** dismissed agent: `docker rm -f` its desk; the home volume is kept unless `purge` */
  remove?(agentId: string, opts?: { purge?: boolean }): Promise<void>;
}

/** In-process work sessions (today's `runAgentSession` path). Always available; no code tools. */
export class HostBackend {
  readonly kind = "host" as const;
  async available(): Promise<boolean> {
    return true;
  }
}

export type WorkBackend = DeskBackend | HostBackend;

// ---- docker CLI runner (injectable for tests) ----
export interface RunResult { code: number; stdout: string; stderr: string }
export interface SpawnedChild {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: "exit", cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}
export interface DockerRunner {
  /** one-shot `docker <args>` */
  run(args: string[], opts?: { timeoutMs?: number }): Promise<RunResult>;
  /** long-running `docker <args>` with extra env for the docker CLI process */
  spawn(args: string[], opts: { env: Record<string, string> }): SpawnedChild;
}

export const realDockerRunner: DockerRunner = {
  run(args, opts = {}) {
    return new Promise((resolve) => {
      execFile("docker", args, { timeout: opts.timeoutMs ?? 120_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      });
    });
  },
  spawn(args, opts) {
    return spawn("docker", args, { env: { ...process.env, ...opts.env }, stdio: ["ignore", "pipe", "pipe"] });
  },
};

export interface DockerBackendOptions {
  /** collective slug, part of the container name: desk-<collective>-<agentId> */
  collective: string;
  image?: string;
  memory?: string;
  cpus?: string;
  runner?: DockerRunner;
}

/** Default desk image. Rename compat: hosts may still have only the old tag (see imageTags in redeploy.ts). */
export const DESK_IMAGE = "muster-town-desk";
export const OLD_DESK_IMAGE = "agent-town-desk";
/**
 * The desk's resident host binary. New images have `muster-town-desk` with `agent-town-desk` as an alias; images built
 * before the rename only have the old name, so exec that until rename P6 (then switch to muster-town-desk).
 */
export const DESK_BIN = "agent-town-desk";
/** Desk container labels are `<prefix>.desk|agent|collective`. New desks get the first; the second is pre-rename (drop in P6). */
export const DESK_LABEL_PREFIXES = ["muster-town", "agent-town"] as const;

export const dockerSafe = (s: string) => s.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "town";

export class DockerBackend implements DeskBackend {
  readonly kind = "docker" as const;
  readonly image: string;
  private readonly runner: DockerRunner;
  private readonly collective: string;
  private readonly memory: string;
  private readonly cpus: string;

  constructor(opts: DockerBackendOptions) {
    this.collective = dockerSafe(opts.collective);
    this.image = opts.image ?? DESK_IMAGE;
    this.memory = opts.memory ?? "2g";
    this.cpus = opts.cpus ?? "2";
    this.runner = opts.runner ?? realDockerRunner;
  }

  containerName(agentId: string): string {
    return `desk-${this.collective}-${dockerSafe(agentId)}`;
  }
  volumeName(agentId: string): string {
    return `deskhome-${dockerSafe(agentId)}`;
  }

  async available(): Promise<boolean> {
    try {
      return (await this.runner.run(["info"], { timeoutMs: 5000 })).code === 0;
    } catch {
      return false;
    }
  }

  async ensure(agent: Agent, _building: Building): Promise<DeskHandle> {
    const name = this.containerName(agent.id);
    const state = await this.runner.run(["inspect", "-f", "{{.State.Running}}", name], { timeoutMs: 15_000 });
    if (state.code !== 0) {
      const r = await this.runner.run([
        "run", "-d", "--name", name,
        "-v", `${this.volumeName(agent.id)}:/home/agent`,
        "--add-host=host.docker.internal:host-gateway",
        "--memory", this.memory, "--cpus", this.cpus,
        "--label", "muster-town.desk=1", "--label", `muster-town.agent=${agent.id}`, "--label", `muster-town.collective=${this.collective}`,
        this.image, "sleep", "infinity",
      ]);
      if (r.code !== 0) throw new Error(`docker run ${name} failed: ${r.stderr.trim().slice(0, 300)}`);
    } else if (state.stdout.trim() !== "true") {
      const r = await this.runner.run(["start", name], { timeoutMs: 60_000 });
      if (r.code !== 0) throw new Error(`docker start ${name} failed: ${r.stderr.trim().slice(0, 300)}`);
    }
    return { name, agentId: agent.id };
  }

  exec(handle: DeskHandle, argv: string[], env: Record<string, string>, onLine?: LineSink): DeskChild {
    // `-e KEY` (no value) makes docker read the value from the CLI's own env: secrets never appear in argv.
    const envFlags = Object.keys(env).flatMap((k) => ["-e", k]);
    const child = this.runner.spawn(["exec", ...envFlags, handle.name, ...argv], { env });
    for (const [stream, src] of [["stdout", child.stdout], ["stderr", child.stderr]] as const) {
      if (src && onLine) createInterface({ input: src }).on("line", (line) => onLine(stream, line));
    }
    const exited = new Promise<number>((resolve) => {
      child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
      child.on("error", () => resolve(-1));
    });
    return {
      wait: () => exited,
      kill: () => {
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
        void this.killExec(handle, argv);
      },
    };
  }

  /** Dismiss: remove the desk container (`docker rm -f`); with `purge`, also the home volume. Best effort. */
  async remove(agentId: string, opts: { purge?: boolean } = {}): Promise<void> {
    const name = this.containerName(agentId);
    const r = await this.runner.run(["rm", "-f", name], { timeoutMs: 60_000 });
    if (r.code !== 0 && !/no such container/i.test(r.stderr)) console.warn(`[runtime] docker rm -f ${name} failed: ${r.stderr.trim().slice(0, 200)}`);
    if (opts.purge) {
      const v = await this.runner.run(["volume", "rm", "-f", this.volumeName(agentId)], { timeoutMs: 60_000 });
      if (v.code !== 0) console.warn(`[runtime] docker volume rm ${this.volumeName(agentId)} failed: ${v.stderr.trim().slice(0, 200)}`);
    }
  }

  /** The container (and a `docker exec`'d session in it) outlives the server process; after a restart, stop the leftover session. */
  async killOrphan(agentId: string, sessionId: string): Promise<void> {
    await this.killExec({ name: this.containerName(agentId), agentId }, [DESK_BIN, "run", "--session", sessionId]);
  }

  /** `docker exec <name> pkill -TERM -f "<pattern>"`: killing the CLI doesn't stop the process inside the container. */
  async killExec(handle: DeskHandle, argv: string[]): Promise<void> {
    try { await this.runner.run(["exec", handle.name, "pkill", "-TERM", "-f", killPattern(argv)], { timeoutMs: 10_000 }); } catch { /* best effort */ }
  }
}

/**
 * A `pkill -f` regex for the process `argv` starts. The desk binary is a shell script that execs node, so the running
 * command line no longer contains the binary's name (`node … cli.ts run --session <id>`): match the arguments after it.
 * The first character is bracketed so the regex doesn't match the shell that carries the pkill command itself.
 */
export function killPattern(argv: string[]): string {
  const p = argv.slice(1).join(" ") || argv[0];
  return `[${p[0]}]${p.slice(1)}`;
}
