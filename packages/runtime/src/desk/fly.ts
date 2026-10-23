/**
 * Fly.io Machines as the sandbox provider (`desks.backend: "fly"`): one Machine per agent with its home on a Fly volume,
 * created in the app named by `FLY_APP` with the app-scoped deploy token in `FLY_API_TOKEN` (host secrets, never DESK_ENV_*).
 * `SandboxBackend` drives it through `SandboxApi`.
 *
 * Fly's exec call is synchronous and the API drops it after about a minute, so a session is not run through one exec:
 * it is started in the background on the Machine (a wrapper script writing /tmp/run-<id>.log and /tmp/run-<id>.exit) and
 * followed with short polling execs. That also means a server restart doesn't lose the process.
 */
import type { LineSink } from "./backend.ts";
import { shq, type SandboxApi, type SandboxInfo } from "./sandbox.ts";

export interface FlyOptions {
  app: string;
  /** an app-scoped deploy token, sent as-is in the Authorization header */
  token: string;
  /** the desk image, e.g. registry.fly.io/<app>:desk (see fly.desk.toml) */
  image: string;
  region?: string;
  cpuKind?: "shared" | "performance";
  cpus?: number;
  memoryMb?: number;
  volumeGb?: number;
  /** a Machine stops itself after this long (a backstop for one left running when the server died) */
  maxLifetimeSec?: number;
  pollMs?: number;
  fetch?: typeof fetch;
}

interface FlyMachine { id: string; name: string; state: string }
interface FlyVolume { id: string; name: string; state: string; region?: string; attached_machine_id?: string | null }
interface ExecResult { stdout: string; stderr: string; exit_code: number; exit_signal: number }

/** Fly names: machines are lowercase letters, digits and dashes; volumes lowercase letters, digits and underscores, 30 chars at most. */
export const flyMachineName = (name: string) => name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 60);
export const flyVolumeName = (name: string) => name.toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(-30);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
/** Most log bytes one poll reads (Fly caps exec output; the exit marker must never be what gets cut off). */
export const POLL_CHUNK = 64 * 1024;

export class FlyApi implements SandboxApi {
  private readonly f: typeof fetch;
  private readonly ids = new Map<string, string>();
  private readonly opts: Required<Omit<FlyOptions, "fetch">>;

