/**
 * @muster-town/runtime — resident work sessions (Claude Agent SDK over the town MCP endpoint),
 * managers' team-lead sessions over the in-tray, meeting summaries + facilitation, proxy chat, interrupts, scheduler,
 * startup reconcile, dismissal (onAgentRetired), host redeploy (v1.3).
 */
import { checkWaits, codeWorkspace, nextStartable, PRESENCE_TICK_MS, slugify, syncManagerRoles, type World } from "@muster-town/core";
import { DesksConfig, type ChatInput, type DeskActivityInput, type Event, type RedeployResult, type Session } from "@muster-town/schema";
import { askAbout, chat } from "./chat.ts";
import { DockerBackend, dockerSafe, HostBackend, type DeskBackend, type WorkBackend } from "./desk/backend.ts";
import { FlyApi } from "./desk/fly.ts";
import { SandboxBackend } from "./desk/sandbox.ts";
import { drainNudgeFacilitator, gitHead, isAncestor, makeRedeployer, type RedeployDeps, type RedeployRequest } from "./redeploy.ts";
import { gitAuthEnv, noRepoTokenReason, onDeskActivity, repoToken, runDeskSession, type DeskSessionOptions } from "./desk/session.ts";
import { closeQuietOneOnOnes, newManageState, wakeManager } from "./manage.ts";
import { advanceCollecting, facilitate, newMeetingState, onMeetingMention, onMeetingStart } from "./meetings.ts";
import { realSdk, type Sdk } from "./sdk.ts";
import type { Ctx } from "./session.ts";
import { abortWork, finishWorkSession, interrupt, runWorkSession, type WorkOutcome } from "./work.ts";

