/**
 * @agent-town/runtime — resident work sessions (Claude Agent SDK over the town MCP endpoint),
 * moderator review sessions, meeting summaries + facilitation, proxy chat, interrupts, scheduler.
 */
import type { World } from "@agent-town/core";
import type { ChatInput, Event, Session } from "@agent-town/schema";
import { chat } from "./chat.ts";
import { advanceCollecting, facilitate, newMeetingState, onMeetingStart } from "./meetings.ts";
import { realSdk, type Sdk } from "./sdk.ts";
import type { Ctx } from "./session.ts";
import { abortWork, interrupt, maybeReview, runWorkSession } from "./work.ts";

export { describeTool } from "./describe.ts";
export * as prompts from "./prompts.ts";
export { InputChannel, oneShot, realSdk, usageOf, userMessage, type QueryHandle, type QueryParams, type Sdk } from "./sdk.ts";
export { DISALLOWED_TOOLS, TOWN_TOOLS, WEB_TOOLS } from "./session.ts";
export { COLLECTING_MS } from "./meetings.ts";

export interface RuntimeOptions {
  world: World;
  /** the server's MCP endpoint, e.g. http://127.0.0.1:4321/mcp */
  mcpUrl: string;
  /** scheduler clock (tests inject one) */
  now?: () => Date;
  /** Agent SDK (`{ query }`); defaults to @anthropic-ai/claude-agent-sdk */
  sdk?: Sdk;
  /** scheduler period; 0 disables the timer (call tickOnce yourself). Default 5000. */
  intervalMs?: number;
  /** Agent Town repo root; building workspaces resolve relative paths from here */
  repoRoot?: string;
  /** hourly git export target; false disables. Default: world.export() default dir. */
  exportDir?: string | false;
}

export interface Runtime {
  stop(): Promise<void>;
  chat(agentId: string, input: (typeof ChatInput)["_input"]): Promise<{ reply: string }>;
  /** Deliver `text` as the next user message of the agent's running work session. False if none. */
  interrupt(agentId: string, text: string, from?: string): Promise<boolean>;
  /** Meeting entered collecting (or scheduled → collecting): run attendees' summaries. */
  onMeetingStart(meetingId: string): Promise<void>;
  /** Run one work session now; resolves with the ended session. */
  runWorkSession(agentId: string, assignmentId: string): Promise<Session>;
  /** One scheduler pass. Starts sessions in the background (see whenIdle). */
  tickOnce(): Promise<void>;
  /** Resolves when every background session/task has finished. */
  whenIdle(): Promise<void>;
  /** Whether the agent has a live work session. */
  isWorking(agentId: string): boolean;
}

const HOUR_MS = 3_600_000;
const localDate = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
const LIVE_PHASES = new Set(["scheduled", "collecting", "discussing"]);