  constructor(opts: FlyOptions) {
    this.f = opts.fetch ?? fetch;
    // options the caller leaves unset (passed as `undefined`, as the runtime does from its config) must not wipe the defaults
    const given = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined));
    this.opts = {
      region: "iad", cpuKind: "shared", cpus: 2, memoryMb: 2048, volumeGb: 5, maxLifetimeSec: 6 * 3600, pollMs: 1500, ...given,
    } as Required<Omit<FlyOptions, "fetch">>;
  }

  /** One API call. `timeoutMs` bounds the whole request: a hung connection must not stall a session's poll loop for minutes. */
  private async req<T = unknown>(method: string, path: string, body?: unknown, ok: number[] = [200, 201], timeoutMs = 30_000): Promise<{ status: number; body: T }> {
    const r = await this.f(`https://api.machines.dev/v1/apps/${this.opts.app}${path}`, {
      method, headers: { Authorization: this.opts.token, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await r.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    if (!ok.includes(r.status)) throw new Error(`fly ${method} ${path} -> ${r.status} ${text.slice(0, 200)}`);
    return { status: r.status, body: parsed as T };
  }

  private async machine(name: string): Promise<FlyMachine | null> {
    const flyName = flyMachineName(name);
    const { body } = await this.req<FlyMachine[]>("GET", "/machines");
    const m = body.find((x) => x.name === flyName) ?? null;
    if (m) this.ids.set(name, m.id); else this.ids.delete(name);
    return m;
  }

  private async id(name: string): Promise<string> {
    const cached = this.ids.get(name);
    if (cached) return cached;
    const m = await this.machine(name);
    if (!m) throw new Error(`no Fly machine for ${name}`);
    return m.id;
  }

  async available(): Promise<boolean> {
    try {
      await Promise.race([this.req("GET", "/machines"), sleep(8000).then(() => { throw new Error("timeout"); })]);
      return true;
    } catch {
      return false;
    }
  }

  async find(name: string): Promise<SandboxInfo | null> {
    const m = await this.machine(name);
    if (!m) return null;
    const state = m.state === "started" ? "started" : m.state === "stopped" || m.state === "suspended" ? "stopped" : m.state === "destroyed" || m.state === "failed" ? "error" : "other";
    return { id: m.id, name, state };
  }

  async create(spec: { name: string; labels: Record<string, string>; volume: string; mountPath: string }): Promise<SandboxInfo> {
    const o = this.opts;
    const volName = flyVolumeName(spec.volume);
    const vols = (await this.req<FlyVolume[]>("GET", "/volumes")).body.filter((v) => !/destroy/.test(v.state) && v.name === volName);
    const vol = vols[0] ?? (await this.req<FlyVolume>("POST", "/volumes", { name: volName, region: o.region, size_gb: o.volumeGb })).body;
    const machineBody = {
      // a Machine must run where its volume lives (an existing one may predate the configured region)
      name: flyMachineName(spec.name), region: vol.region ?? o.region,
      config: {
        image: o.image,
        // bounded, so a Machine left running by a dead server stops itself; the runtime starts it again when needed
        init: { cmd: ["sleep", String(o.maxLifetimeSec)] },
        restart: { policy: "no" },
        guest: { cpu_kind: o.cpuKind, cpus: o.cpus, memory_mb: o.memoryMb },
        mounts: [{ volume: vol.id, path: spec.mountPath }],
        metadata: spec.labels,
      },
    };
    // a just-created volume or pushed image can take a moment to be visible to the Machines API
    let created!: { status: number; body: FlyMachine };
    for (let i = 0; ; i++) {
      try {
        created = await this.req<FlyMachine>("POST", "/machines", machineBody);
        break;
      } catch (e) {
        if (i >= 4 || !/volume not found|manifest unknown|MANIFEST_UNKNOWN/.test(String(e))) throw e;
        await sleep(3000);
      }
    }
    this.ids.set(spec.name, created.body.id);
    try {
      await this.waitState(created.body.id, "started");
    } catch (e) {
      // a Machine that never started stays "failed" for good and would block every later ensure: don't leave it behind
      await this.req("DELETE", `/machines/${created.body.id}?force=true`, undefined, [200, 202, 204, 404]).catch(() => {});
      this.ids.delete(spec.name);
      throw e;
    }
    // a fresh Fly volume is root-owned (docker volumes copy the image's ownership): hand the home to the desk user
    await this.exec(spec.name, ["sh", "-c", `chown agent:agent ${shq(spec.mountPath)} 2>/dev/null; mkdir -p ${shq(spec.mountPath)}/work && chown agent:agent ${shq(spec.mountPath)}/work 2>/dev/null; true`]);
    return { id: created.body.id, name: spec.name, state: "started" };
  }

  private async waitState(id: string, state: "started" | "stopped"): Promise<void> {
    for (let i = 0; i < 3; i++) {
      const r = await this.f(`https://api.machines.dev/v1/apps/${this.opts.app}/machines/${id}/wait?state=${state}&timeout=60`, { headers: { Authorization: this.opts.token }, signal: AbortSignal.timeout(75_000) });
      if (r.ok) return;
      await sleep(1000);
    }
    throw new Error(`fly machine ${id} did not reach ${state}`);
  }

  async start(name: string): Promise<void> {
    const id = await this.id(name);
    // right after a stop Fly can still say "stopping": retry
    for (let i = 0; ; i++) {
      try {
        await this.req("POST", `/machines/${id}/start`, {});
        break;
      } catch (e) {
        if (i >= 15 || !/412|stopping|failed_precondition/.test(String(e))) throw e;
        await sleep(2000);
      }
    }
    await this.waitState(id, "started");
  }

  async stop(name: string): Promise<void> {
    await this.req("POST", `/machines/${await this.id(name)}/stop`, {});
  }

  private async exec(name: string, command: string[], timeoutSec = 30): Promise<ExecResult> {
    const id = await this.id(name);
    return (await this.req<ExecResult>("POST", `/machines/${id}/exec`, { command, timeout: timeoutSec }, [200, 201], timeoutSec * 1000 + 15_000)).body;
  }

  async writeSecretFile(name: string, path: string, content: string): Promise<void> {
    const r = await this.exec(name, ["sh", "-c", `umask 077; echo ${b64(content)} | base64 -d > ${shq(path)}; chown agent:agent ${shq(path)} 2>/dev/null; true`]);
    if (r.exit_code !== 0) throw new Error(`writing ${path} failed: ${r.stderr.trim().slice(0, 200)}`);
  }

  async run(name: string, command: string, onLine?: LineSink, signal?: AbortSignal): Promise<number> {
    const id = Math.random().toString(36).slice(2, 10);
    const log = `/tmp/run-${id}.log`, exit = `/tmp/run-${id}.exit`, script = `/tmp/run-${id}.sh`;
    // the wrapper runs the command as the desk user (HOME set, since runuser keeps root's), logs, then records the exit code
    const wrapper = `#!/bin/sh\n( ${command} ) > ${log} 2>&1\necho $? > ${exit}\n`;
    const launch = `echo ${b64(wrapper)} | base64 -d > ${script}; chmod 755 ${script}; touch ${log}; chmod 666 ${log}; ` +
      `if [ "$(id -u)" = 0 ]; then nohup runuser -u agent -- env HOME=/home/agent sh ${script} >/dev/null 2>&1 < /dev/null & else nohup sh ${script} >/dev/null 2>&1 < /dev/null & fi; true`;
    await this.exec(name, ["sh", "-c", launch]);

    let offset = 0;
    let failures = 0;
    let carry = "";
    const emit = (text: string) => {
      carry += text;
      let i: number;
      while ((i = carry.indexOf("\n")) >= 0) { onLine?.("stdout", carry.slice(0, i).replace(/\r$/, "")); carry = carry.slice(i + 1); }
    };
    for (;;) {
      if (signal?.aborted) return -1;
      await sleep(this.opts.pollMs);
      if (signal?.aborted) return -1;
      try {
        // exit code first, log second: if the code is there, the log read after it is complete. The chunk is capped so the
        // exit marker always fits in what the API returns; a full chunk means more is waiting, so the code is read next time
        const r = await this.exec(name, ["sh", "-c", `E=$(cat ${exit} 2>/dev/null); tail -c +${offset + 1} ${log} 2>/dev/null | head -c ${POLL_CHUNK}; printf '\\n__EXIT__%s' "$E"`], 20);
        failures = 0;
        const at = r.stdout.lastIndexOf("\n__EXIT__");
        if (at < 0) continue;
        const chunk = r.stdout.slice(0, at);
        const code = r.stdout.slice(at + "\n__EXIT__".length).trim();
        const bytes = Buffer.byteLength(chunk, "utf8");
        offset += bytes;
        emit(chunk);
        if (code !== "" && bytes < POLL_CHUNK) {
          if (carry) { onLine?.("stdout", carry); carry = ""; }
          void this.exec(name, ["sh", "-c", `rm -f ${log} ${exit} ${script}`]).catch(() => {});
          return Number(code);
        }
      } catch {
        // the Machine may be restarting or gone; give up after a few misses so the session doesn't hang forever
        if (++failures >= 5) return -1;
      }
    }
  }

  async quick(name: string, command: string, timeoutSec = 10): Promise<void> {
    await this.exec(name, ["sh", "-c", command], timeoutSec);
  }

  async remove(name: string, opts: { volume?: string }): Promise<void> {
    const m = await this.machine(name).catch(() => null);
    if (m) await this.req("DELETE", `/machines/${m.id}?force=true`, undefined, [200, 202, 204, 404]);
    this.ids.delete(name);
    if (opts.volume) {
      const volName = flyVolumeName(opts.volume);
      const v = (await this.req<FlyVolume[]>("GET", "/volumes")).body.find((x) => x.name === volName && !/destroy/.test(x.state));
      if (v) {
        // the volume can't go while the Machine is still being destroyed
        for (let i = 0; i < 5; i++) {
          try { await this.req("DELETE", `/volumes/${v.id}`, undefined, [200, 202, 204, 404]); break; } catch { await sleep(2000); }
        }
      }
    }
  }
}
