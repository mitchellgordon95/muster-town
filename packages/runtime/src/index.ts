/**
 * @muster-town/runtime — resident work sessions (Claude Agent SDK over the town MCP endpoint),
 * reviewer sessions over the in-tray, meeting summaries + facilitation, proxy chat, interrupts, scheduler,
 * startup reconcile, dismissal (onAgentRetired), host redeploy (v1.3).
 */
import { nextPending, PRESENCE_TICK_MS, slugify, type World } from "@muster-town/core";
import { DesksConfig, type ChatInput, type DeskActivityInput, type Event, type RedeployResult, type Session } from "@muster-town/schema";
import { askAbout, chat } from "./chat.ts";
import { DockerBackend, dockerSafe, HostBackend, type WorkBackend } from "./desk/backend.ts";
import { makeRedeployer, type RedeployDeps, type RedeployRequest } from "./redeploy.ts";
import { onDeskActivity, runDeskSession, type DeskSessionOptions } from "./desk/session.ts";
import { advanceCollecting, facilitate, newMeetingState, onMeetingMention, onMeetingStart } from "./meetings.ts";
import { realSdk, type Sdk } from "./sdk.ts";
import type { Ctx } from "./session.ts";
import { abortWork, finishWorkSession, interrupt, maybeReview, runWorkSession, type WorkOutcome } from "./work.ts";

export { describeTool } from "./describe.ts";
export { prompts } from "@muster-town/core";
export { DockerBackend, HostBackend, realDockerRunner, type DeskBackend, type DeskChild, type DeskHandle, type DockerRunner, type RunResult, type SpawnedChild, type WorkBackend, type LineSink } from "./desk/backend.ts";
export { deskAuth, deskEnv, portOf, type DeskAuthMode, type DeskSessionOptions } from "./desk/session.ts";
export { type WorkOutcome } from "./work.ts";
export { makeRedeployer, realCommandRunner, RESTART_EXIT_CODE, type CmdResult, type CommandRunner, type RedeployDeps, type RedeployRequest, type Redeployer } from "./redeploy.ts";
export { InputChannel, oneShot, realSdk, usageOf, userMessage, type QueryHandle, type QueryParams, type Sdk } from "./sdk.ts";
export { DISALLOWED_TOOLS, TOWN_TOOLS, WEB_TOOLS } from "./session.ts";
export { COLLECTING_MS, MEETING_REPLIES_MAX } from "./meetings.ts";

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
  /** Muster Town repo root; building workspaces resolve relative paths from here */
  repoRoot?: string;
  /** hourly git export target; false disables. Default: world.export() default dir. */
  exportDir?: string | false;
  /** where work sessions run; default from `desks.backend` (auto → docker if `docker info` succeeds, else host) */
  deskBackend?: WorkBackend;
  /** overrides collective.json `desks` (as stored in the world at seed) */
  desks?: Partial<DesksConfig>;
  /** collective slug for desk container names (default: slug of the town name) */
  collective?: string;
  /** desk session knobs (tests inject the GH token source) */
  deskOptions?: DeskSessionOptions;
  /** a stopped/banned agent's desk process gets this long to exit on its own before it is killed. Default 10000. */
  killGraceMs?: number;
  /** redeploy knobs (tests inject the command runner and `exit`; never the real process.exit) */
  redeploy?: Pick<RedeployDeps, "run" | "exit" | "exitDelayMs" | "drainTimeoutMs" | "drainPollMs">;
}