export function startRuntime(opts: RuntimeOptions): Runtime {
  const { world } = opts;
  const now = opts.now ?? (() => new Date());
  const tasks = new Set<Promise<unknown>>();
  const track = <T>(p: Promise<T>): Promise<T> => {
    tasks.add(p);
    const done = () => tasks.delete(p);
    p.then(done, done);
    return p;
  };
  const ctx: Ctx = { world, mcpUrl: opts.mcpUrl, repoRoot: opts.repoRoot ?? process.cwd(), now, sdk: opts.sdk ?? realSdk, live: new Map(), track };
  const starting = new Set<string>();
  const reviewed = new Set<string>();
  const mst = newMeetingState();
  const startedAt = now().getTime();
  let lastDate = localDate(now());
  let lastExport = startedAt;
  let stopped = false;
  const log = (what: string) => (e: unknown) => console.log(`[runtime] ${what}:`, e instanceof Error ? e.message : e);

  /** Run `fn` after the current (possibly transactional) event dispatch, tracked. */
  const later = (fn: () => Promise<unknown>, what: string) => {
    if (stopped) return;
    void track(new Promise<void>((r) => setImmediate(r)).then(fn).catch(log(what)));
  };

  const startWork = (agentId: string, assignmentId: string) => track(runWorkSession(ctx, starting, agentId, assignmentId));

  const onEvent = (e: Event) => {
    const p = e.payload as Record<string, unknown>;
    if (e.type === "doc.created" && p.docType === "report") later(() => maybeReview(ctx, reviewed, String(p.docId)), "review");
    else if (e.type === "meeting.created" && p.phase === "collecting") later(() => onMeetingStart(ctx, mst, String(p.meetingId)), "meeting summaries");
    else if (e.type === "meeting.phase" && p.phase === "collecting") later(() => onMeetingStart(ctx, mst, String(p.meetingId)), "meeting summaries");
    else if (e.type === "meeting.phase" && p.phase === "discussing") later(() => facilitate(ctx, mst, String(p.meetingId)), "facilitation");
    else if ((e.type === "agent.status" && (p.status === "stopped" || p.status === "banned")) || e.type === "agent.banned") {
      if (e.agentId) abortWork(ctx, e.agentId);
    }
  };
  const unsubscribe = world.events.subscribe(onEvent);

  function scheduleMeetings(t: number): void {
    const meetings = world.meetings.all();
    for (const b of world.buildings.all()) {
      const bid = b.kind === "town-hall" ? null : b.id;
      for (const c of b.meetings) {
        if (c.everyMinutes <= 0) continue;
        const mine = meetings.filter((m) => m.buildingId === bid && m.kind === c.kind);
        if (mine.some((m) => LIVE_PHASES.has(m.phase))) continue;
        const last = mine.reduce((acc, m) => Math.max(acc, Date.parse(m.createdAt)), startedAt);
        if (t - last >= c.everyMinutes * 60_000) world.ops.createMeeting(null, { kind: c.kind, buildingId: b.id, startNow: true });
      }
    }
    for (const m of world.meetings.where("phase = 'scheduled'")) {
      if (Date.parse(m.scheduledAt) <= t) void track(onMeetingStart(ctx, mst, m.id).catch(log("meeting start")));
    }
    for (const m of world.meetings.where("phase = 'collecting'")) {
      if (!mst.summarized.has(m.id)) void track(onMeetingStart(ctx, mst, m.id).catch(log("meeting summaries")));
    }
    advanceCollecting(ctx, mst);
    for (const m of world.meetings.where("phase = 'discussing'")) {
      if (!mst.facilitated.has(m.id)) void track(facilitate(ctx, mst, m.id).catch(log("facilitation")));
    }
  }

  function scheduleReviews(): void {
    const ids = world.buildings.where("reviewPolicy = 'moderator'").map((b) => b.id);
    for (const bid of ids) {
      for (const d of world.docs.where("type = 'report' AND decision = 'pending' AND buildingId = ?", [bid], "ORDER BY createdAt")) {
        if (!reviewed.has(d.id)) void track(maybeReview(ctx, reviewed, d.id).catch(log("review")));
      }
    }
  }

  function scheduleWork(): void {
    for (const a of world.agents.where("kind = 'resident' AND status = 'idle'", [], "ORDER BY createdAt")) {
      if (ctx.live.has(a.id) || starting.has(a.id)) continue;
      const next = world.assignments.first("agentId = ? AND status = 'pending'", [a.id], "ORDER BY createdAt, rowid");
      if (!next || !world.budget.canStart(a.id)) continue;
      void startWork(a.id, next.id).catch(log(`work session for ${a.name}`));
    }
  }

  async function tickOnce(): Promise<void> {
    if (stopped) return;
    const d = now();
    const t = d.getTime();
    if (localDate(d) !== lastDate) {
      lastDate = localDate(d);
      try { world.budget.resetDaily(); } catch (e) { log("daily reset")(e); }
    }
    if (opts.exportDir !== false && t - lastExport >= HOUR_MS) {
      lastExport = t;
      try {
        const r = opts.exportDir ? world.export(opts.exportDir) : world.export();
        world.events.append({ type: "export.done", text: r.changed ? `Exported the town (${r.commit?.slice(0, 7) ?? "no commit"})` : "Export: no changes", payload: { ...r } });
      } catch (e) { log("export")(e); }
    }
    try { scheduleMeetings(t); } catch (e) { log("meetings")(e); }
    try { scheduleReviews(); } catch (e) { log("reviews")(e); }
    try { scheduleWork(); } catch (e) { log("work")(e); }
  }

  const interval = opts.intervalMs ?? 5000;
  const timer = interval > 0 ? setInterval(() => void tickOnce(), interval) : null;
  timer?.unref?.();

  async function whenIdle(): Promise<void> {
    while (tasks.size) await Promise.allSettled([...tasks]);
  }

  return {
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      unsubscribe();
      for (const id of [...ctx.live.keys()]) abortWork(ctx, id);
      await whenIdle();
    },
    chat: (agentId, input) => chat(ctx, agentId, input),
    interrupt: async (agentId, text, from) => interrupt(ctx, agentId, text, from),
    onMeetingStart: (meetingId) => track(onMeetingStart(ctx, mst, meetingId)),
    runWorkSession: (agentId, assignmentId) => startWork(agentId, assignmentId),
    tickOnce,
    whenIdle,
    isWorking: (agentId) => ctx.live.has(agentId) || starting.has(agentId),
  };
}
