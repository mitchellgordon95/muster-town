import type { Agent, AgentStatus, ServerMessage, Tile } from "@agent-town/schema";
import { AppError } from "../errors.ts";
import type { EventLog } from "../events.ts";
import type { Repos } from "../store.ts";
import type { Emitter } from "../util.ts";
import type { WorldMap } from "./map.ts";
import { findPath } from "./path.ts";

export const WALK_TILES_PER_SEC = 8;
export const WALK_TIMEOUT_MS = 30_000;

interface Walk {
  agentId: string;
  path: Tile[];
  progress: number;
  elapsed: number;
  prevStatus: AgentStatus;
  label: string;
  resolve: (a: Agent) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Bodies walking along BFS paths, advanced by `tick`. */
export class Movement {
  private walks = new Map<string, Walk>();
  constructor(private repos: Repos, private map: WorldMap, private events: EventLog, private changes: Emitter<ServerMessage>) {}

  isWalking(agentId: string): boolean {
    return this.walks.has(agentId);
  }

  /** Where a walking agent will end up (undefined if not walking). */
  destination(agentId: string): Tile | undefined {
    const w = this.walks.get(agentId);
    return w?.path[w.path.length - 1];
  }

  /** Walk `agent` to `target`. Resolves with the updated agent on arrival; rejects on unreachable/timeout/superseded. */
  go(agent: Agent, target: Tile, label = `${target.x},${target.y}`): Promise<Agent> {
    const path = findPath(this.map.grid, agent.pos, target);
    if (!path) return Promise.reject(new AppError("unreachable", `No walkable path to ${label}.`));
    const prior = this.walks.get(agent.id);
    if (prior) this.finish(prior, new AppError("conflict", "Walk superseded by a new `go`."));
    if (path.length === 0) return Promise.resolve(this.repos.agents.require(agent.id));
    const prevStatus = prior ? prior.prevStatus : agent.status;
    return new Promise<Agent>((resolve, reject) => {
      const walk: Walk = {
        agentId: agent.id, path, progress: 0, elapsed: 0, prevStatus, label, resolve, reject,
        timer: setTimeout(() => this.finish(walk, new AppError("timeout", `Timed out walking to ${label}.`)), WALK_TIMEOUT_MS),
      };
      walk.timer.unref?.();
      this.walks.set(agent.id, walk);
      this.repos.agents.patch(agent.id, { status: "walking", activity: `Walking to ${label}` });
    });
  }

  /** Cancel an agent's walk (e.g. banned/stopped). */
  cancel(agentId: string, reason = "Walk cancelled."): void {
    const w = this.walks.get(agentId);
    if (w) this.finish(w, new AppError("conflict", reason));
  }

  tick(dtMs: number): void {
    if (!this.walks.size) return;
    const moved: { id: string; x: number; y: number; status: AgentStatus }[] = [];
    for (const w of [...this.walks.values()]) {
      w.elapsed += dtMs;
      w.progress += (dtMs / 1000) * WALK_TILES_PER_SEC;
      let pos: Tile | null = null;
      while (w.progress >= 1 && w.path.length) { pos = w.path.shift()!; w.progress -= 1; }
      if (pos) {
        const a = this.repos.agents.get(w.agentId);
        if (!a) { this.finish(w, new AppError("not_found", "Agent vanished.")); continue; }
        this.repos.agents.upsert({ ...a, pos }, { silent: true });
        moved.push({ id: a.id, x: pos.x, y: pos.y, status: "walking" });
      }
      if (!w.path.length) this.finish(w, null);
      else if (w.elapsed > WALK_TIMEOUT_MS) this.finish(w, new AppError("timeout", `Timed out walking to ${w.label}.`));
    }
    if (moved.length) this.changes.emit({ type: "agents.pos", positions: moved });
  }

  private finish(w: Walk, err: Error | null): void {
    clearTimeout(w.timer);
    this.walks.delete(w.agentId);
    const a = this.repos.agents.get(w.agentId);
    if (!a) { w.reject(err ?? new AppError("not_found", "Agent vanished.")); return; }
    // non-residents' buildingId follows their body
    const inside = this.map.buildingAt(a.pos);
    const buildingId = a.kind === "resident" ? a.buildingId : inside?.id ?? null;
    const status = a.status === "walking" ? w.prevStatus : a.status;
    const updated = this.repos.agents.upsert({ ...a, status, buildingId, activity: err ? a.activity : `Arrived at ${w.label}` });
    if (err) { w.reject(err); return; }
    this.events.append({ type: "agent.moved", agentId: a.id, buildingId: updated.buildingId, text: `${a.name} walked to ${w.label}`, payload: { to: w.label, pos: a.pos } });
    w.resolve(updated);
  }
}