export interface Runtime {
  stop(): Promise<void>;
  chat(agentId: string, input: (typeof ChatInput)["_input"]): Promise<{ reply: string }>;
  /** In-tray "Ask about this": a cheap-model answer about a report, without its author. */
  askAbout(docId: string, question: string, userId: string, history?: { role: "user" | "assistant"; text: string }[]): Promise<{ reply: string }>;
  /** Deliver `text` as the next user message of the agent's running work session. False if none. */
  interrupt(agentId: string, text: string, from?: string, now?: boolean): Promise<boolean>;
  /** Meeting entered collecting (or scheduled → collecting): run attendees' summaries. */
  onMeetingStart(meetingId: string): Promise<void>;
  /** Run one work session now; resolves with the ended session. */
  runWorkSession(agentId: string, assignmentId: string): Promise<Session>;
  /** One scheduler pass. Starts sessions in the background (see whenIdle). */
  tickOnce(): Promise<void>;
  /**
   * v1.4 presence pass (tickOnce runs it every 30 s): visitors with no call for 90 s go `offline`; offers to visitors
   * older than 24 h are cancelled with a note in the in-tray. Returns the agents marked offline and the offers expired.
   */
  presenceTick(): { offline: string[]; expiredOffers: string[] };
  /** Resolves when every background session/task has finished. */
  whenIdle(): Promise<void>;
  /** Whether the agent has a live work session. */
  isWorking(agentId: string): boolean;
  /** A desk reported a tool call / thought / status (POST /api/agents/me/activity). */
  onDeskActivity(agentId: string, input: DeskActivityInput): void;
  /** End a work session (desk session-end, or a desk that died): fallback report, status, charge. Idempotent. */
  finishWorkSession(sessionId: string, outcome: WorkOutcome): Promise<Session>;
  /** The backend work sessions use (resolves once `auto` has probed docker). */
  backend(): Promise<"host" | "docker">;
  /**
   * An agent was dismissed (core `ops.dismissAgent` already ran): abort its live session and `docker rm -f` its
   * desk container. The home volume is kept unless `purge`.
   */
  onAgentRetired(agentId: string, opts?: { purge?: boolean }): Promise<void>;
  /** Pull main, reinstall, rebuild, restart (exit 75) in the background. Single-flight: `{ running: true }` while one runs. */
  redeploy(o: RedeployRequest): RedeployResult;
  /** What the startup reconcile did (orphaned sessions ended, active assignments re-queued). */
  readonly reconciled: { orphanedSessions: string[]; requeuedAssignments: string[] };
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
  const desks = DesksConfig.parse({ ...world.desksConfig(), ...opts.desks });
  const ctx: Ctx = { world, mcpUrl: opts.mcpUrl, repoRoot: opts.repoRoot ?? process.cwd(), desks, now, sdk: opts.sdk ?? realSdk, live: new Map(), deskAllocations: new Map(), track };
  const killGraceMs = opts.killGraceMs ?? 10_000;
  const starting = new Set<string>();
  const reviewed = new Set<string>();
  const mst = newMeetingState();
  const startedAt = now().getTime();
  let lastDate = localDate(now());
  let lastExport = startedAt;
  let lastPresence = 0;
  let stopped = false;
  /** a redeploy is draining: no new work sessions */
  let draining = false;
  const log = (what: string) => (e: unknown) => console.log(`[runtime] ${what}:`, e instanceof Error ? e.message : e);

  // A fresh runtime has no live children: running Session rows are orphans from a previous process, and their
  // active assignments go back to pending so the scheduler picks them up again.
  let reconciled: Runtime["reconciled"] = { orphanedSessions: [], requeuedAssignments: [] };
  try {
    reconciled = world.ops.reconcile(ctx.live.keys());
    if (reconciled.orphanedSessions.length || reconciled.requeuedAssignments.length) {
      console.log(`[runtime] reconcile: ended ${reconciled.orphanedSessions.length} orphaned session(s), ${reconciled.requeuedAssignments.length} assignment(s) back to pending`);
    }
  } catch (e) { log("reconcile")(e); }

  /** Run `fn` after the current (possibly transactional) event dispatch, tracked. */
  const later = (fn: () => Promise<unknown>, what: string) => {
    if (stopped) return;
    void track(new Promise<void>((r) => setImmediate(r)).then(fn).catch(log(what)));
  };

