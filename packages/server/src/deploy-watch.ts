/**
 * Deploy watch (grant gr_h2iocyzfjm): is the live server behind the branch it deploys from? Every 5 min it reads the
 * deploy branch's tip from GitHub (`prod` on muster.town: CI fast-forwards it to each green main) and, when the tip is not
 * the live commit, the compare between them. Live 8.5 h behind prod on 11-16 (CI's deploy token revoked, FYI dc_4yrb3979ty)
 * and on 11-04 (dc_uzwcg5xw3u) raised nothing; the monitor's `deploy` key (monitor.ts) now does, from this view.
 * `behindSince` is when this server first saw the tip carry a change the puller deploys (not only docs/, .github/ or top-level
 * *.md, but docs/manual.md counts: schema `deployable`, shared with runtime prod-watch.ts), kept in meta `deployWatch` so a restart that brings no new
 * commit keeps the clock. A GitHub error leaves the state `unknown`: the monitor then changes nothing.
 * Off unless MUSTER_TOWN_DEPLOY_BRANCH is set and the repo is on GitHub. Anonymous GitHub allows 60 calls/h per IP: one
 * branch read per poll, plus one compare when the pair (live, tip) is new; the town's GH_TOKEN is used when set.
 */
import type { World } from "@muster-town/core";
import { deployable } from "@muster-town/schema";

const DEPLOY_POLL_MS = 5 * 60_000;

export interface DeployView {
  /** the branch the redeploy pulls */
  branch: string;
  /** current: live is the tip (or ahead); behind: a deployable change waits; docs-only: only files that need no restart wait; unknown: never read, or the last read failed */
  state: "current" | "behind" | "docs-only" | "unknown";
  live: string | null;
  prodTip: string | null;
  /** commits on the tip not in live */
  behindCommits: number;
  /** when this server first saw a deployable change on the tip that live lacks; null when none waits */
  behindSince: string | null;
  /** the last successful read */
  checkedAt: string | null;
  /** the last read's error (cleared by the next good read) */
  error: string | null;
}


interface Persisted { live: string; behindSince: string }

interface DeployWatchOptions {
  world: Pick<World, "db">;
  branch: string;
  repo: () => { owner: string; repo: string } | null;
  live: () => string | null;
  token?: () => string | null;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (m: string) => void;
}

export class DeployWatch {
  private v: DeployView;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  /** `${live}..${tip}` → its compare, so an unchanged pair costs one call per poll */
  private compared = new Map<string, { ahead: number; deployable: boolean }>();
  private readonly now: () => number;

  constructor(private readonly o: DeployWatchOptions) {
    this.now = o.now ?? Date.now;
    this.v = { branch: o.branch, state: "unknown", live: o.live(), prodTip: null, behindCommits: 0, behindSince: null, checkedAt: null, error: null };
  }

  view(): DeployView { return { ...this.v }; }

  start(everyMs = DEPLOY_POLL_MS) {
    const run = () => { void this.poll(); };
    run();
    this.timer = setInterval(run, everyMs);
    this.timer.unref();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** One read of the tip (and the compare when the pair is new). Single-flight; never throws. */
  poll(): Promise<void> {
    this.running ??= this.read().finally(() => { this.running = null; });
    return this.running;
  }

  private async read(): Promise<void> {
    const live = this.o.live();
    this.v.live = live;
    try {
      if (!live) throw new Error("this server has no live commit (no runtime or no git checkout)");
      const tip = (await this.gh<{ commit: { sha: string } }>(`/branches/${encodeURIComponent(this.o.branch)}`)).commit.sha;
      let c = tip === live ? { ahead: 0, deployable: false } : this.compared.get(`${live}..${tip}`);
      if (!c) {
        const r = await this.gh<{ status: string; ahead_by: number; files?: { filename: string }[] }>(`/compare/${live}...${tip}`);
        const ahead = r.status === "ahead" || r.status === "diverged" ? r.ahead_by : 0;
        // GitHub lists at most 300 files: a compare without them is a big one, so it is deployable
        c = { ahead, deployable: ahead > 0 && (!r.files || r.files.length === 0 || r.files.some((f) => deployable(f.filename))) };
        this.compared.clear();
        this.compared.set(`${live}..${tip}`, c);
      }
      const at = new Date(this.now()).toISOString();
      let behindSince: string | null = null;
      if (c.deployable) {
        const p = this.load();
        behindSince = p && p.live === live ? p.behindSince : at;
        if (!p || p.live !== live) this.save({ live, behindSince });
      } else this.save(null);
      this.v = { branch: this.o.branch, state: c.deployable ? "behind" : c.ahead > 0 ? "docs-only" : "current", live, prodTip: tip, behindCommits: c.ahead, behindSince, checkedAt: at, error: null };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.v = { ...this.v, state: "unknown", error: msg };
      this.o.log?.(`[deploy-watch] ${msg}`);
    }
  }

  private async gh<T>(path: string): Promise<T> {
    const r = this.o.repo();
    if (!r) throw new Error("the town's repo is not on GitHub");
    const token = this.o.token?.() ?? null;
    const res = await (this.o.fetch ?? fetch)(`https://api.github.com/repos/${r.owner}/${r.repo}${path}`, {
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`GitHub ${path.split("/")[1]}: HTTP ${res.status}${res.status === 403 || res.status === 429 ? " (rate limit?)" : ""}`);
    return await res.json() as T;
  }

  private load(): Persisted | null {
    const r = this.o.world.db.prepare("SELECT value FROM meta WHERE key = 'deployWatch'").get() as { value: string } | undefined;
    try { return r ? JSON.parse(r.value) as Persisted : null; } catch { return null; }
  }

  private save(p: Persisted | null) {
    if (!p) { this.o.world.db.prepare("DELETE FROM meta WHERE key = 'deployWatch'").run(); return; }
    this.o.world.db.prepare("INSERT INTO meta (key, value) VALUES ('deployWatch', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(p));
  }
}