export { describeTool } from "./describe.ts";
export { prompts } from "@muster-town/core";
export { FlyApi } from "./desk/fly.ts";
export { SandboxBackend, type SandboxApi } from "./desk/sandbox.ts";
export { DockerBackend, HostBackend, realDockerRunner, type DeskBackend, type DeskChild, type DeskHandle, type DockerRunner, type RunResult, type SpawnedChild, type WorkBackend, type LineSink } from "./desk/backend.ts";
export { deskAuth, deskEnv, grantedSecrets, portOf, FALLBACK_KEY_ENV, type DeskAuthMode, type DeskSessionOptions } from "./desk/session.ts";
export { fundingFor, fundedBy, type Funding } from "./session.ts";
export { type WorkOutcome } from "./work.ts";
export { isTerminalRedeployEvent, makeRedeployer, realCommandRunner, RESTART_EXIT_CODE, STUCK_POLLS, type CmdResult, type CommandRunner, type RedeployDeps, type RedeployRequest, type Redeployer } from "./redeploy.ts";
export { InputChannel, oneShot, realSdk, usageOf, userMessage, type QueryHandle, type QueryParams, type Sdk } from "./sdk.ts";
export { DISALLOWED_TOOLS, TOWN_TOOLS, WEB_TOOLS } from "./session.ts";
export { COLLECTING_MS, MEETING_REPLIES_MAX, MEETING_REPLY_MAX_TURNS, MEETING_REPLY_VERBS, SUMMARY_MODEL } from "./meetings.ts";

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
  redeploy?: Pick<RedeployDeps, "run" | "exit" | "exitDelayMs" | "drainTimeoutMs" | "drainPollMs" | "againDelayMs" | "drainWrapUpMs">;
  /** the docker desk backend probed when `desks.backend` is auto/docker (tests inject a fake); default a DockerBackend */
  dockerProbe?: DeskBackend;
  /** minimum time between docker probes (re-probe while on the host fallback; liveness check while on docker). Default 30000. */
  dockerProbeMs?: number;
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
  const ctx: Ctx = { world, mcpUrl: opts.mcpUrl, repoRoot: opts.repoRoot ?? process.cwd(), desks, now, sdk: opts.sdk ?? realSdk, live: new Map(), facilitating: new Map(), deskAllocations: new Map(), deskFallbacks: new Map(), track };
  // a collective with a repo whose desks get no GitHub token: private clones and pushes fail at the first work session, so say so at boot
  if (world.town.get().workspace?.repoUrl && !opts.deskOptions?.ghToken && desks.backend !== "host" && !repoToken(world, desks.ghToken)) {
    console.warn(`[runtime] WARNING: the collective has a repo but no GitHub token for it (${noRepoTokenReason(desks.ghToken)}): desks can't clone or push a private repo and redeploy can't pull one. Set the GH_TOKEN secret at the Town Hall.`);
  }
  const killGraceMs = opts.killGraceMs ?? 10_000;
  const starting = new Set<string>();
  const mst = newMeetingState();
  const manage = newManageState();
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
  try { syncManagerRoles(world); } catch (e) { log("manager roles")(e); } // buildings whose manager was named before it granted the role
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
  const sandboxProvider = desks.backend === "fly" ? "Fly.io" : null;
  const sandboxBackend = (): DeskBackend => {
    const app = process.env.FLY_APP ?? "";
    const image = desks.snapshot.includes("/") ? desks.snapshot : `registry.fly.io/${app}:desk`;
    return new SandboxBackend({
      api: new FlyApi({ app, token: process.env.FLY_API_TOKEN ?? "", image, region: desks.region, cpuKind: desks.cpuKind, cpus: desks.cpus, memoryMb: desks.memoryMb }),
      collective: collectiveSlug, heartbeatMs: 0, // Machines have no idle auto-stop; each one also stops itself after its max lifetime
    });
  };
  const dockerProbe: DeskBackend | null = desks.backend === "host" ? null : opts.dockerProbe
    ?? (sandboxProvider ? sandboxBackend() : new DockerBackend({ collective: collectiveSlug, image: desks.image }));
  const probeEveryMs = opts.dockerProbeMs ?? 30_000;
  // Docker down → a town notice (once per outage, also across restarts: the last alert in the log says where we are)
  let dockerDown = (world.events.latestWith("system", "alert", ["docker-down", "docker-up"])?.payload as { alert?: string } | undefined)?.alert === "docker-down";
  function noteDocker(ok: boolean): void {
    world.host.docker = ok;
    if (!ok && !dockerDown) {
      dockerDown = true;
      world.events.append({ type: "system", text: sandboxProvider ? `${sandboxProvider} is unreachable: code desks can't start; workshop sessions are paused` : "Docker is not running: code desks can't start; workshop sessions are paused", payload: { alert: "docker-down" } });
    } else if (ok && dockerDown) {
      dockerDown = false;
      world.events.append({ type: "system", text: `${sandboxProvider ?? "Docker"} is back: code desks resume`, payload: { alert: "docker-up" } });
    }
  }
  const backendReady: Promise<WorkBackend> = backend ? Promise.resolve(backend) : chooseBackend().then((b) => (backend = b));
  // Desk containers survive a restart, and so does a `docker exec`'d session in one (e.g. cut off by a redeploy's drain
  // timeout): stop the orphans so they don't keep working beside the re-queued assignment's new session.
  // Until its orphan is gone the agent gets no new work session: both would run in the same checkout.
  const orphanKiller = opts.deskBackend ? (opts.deskBackend.kind === "docker" ? opts.deskBackend : null) : dockerProbe;
  const reaping = new Set<string>();
  for (const sid of reconciled.orphanedSessions) {
    const s = world.sessions.get(sid);
    if (s?.backend !== "docker" || !orphanKiller?.killOrphan) continue;
    const agentId = s.agentId;
    reaping.add(agentId);
    void track(orphanKiller.killOrphan(agentId, sid).catch(log("kill orphan")).finally(() => {
      reaping.delete(agentId);
      if (!stopped) scheduleWork();
    }));
  }
  let lastProbe = 0;
  /** `auto` must not stick on the host backend forever because docker was down at startup: re-probe before each work session. */
  async function currentBackend(): Promise<WorkBackend> {
    // `backend` may have fallen back to host since startup (docker stopped mid-run); backendReady still holds the first choice
    const b = backend ?? await backendReady;
    // only re-probe when the host backend was an automatic fallback (never when a backend was injected or configured)
    if (opts.deskBackend || b.kind !== "host" || !dockerProbe || desks.backend !== "auto" || Date.now() - lastProbe < probeEveryMs) return backend ?? b;
    lastProbe = Date.now();
    const ok = await dockerProbe.available();
    noteDocker(ok);
    if (ok) {
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
    lastProbe = Date.now();
    noteDocker(ok);
    if (sandboxProvider) {
      console.log(`[runtime] work sessions: ${sandboxProvider} sandbox desks (${desks.snapshot}; configured)${ok ? "" : ` — WARNING: ${sandboxProvider} is unreachable`}`);
      return docker;
    }
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

  const needsProbe = () => !opts.deskBackend && backend?.kind === "host" && !!dockerProbe && desks.backend === "auto" && Date.now() - lastProbe >= probeEveryMs;
  /** While on docker desks, check docker is still up (OrbStack stops): `auto` falls back to the host backend until it is back. */
  async function checkDocker(): Promise<void> {
    if (opts.deskBackend || !dockerProbe || backend?.kind !== "docker" || Date.now() - lastProbe < probeEveryMs) return;
    lastProbe = Date.now();
    const ok = await dockerProbe.available();
    noteDocker(ok);
    if (!ok && desks.backend === "auto") {
      console.warn("[runtime] WARNING: docker stopped; work sessions run in-process (host backend) until it is back. Workspace buildings won't be scheduled.");
      backend = new HostBackend();
    }
  }
  // keep the common path a single promise hop (tests and the scheduler observe `starting` right after a tick)
  const startWork = (agentId: string, assignmentId: string) => track((backend && !needsProbe() ? Promise.resolve(backend) : currentBackend()).then((b) =>
    b.kind === "host" ? runWorkSession(ctx, starting, agentId, assignmentId) : runDeskSession(ctx, b, starting, agentId, assignmentId, opts.deskOptions)));

  const onEvent = (e: Event) => {
    const p = e.payload as Record<string, unknown>;
    if (e.type === "meeting.created" && p.phase === "collecting") later(() => onMeetingStart(ctx, mst, String(p.meetingId)), "meeting summaries");
    else if (e.type === "meeting.phase" && p.phase === "collecting") later(() => onMeetingStart(ctx, mst, String(p.meetingId)), "meeting summaries");
    else if (e.type === "meeting.phase" && p.phase === "discussing") later(() => facilitate(ctx, mst, String(p.meetingId)), "facilitation");
    else if (e.type === "agent.mentioned" && p.meetingId) later(() => onMeetingMention(ctx, mst, String(p.meetingId), String(p.toId), String(p.byId), String(p.byKind)), "meeting reply");
    // the manager's 1:1 opened, the human spoke, or it ended: start, feed or wrap up the manager's session
    else if ((e.type === "meeting.created" || e.type === "meeting.utterance" || e.type === "meeting.phase") && e.buildingId && world.meetings.get(String(p.meetingId))?.kind === "one-on-one") {
      const bid = e.buildingId; later(async () => wakeManagers(bid), "manager 1:1");
    }
    // a resident's report landed in a managed building's in-tray: wake (or feed) the manager's team-lead session
    else if (e.type === "doc.created" && p.docType === "report" && e.buildingId) { const bid = e.buildingId; later(async () => wakeManagers(bid), "manager session"); }
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
    // 1:1s have no facilitation session: the manager's manage session answers them (manage.ts)
    for (const m of world.meetings.where("phase = 'discussing' AND kind != 'one-on-one'")) {
      if (!mst.facilitated.has(m.id)) void track(facilitate(ctx, mst, m.id).catch(log("facilitation")));
    }
  }

  /** work sessions live or starting, out of the host's cap (`desks.maxRunning` in the world: collective.json at seed, PUT /api/town/desks live) */
  const slots = () => ({ running: new Set([...ctx.live.keys(), ...starting]).size, max: world.desksConfig().maxRunning });
  world.host.slots = slots;
  let slotsFull = false;
  function scheduleWork(): void {
    if (draining) return;
    const held: string[] = [];
    // sessions this pass started (startWork registers them as `starting` only after its first await)
    let startedNow = 0;
    for (const a of world.agents.where("kind = 'resident' AND status = 'idle'", [], "ORDER BY createdAt")) {
      if (ctx.live.has(a.id) || starting.has(a.id) || reaping.has(a.id)) continue;
      // queue order (position, createdAt, rowid), skipping what Budget.canStart holds (lane gate: they stay pending with a heldReason)
      const next = nextStartable(world, a.id);
      if (!next) continue;
      // the host's cap: a running session costs real memory, so queued work waits for a free slot instead of starting
      const s = slots();
      if (s.running + startedNow >= s.max) { held.push(a.id); continue; }
      const bid = a.homeBuildingId ?? a.buildingId;
      const b = bid ? world.buildings.get(bid) : undefined;
      if (backend?.kind === "host" && b && codeWorkspace(world.town.get(), b)) {
        // docker may have come back since startup: re-probe before giving up on a code building
        if (needsProbe()) {
          void currentBackend().then((nb) => { if (nb.kind !== "host") scheduleWork(); }).catch(log("docker re-probe"));
        }
        if (!warnedHost.has(b.id)) console.warn(`[runtime] WARNING: ${b.name} has code access; its work sessions need docker desks. Not scheduling them on the host backend until docker is back.`);
        warnedHost.add(b.id);
        continue;
      }
      startedNow++;
      void startWork(a.id, next.id).catch(log(`work session for ${a.name}`));
    }
    // one notice when the slots fill, one when they free up (not every pass)
    if (held.length && !slotsFull) {
      slotsFull = true;
      const s = slots();
      const names = held.map((id) => world.agents.get(id)?.name ?? id).join(", ");
      world.events.append({ type: "system", text: `All ${s.max} session slots are in use: holding queued work for ${names}`, payload: { alert: "slots-full", running: s.running, max: s.max, held } });
    } else if (!held.length && slotsFull) {
      slotsFull = false;
      world.events.append({ type: "system", text: "Session slots free again: queued work resumes", payload: { alert: "slots-free", ...slots() } });
    }
  }

  /** Managers of `only` (or of every building): offer them their new in-tray reports (runtime/src/manage.ts). */
  function wakeManagers(only?: string): void {
    if (stopped) return;
    const gate = { draining: () => draining, starting: (id: string) => starting.has(id), slotFree: () => { const s = slots(); return s.running < s.max; } };
    for (const b of only ? [world.buildings.get(only)].filter((x) => !!x) : world.buildings.all()) {
      const p = wakeManager(ctx, manage, gate, b.id);
      if (p) void track(p).catch(log(`manager session in ${b.name}`));
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
    try { world.budget.resumeEligible(); } catch (e) { log("budget resume")(e); }
    try { scheduleMeetings(t); } catch (e) { log("meetings")(e); }
    try { checkWaits(world, d); } catch (e) { log("waits")(e); }
    try { closeQuietOneOnOnes(ctx); } catch (e) { log("quiet 1:1s")(e); }
    await backendReady;
    if (stopped) return;
    // docker liveness while on desks; the host fallback re-probes in scheduleWork/startWork
    if (backend?.kind === "docker") await track(checkDocker()).catch(log("docker probe"));
    else if (needsProbe()) await track(currentBackend()).catch(log("docker re-probe"));
    if (stopped) return;
    // startup and managers whose work session just ended: in-trays with reports no manage session has seen yet.
    // Before scheduleWork, so a manager's in-tray goes ahead of its own queued work (it registers as live right away).
    try { wakeManagers(); } catch (e) { log("manager sessions")(e); }
    try { scheduleWork(); } catch (e) { log("work")(e); }
  }

  const interval = opts.intervalMs ?? 5000;
  const timer = interval > 0 ? setInterval(() => void tickOnce(), interval) : null;
  timer?.unref?.();

  async function whenIdle(): Promise<void> {
    while (tasks.size) await Promise.allSettled([...tasks]);
  }

  /**
   * The live map against the source of truth: an entry whose Session row is no longer running, or a desk session with
   * no child process, is stale (its desk died, a previous end was missed). Forget it; end a still-running row as orphaned.
   */
  function pruneLive(): void {
    for (const [agentId, l] of [...ctx.live]) {
      const s = world.sessions.get(l.sessionId);
      if (s?.status === "running" && (l.kind !== "desk" || l.child)) continue;
      dropLive(agentId, "orphaned: stale live session");
    }
  }
  /** Forget the agent's live session (killing its child, if any) and end its running work/manage Session row as orphaned. */
  function dropLive(agentId: string, error: string): void {
    const l = ctx.live.get(agentId);
    if (l) { abortWork(ctx, agentId, 0); ctx.live.delete(agentId); }
    starting.delete(agentId);
    for (const s of world.sessions.where("agentId = ? AND status = 'running' AND purpose IN ('work', 'manage')", [agentId])) {
      try { world.ops.endSession(s.id, { status: "error", error }); } catch (e) { log("end orphaned session")(e); }
    }
  }
  const redeployer = makeRedeployer({
    world, repoRoot: ctx.repoRoot, collective: dockerSafe(collectiveSlug), image: desks.image,
    // sandbox-desk hosts (Fly) have no docker: the desk image is built and pushed from outside the town
    imageBuild: !sandboxProvider,
    gitEnv: () => gitAuthEnv(world, desks.ghToken),
    isWorking: (agentId) => ctx.live.has(agentId) || starting.has(agentId),
    // facilitations count too: a restart mid-meeting would orphan the facilitator (docs/meetings.md §3.5)
    working: () => { pruneLive(); return [...new Set([...ctx.live.keys(), ...starting, ...ctx.facilitating.keys()])]; },
    drop: (agentId) => dropLive(agentId, "orphaned: redeploy drain found it stuck"),
    // host sessions take it on their input; desk sessions through the interrupt queue (next control poll);
    // a facilitator is told to close the meeting (and only that: no work interrupt is queued for an agent that is only facilitating)
    nudge: (agentId, text) => {
      const fac = ctx.facilitating.get(agentId);
      if (fac && !fac.stopped) fac.input.push(drainNudgeFacilitator());
      if (fac && !ctx.live.has(agentId) && !starting.has(agentId)) return;
      if (!interrupt(ctx, agentId, text, "Redeploy")) world.ops.enqueueInterrupt(agentId, text, "Redeploy");
    },
    hold: (on) => { draining = on; },
    blocked: () => world.agents.where("kind = 'resident' AND status = 'idle'", [], "ORDER BY createdAt")
      .filter((a) => !ctx.live.has(a.id) && !starting.has(a.id) && !!nextStartable(world, a.id)).map((a) => a.id),
    ...opts.redeploy,
  });
  const redeploy = (o: RedeployRequest) => redeployer.redeploy(o);
  world.host.redeploy = redeploy;
  const hostRedeployStatus = () => redeployer.status();
  world.host.redeployStatus = hostRedeployStatus;
  const hostIsWorking = (agentId: string) => ctx.live.has(agentId) || starting.has(agentId);
  const hostInterrupt = (agentId: string, text: string, from?: string, now?: boolean) => interrupt(ctx, agentId, text, from, now);
  world.host.isWorking = hostIsWorking;
  world.host.interrupt = hostInterrupt;
  const commit = gitHead(ctx.repoRoot);
  if (commit) world.host.commit = commit;
  // `{deploy}` waits: "next" holds once this server started after the assignment was made; a sha once the live commit contains it
  const bootIso = now().toISOString();
  world.host.startedAt = bootIso;
  const liveCache = new Map<string, boolean>();
  const hostIsLive = (sha: string) => {
    if (!commit) return false;
    let v = liveCache.get(sha);
    if (v === undefined) { v = isAncestor(ctx.repoRoot, sha, commit); liveCache.set(sha, v); }
    return v;
  };
  world.host.isLive = hostIsLive;

  return {
    async stop() {
      stopped = true;
      if (world.host.redeploy === redeploy) delete world.host.redeploy;
      if (world.host.redeployStatus === hostRedeployStatus) delete world.host.redeployStatus;
      delete world.host.docker;
      if (world.host.isWorking === hostIsWorking) delete world.host.isWorking;
      if (world.host.interrupt === hostInterrupt) delete world.host.interrupt;
      if (commit && world.host.commit === commit) delete world.host.commit;
      if (world.host.startedAt === bootIso) delete world.host.startedAt;
      if (world.host.isLive === hostIsLive) delete world.host.isLive;
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