  let backend: WorkBackend | null = opts.deskBackend ?? null;
  const collectiveSlug = opts.collective ?? slugify(world.town.get().name);
  const dockerProbe = desks.backend === "host" ? null : new DockerBackend({ collective: collectiveSlug, image: desks.image });
  const backendReady: Promise<WorkBackend> = backend ? Promise.resolve(backend) : chooseBackend().then((b) => (backend = b));
  // Desk containers survive a restart, and so does a `docker exec`'d session in one (e.g. cut off by a redeploy's drain
  // timeout): stop the orphans so they don't keep working beside the re-queued assignment's new session.
  const orphanKiller = opts.deskBackend ? (opts.deskBackend.kind === "docker" ? opts.deskBackend : null) : dockerProbe;
  for (const sid of reconciled.orphanedSessions) {
    const s = world.sessions.get(sid);
    if (s?.backend === "docker" && orphanKiller?.killOrphan) void track(orphanKiller.killOrphan(s.agentId, sid).catch(log("kill orphan")));
  }
  let lastProbe = 0;
  /** `auto` must not stick on the host backend forever because docker was down at startup: re-probe before each work session. */
  async function currentBackend(): Promise<WorkBackend> {
    const b = await backendReady;
    // only re-probe when the host backend was an automatic fallback (never when a backend was injected or configured)
    if (opts.deskBackend || b.kind !== "host" || !dockerProbe || desks.backend !== "auto" || Date.now() - lastProbe < 30_000) return backend ?? b;
    lastProbe = Date.now();
    if (await dockerProbe.available()) {
      console.log(`[runtime] docker is available again: work sessions switch to docker desks (${desks.image})`);
      backend = dockerProbe;
    }
    return backend ?? b;
  }
  async function chooseBackend(): Promise<WorkBackend> {
    if (desks.backend === "host" || !dockerProbe) {
      console.log("[runtime] work sessions: host backend (in-process, no code tools; configured)");
      return new HostBackend();
    }
    const docker = dockerProbe;
    const ok = await docker.available();
    if (desks.backend === "docker") {
      console.log(`[runtime] work sessions: docker desks (${desks.image}; configured)${ok ? "" : " — WARNING: docker info failed"}`);
      return docker;
    }
    if (ok) {
      console.log(`[runtime] work sessions: docker desks (${desks.image}; auto)`);
      return docker;
    }
    console.warn("[runtime] WARNING: docker not available; work sessions run in-process (host backend, no code tools). Workspace buildings won't be scheduled.");
    return new HostBackend();
  }
  const warnedHost = new Set<string>();

  const needsProbe = () => !opts.deskBackend && backend?.kind === "host" && !!dockerProbe && desks.backend === "auto" && Date.now() - lastProbe >= 30_000;
  // keep the common path a single promise hop (tests and the scheduler observe `starting` right after a tick)
  const startWork = (agentId: string, assignmentId: string) => track((backend && !needsProbe() ? Promise.resolve(backend) : currentBackend()).then((b) =>
    b.kind === "host" ? runWorkSession(ctx, starting, agentId, assignmentId) : runDeskSession(ctx, b, starting, agentId, assignmentId, opts.deskOptions)));

