import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ActivityEvent, BuildingConfig, DeskConfig, DeskStatus, Report } from "./types.js";
import { buildingDir, loadBuildings } from "./town.js";
import { latestReport, nextRunNumber, runFile, stampRun, writeFallbackReport } from "./reports.js";
import { runPrompt } from "./prompts.js";

const MAX_ACTIVITY = 40;
const key = (b: string, d: string) => `${b}/${d}`;

export class Runner extends EventEmitter {
  private running = new Map<string, { run: number; started: string }>();
  private activity = new Map<string, ActivityEvent[]>();
  private errors = new Map<string, string>();
  private timer?: NodeJS.Timeout;

  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), 10_000);
  }

  /** Poll: any desk whose latest report was approved/redirected and hasn't been consumed starts its next run. */
  private tick(): void {
    for (const b of loadBuildings()) {
      for (const d of b.desks) {
        const k = key(b.id, d.id);
        if (this.running.has(k)) continue;
        const last = latestReport(b.id, d.id);
        if (!last) continue;
        if (last.decision === "approve" || last.decision === "redirect") {
          // consumed if a later run file exists
          if (fs.existsSync(runFile(b.id, d.id, last.run + 1))) continue;
          void this.runDesk(b, d, last, last.decision === "redirect" ? last.note : undefined);
        }
      }
    }
  }

  status(b: BuildingConfig, d: DeskConfig): DeskStatus {
    const k = key(b.id, d.id);
    const last = latestReport(b.id, d.id);
    const r = this.running.get(k);
    let state: DeskStatus["state"] = "idle";
    if (r) state = "working";
    else if (this.errors.has(k)) state = "error";
    else if (last?.decision === "stop") state = "stopped";
    else if (last?.decision === "pending") state = "awaiting-review";
    else if (last) state = "idle"; // approved but not yet picked up
    const meta = last ? { ...last, body: undefined } : undefined;
    return {
      state,
      run: r?.run ?? last?.run ?? 0,
      activity: this.activity.get(k) ?? [],
      latestReport: meta as DeskStatus["latestReport"],
      error: this.errors.get(k),
    };
  }

  /** Manually kick off a desk (first run, or re-run after an error). */
  kick(b: BuildingConfig, d: DeskConfig, note?: string): boolean {
    const k = key(b.id, d.id);
    if (this.running.has(k)) return false;
    const last = latestReport(b.id, d.id);
    if (last && last.decision === "pending") return false; // must decide first
    this.errors.delete(k);
    void this.runDesk(b, d, last, note);
    return true;
  }

  private emitActivity(ev: ActivityEvent): void {
    const k = key(ev.building, ev.desk);
    const list = this.activity.get(k) ?? [];
    list.push(ev);
    if (list.length > MAX_ACTIVITY) list.splice(0, list.length - MAX_ACTIVITY);
    this.activity.set(k, list);
    this.emit("activity", ev);
    try {
      fs.appendFileSync(path.join(buildingDir(ev.building), "reports", ev.desk, `run-${String(ev.run).padStart(3, "0")}.log`),
        `${ev.ts} [${ev.kind}] ${ev.text}\n`);
    } catch { /* ignore */ }
  }

  private async runDesk(b: BuildingConfig, d: DeskConfig, prev?: Report, note?: string): Promise<void> {
    const k = key(b.id, d.id);
    const run = nextRunNumber(b.id, d.id);
    const started = new Date().toISOString();
    this.running.set(k, { run, started });
    fs.mkdirSync(path.join(buildingDir(b.id), "reports", d.id), { recursive: true });
    const say = (kind: ActivityEvent["kind"], text: string) =>
      this.emitActivity({ building: b.id, desk: d.id, run, ts: new Date().toISOString(), kind, text });
    say("status", `Run ${run} started${note ? ` (redirect: ${note.slice(0, 80)})` : ""}`);
    this.emit("state");
    let finalText = "";
    let error: string | undefined;
    let costUsd: number | undefined;
    let turns: number | undefined;
    try {
      const q = query({
        prompt: runPrompt(b, d, run, prev, note),
        options: {
          cwd: buildingDir(b.id),
          model: b.model,
          maxTurns: b.maxTurns ?? 40,
          permissionMode: "acceptEdits",
          allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite"],
          disallowedTools: ["Bash", "Task", "Agent"],
          systemPrompt: { type: "preset", preset: "claude_code" },
        },
      });
      for await (const m of q) {
        if (m.type === "assistant") {
          for (const block of (m as any).message?.content ?? []) {
            if (block.type === "tool_use") say("tool", describeTool(block.name, block.input));
            else if (block.type === "text" && block.text?.trim()) say("text", block.text.trim().slice(0, 240));
          }
        } else if (m.type === "result") {
          finalText = (m as any).result ?? "";
          costUsd = (m as any).total_cost_usd;
          turns = (m as any).num_turns;
          if ((m as any).is_error) error = (m as any).errors?.join("; ") || "run ended with error";
        }
      }
    } catch (e: any) {
      error = e?.message ?? String(e);
    }
    if (!fs.existsSync(runFile(b.id, d.id, run))) {
      writeFallbackReport(b.id, d.id, run, started, finalText, error);
      say("status", `Run ${run} ended without a report; fallback report written`);
    } else {
      say("status", `Run ${run} finished: report ready for review${costUsd != null ? ` ($${costUsd.toFixed(2)})` : ""}`);
    }
    stampRun(b.id, d.id, run, { cost_usd: costUsd != null ? Number(costUsd.toFixed(4)) : undefined, turns, ended: new Date().toISOString() });
    if (error) this.errors.set(k, error);
    this.running.delete(k);
    this.emit("state");
  }
}

function describeTool(name: string, input: any): string {
  switch (name) {
    case "WebSearch": return `Searching: ${input?.query ?? ""}`;
    case "WebFetch": return `Reading ${shortUrl(input?.url)}`;
    case "Read": return `Reading ${rel(input?.file_path)}`;
    case "Write": return `Writing ${rel(input?.file_path)}`;
    case "Edit": return `Editing ${rel(input?.file_path)}`;
    case "Glob": return `Looking for ${input?.pattern ?? "files"}`;
    case "Grep": return `Grepping for ${input?.pattern ?? ""}`;
    case "TodoWrite": return "Updating plan";
    default: return `${name}`;
  }
}
function rel(p?: string): string {
  if (!p) return "";
  const i = p.indexOf("/buildings/");
  return i >= 0 ? p.slice(i + 11).split("/").slice(1).join("/") : path.basename(p);
}
function shortUrl(u?: string): string {
  if (!u) return "";
  try { const x = new URL(u); return x.hostname + (x.pathname.length > 1 ? x.pathname.slice(0, 40) : ""); } catch { return u.slice(0, 50); }
}