  const onEvent = (e: Event) => {
    const p = e.payload as Record<string, unknown>;
    if (e.type === "doc.created" && p.docType === "report") later(() => maybeReview(ctx, reviewed, String(p.docId)), "review");
    else if (e.type === "meeting.created" && p.phase === "collecting") later(() => onMeetingStart(ctx, mst, String(p.meetingId)), "meeting summaries");
    else if (e.type === "meeting.phase" && p.phase === "collecting") later(() => onMeetingStart(ctx, mst, String(p.meetingId)), "meeting summaries");
    else if (e.type === "meeting.phase" && p.phase === "discussing") later(() => facilitate(ctx, mst, String(p.meetingId)), "facilitation");
    else if (e.type === "agent.mentioned" && p.meetingId) later(() => onMeetingMention(ctx, mst, String(p.meetingId), String(p.toId), String(p.byId), String(p.byKind)), "meeting reply");
    else if ((e.type === "agent.status" && (p.status === "stopped" || p.status === "banned")) || e.type === "agent.banned") {
      if (e.agentId) abortWork(ctx, e.agentId, killGraceMs);
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
    const ids = world.buildings.where("reviewPolicy = 'reviewer'").map((b) => b.id);
    for (const bid of ids) {
      for (const d of world.docs.where("type = 'report' AND decision = 'pending' AND buildingId = ?", [bid], "ORDER BY createdAt")) {
        if (!reviewed.has(d.id)) void track(maybeReview(ctx, reviewed, d.id).catch(log("review")));
      }
    }
  }

  function scheduleWork(): void {
    if (draining) return;
    for (const a of world.agents.where("kind = 'resident' AND status = 'idle'", [], "ORDER BY createdAt")) {
      if (ctx.live.has(a.id) || starting.has(a.id)) continue;
      const next = nextPending(world, a.id); // queue order: position, createdAt, rowid
      if (!next || !world.budget.canStart(a.id)) continue;
      const bid = a.homeBuildingId ?? a.buildingId;
      const b = bid ? world.buildings.get(bid) : undefined;
      if (backend?.kind === "host" && b?.workspace) {
        if (!warnedHost.has(b.id)) console.warn(`[runtime] WARNING: ${b.name} has a code workspace; its work sessions need docker desks. Not scheduling them on the host backend.`);
        warnedHost.add(b.id);
        continue;
      }
      void startWork(a.id, next.id).catch(log(`work session for ${a.name}`));
    }
  }

  function presenceTick(): { offline: string[]; expiredOffers: string[] } {
    const at = now();
    let offline: string[] = [], expiredOffers: string[] = [];
    try { offline = world.presence.sweep(at); } catch (e) { log("presence")(e); }
    try { expiredOffers = world.presence.expireOffers(at).map((a) => a.id); } catch (e) { log("offer expiry")(e); }
    return { offline, expiredOffers };
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
    try { world.bank.creditDue(d); } catch (e) { log("bank")(e); }
    if (t - lastPresence >= PRESENCE_TICK_MS) { lastPresence = t; presenceTick(); }
    try { scheduleMeetings(t); } catch (e) { log("meetings")(e); }
    try { scheduleReviews(); } catch (e) { log("reviews")(e); }
    await backendReady;
    if (stopped) return;
    try { scheduleWork(); } catch (e) { log("work")(e); }
  }

  const interval = opts.intervalMs ?? 5000;
  const timer = interval > 0 ? setInterval(() => void tickOnce(), interval) : null;
  timer?.unref?.();

  async function whenIdle(): Promise<void> {
    while (tasks.size) await Promise.allSettled([...tasks]);
  }

  const redeployer = makeRedeployer({
    world, repoRoot: ctx.repoRoot, collective: dockerSafe(collectiveSlug), image: desks.image,
    isWorking: (agentId) => ctx.live.has(agentId) || starting.has(agentId),
    working: () => [...new Set([...ctx.live.keys(), ...starting])],
    hold: (on) => { draining = on; },
    blocked: () => world.agents.where("kind = 'resident' AND status = 'idle'", [], "ORDER BY createdAt")
      .filter((a) => !ctx.live.has(a.id) && !starting.has(a.id) && !!nextPending(world, a.id) && world.budget.canStart(a.id)).map((a) => a.id),
    ...opts.redeploy,
  });
  const redeploy = (o: RedeployRequest) => redeployer.redeploy(o);
  world.host.redeploy = redeploy;
  const hostIsWorking = (agentId: string) => ctx.live.has(agentId) || starting.has(agentId);
  const hostInterrupt = (agentId: string, text: string, from?: string, now?: boolean) => interrupt(ctx, agentId, text, from, now);
  world.host.isWorking = hostIsWorking;
  world.host.interrupt = hostInterrupt;

  return {
    async stop() {
      stopped = true;
      if (world.host.redeploy === redeploy) delete world.host.redeploy;
      if (world.host.isWorking === hostIsWorking) delete world.host.isWorking;
      if (world.host.interrupt === hostInterrupt) delete world.host.interrupt;
      if (timer) clearInterval(timer);
      unsubscribe();
      for (const id of [...ctx.live.keys()]) abortWork(ctx, id);
      await whenIdle();
    },
    chat: (agentId, input) => chat(ctx, agentId, input),
    askAbout: (docId, question, userId, history) => askAbout(ctx, docId, question, userId, history),
    interrupt: async (agentId, text, from, now) => interrupt(ctx, agentId, text, from, now),
    onMeetingStart: (meetingId) => track(onMeetingStart(ctx, mst, meetingId)),
    runWorkSession: (agentId, assignmentId) => startWork(agentId, assignmentId),
    tickOnce,
    presenceTick,
    whenIdle,
    isWorking: (agentId) => ctx.live.has(agentId) || starting.has(agentId),
    onDeskActivity: (agentId, input) => onDeskActivity(ctx, agentId, input),
    finishWorkSession: (sessionId, outcome) => finishWorkSession(ctx, sessionId, outcome),
    backend: () => backendReady.then((b) => b.kind),
    async onAgentRetired(agentId, o = {}) {
      abortWork(ctx, agentId, 0);
      const b = await backendReady;
      if (b.kind === "docker" && b.remove) {
        try { await b.remove(agentId, { purge: !!o.purge }); } catch (e) { log(`remove desk of ${agentId}`)(e); }
      }
    },
    redeploy,
    get reconciled() { return reconciled; },
  };
}
