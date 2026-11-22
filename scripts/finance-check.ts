// Live finance check: fetches the five public finance endpoints of a running town and re-checks every identity, within
// each endpoint and across them, from the returned numbers. Read-only. Exits 1 when any check fails.
// Run from the repo root: `npm run check:finance` (https://muster.town) or `npm run check:finance -- http://localhost:3000`.
// The five reads are not one snapshot: a debit landing between them shifts used/left, so a round whose cross-endpoint
// checks fail is fetched again (up to 3 rounds) before it counts as a failure.

type Json = Record<string, any>;
interface Check { name: string; ok: boolean; line: string }

const base = (process.argv[2] ?? "https://muster.town").replace(/\/+$/, "");
const fmt = (n: number) => (Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : String(n));
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function eq(name: string, leftExpr: string, left: number, rightExpr: string, right: number): Check {
  const diff = left - right;
  return { name, ok: diff === 0, line: `${leftExpr} ${fmt(left)} = ${rightExpr} ${fmt(right)} (diff ${fmt(diff)})` };
}
function flag(name: string, ok: unknown, detail: string): Check {
  return { name, ok: ok === true, line: detail };
}

function near(name: string, leftExpr: string, left: number, rightExpr: string, right: number, tol = 1e-6): Check {
  const diff = left - right;
  return { name, ok: Math.abs(diff) <= tol, line: `${leftExpr} $${left.toFixed(4)} = ${rightExpr} $${right.toFixed(4)} (diff ${diff.toFixed(6)})` };
}

/** Every check, from the five bodies alone. */
function checks(f: Json, s: Json, src: Json, bank: Json, fly: Json): Check[] {
  const ob = f.overdrawnBreakdown ?? {};
  return [
    flag("finance sumCheck", f.sumCheck?.ok, `ok ${f.sumCheck?.ok}, diff ${fmt(f.sumCheck?.diff)} (${f.sumCheck?.identity})`),
    flag("spend check", s.check?.ok, `ok ${s.check?.ok}, diff ${fmt(s.check?.diff)} (${s.check?.identity})`),
    flag("sources sumCheck", src.sumCheck?.ok, `ok ${src.sumCheck?.ok}, diff ${fmt(src.sumCheck?.diff)} (${src.sumCheck?.identity})`),
    eq("finance identity", "used + expired + left", f.used + f.expired + f.left, "total + overdrawn", f.total + f.overdrawn),
    eq("overdrawn parts", "Σ overdrawnBreakdown",
      sum([ob.durableOvershoot, ob.subscriptionOverdrawn, ob.deletedCreditDebits, ob.allocationOverspent].map(Number)), "overdrawn", f.overdrawn),
    eq("sources total", "sources.totalReceived", src.totalReceived, "finance.total", f.total),
    flag("sources matchesFinance", src.matchesFinance, `matchesFinance ${src.matchesFinance} (financeTotal ${fmt(src.financeTotal)})`),
    eq("sources expired", "sources.expiredTokens", src.expiredTokens, "finance.expired", f.expired),
    eq("spend used", "spend.used", s.used, "finance.used", f.used),
    // one balance (pools were deleted, migration 067): the Bank's balance is what finance says is left in it
    eq("bank balance", "bank.balanceTokens", bank.balanceTokens, "finance.leftBank", f.leftBank),
    // the runway nets one inflow rule (gr_rdzg83m0al): the Bank's expected inflow is the projection's
    eq("daily inflow", "finance.projection.dailyInflow", f.projection?.dailyInflow, "bank.dailyInflowTokens", bank.dailyInflowTokens),
    eq("net per day", "finance.projection.netDailyBurn", f.projection?.netDailyBurn, "trailingDailyBurn − dailyInflow", f.projection?.trailingDailyBurn - f.projection?.dailyInflow),
    // Fly hosting (USD): the days' and the buildings' desk time agree, each day's desks + town = its total
    flag("fly sumCheck", fly.sumCheck?.ok, `ok ${fly.sumCheck?.ok}, diff ${fly.sumCheck?.diff} (${fly.sumCheck?.identity})`),
    eq("fly desk time", "Σ fly.days[].deskMs", sum((fly.days ?? []).map((d: Json) => d.deskMs)), "Σ fly.buildings[].deskMs", sum((fly.buildings ?? []).map((b: Json) => b.deskMs))),
    near("fly totals", "Σ fly.days[] (desk + town)", sum((fly.days ?? []).map((d: Json) => d.deskUsd + d.townUsd)), "fly.totals.totalUsd", Number(fly.totals?.totalUsd), 1e-4),
    // dollars at API list price (gr_gmzli3f96j): one used figure on both endpoints, and the spend rows' dollars close
    near("usd used", "finance.usd.used", Number(f.usd?.used), "spend.usd.used", Number(s.usd?.used), 0.01),
    flag("usd sumCheck", s.usdSumCheck?.ok, `ok ${s.usdSumCheck?.ok}, diff ${s.usdSumCheck?.diff} (${s.usdSumCheck?.identity})`),
    // the sessions' list-price cost, from the building rows (each session at its booking model's price): within a cent per row of spend.usd.sessionsTotal
    near("usd sessions", "Σ spend building rows' usd", sum((s.rows ?? []).filter((r: Json) => r.kind === "building").map((r: Json) => Number(r.usd))), "spend.usd.sessionsTotal", Number(s.usd?.sessionsTotal), 0.005 * Math.max(2, (s.rows ?? []).length)),
    // the adjusted-token mix (1:1 mt_rbc3exb393): its parts add up, it prices back to its adj. tokens, one record, updated daily
    ...mixChecks(f.mix, bank.mix),
    // what each grant bought (gr_dt1l35tydx): the grants block by outcome closes on the grant rows
    ...grantChecks(s),
    // what the non-grant half bought (gr_utygatbi85): the lane rows close on each building's "Not under a grant" row
    ...noGrantChecks(s),
    // what each human request cost (gr_k71b7b6px7): the requests + untraced close on the directed lane
    ...directedSourceChecks(s),
    // what every step bought (gr_3na7vdmd52): each step-priced grant's step + off-step rows close on the grant row
    ...stepChecks(s),
    // paid in cash, last 30 days (gr_qggxximtru step 2): the parts add up, the ratio is list value / cash
    ...cashChecks(f.cash, f.cashCheck),
    // the Balance tab's "Day by day" chart (gr_epbcgb0hvs): the days and their buildings close on the Bank's used
    ...dailyChecks(f),
    // work versus coordination (gr_3ougmyubdm): the split's parts close on its total and on the daily rows' lanes
    ...splitChecks(f),
    // how much incoming credit was used (gr_z13gmx54su): expired per day, and the 7 d / 30 d used share per credit
    ...expiredChecks(f, src),
    ...utilizationChecks(f, src),
    // what managing each job cost (gr_064fmkq31s): the manage sessions' shares close on the manager wakes' total
    ...managingChecks(s),
  ];
}

/**
 * GET /api/finance/spend `managerShares` (kr_xvnxm4kqwy): job shares + upkeep + 1:1s = managerWakes.manageTokens, within
 * a token per session (both read the same window's manage sessions), and each part's lines sum to its total.
 */
function managingChecks(s: Json): Check[] {
  const m = s.managerShares, w = s.managerWakes;
  if (!m) return [flag("managing shares add up", false, "GET /api/finance/spend has no `managerShares` (server older than gr_064fmkq31s step 1)")];
  const jobs = sum(Object.values(m.jobs ?? {}).map((j: any) => Number(j.tokens)));
  const upkeep = sum(Object.values(m.upkeep ?? {}).map((u: any) => Number(u.tokens)));
  const parts = jobs + upkeep + Number(m.oneOnOnes?.tokens);
  const diff = parts - Number(w?.manageTokens);
  const tol = Math.max(1, Number(m.sessions));
  return [
    flag("managing shares add up", m.check?.ok === true && Math.abs(diff) <= tol,
      `job shares ${fmt(jobs)} + upkeep ${fmt(upkeep)} + 1:1s ${fmt(m.oneOnOnes?.tokens)} = managerWakes.manageTokens ${fmt(w?.manageTokens)} (diff ${fmt(diff)}, ±${fmt(tol)} over ${fmt(m.sessions)} sessions; ${(Number(m.tiedShare) * 100).toFixed(1)}% tied to a job)`),
  ];
}

/** Every subscription credit in /api/finance/sources, flattened. */
const sourceCredits = (src: Json): Json[] => (src.inputs ?? []).flatMap((i: Json) => i.credits ?? []).filter((c: Json) => c.expiresAt);

/**
 * GET /api/finance daily rows' `expired` (kr_no6seja7f6): Σ rows + expiredBefore = finance.expired; each day's expired =
 * Σ /api/finance/sources credits' expiredTokens whose expiresAt falls on that day.
 */
function expiredChecks(f: Json, src: Json): Check[] {
  const d = f.daily;
  if (!d?.rows?.length || d.rows[0].expired === undefined) return [flag("daily expired", false, "GET /api/finance daily rows carry no `expired` (server older than gr_z13gmx54su step 1)")];
  const rows: Json[] = d.rows;
  const bySource = new Map<string, number>();
  for (const c of sourceCredits(src)) if (c.expiredTokens) bySource.set(c.expiresAt.slice(0, 10), (bySource.get(c.expiresAt.slice(0, 10)) ?? 0) + Number(c.expiredTokens));
  const off = rows.filter((r) => Number(r.expired) !== (bySource.get(r.day) ?? 0));
  return [
    eq("daily expired", "Σ daily.rows[].expired + daily.expiredBefore", sum(rows.map((r) => Number(r.expired))) + Number(d.expiredBefore), "finance.expired", f.expired),
    flag("daily expired per day", off.length === 0, off.length ? `days whose expired ≠ the sources' credits expiring that day: ${off.map((r) => `${r.day} ${fmt(r.expired)} vs ${fmt(bySource.get(r.day) ?? 0)}`).join(", ")}` : `each of ${rows.length} days' expired = Σ sources credits' expiredTokens expiring that day`),
  ];
}

/**
 * GET /api/finance `utilization` (kr_c0g8tvidke): check ok; per window used + expired + left = credited; credited and
 * expired = the sources' subscription credits created in the window; credited + durable = Σ the daily rows' credited.
 */
function utilizationChecks(f: Json, src: Json): Check[] {
  const u = f.utilization;
  if (!u) return [flag("utilization", false, "GET /api/finance has no `utilization` (server older than gr_z13gmx54su step 1)")];
  const out: Check[] = [flag("utilization check", u.check?.ok, `ok ${u.check?.ok}, diff ${fmt(u.check?.diff)}, daily diff ${fmt(u.check?.dailyDiff)} (${u.check?.identity})`)];
  const credits = sourceCredits(src), rows: Json[] = f.daily?.rows ?? [];
  for (const k of ["d7", "d30"] as const) {
    const w = u[k] ?? {};
    const inWindow = credits.filter((c) => c.createdAt.slice(0, 10) >= w.from && c.createdAt.slice(0, 10) <= w.to);
    out.push(eq(`utilization ${k} parts`, `used + expired + left`, Number(w.used) + Number(w.expired) + Number(w.left), `utilization.${k}.credited`, w.credited));
    out.push(eq(`utilization ${k} credited`, `Σ sources subscription credits ${w.from} → ${w.to}`, sum(inWindow.map((c) => Number(c.tokens))), `utilization.${k}.credited`, w.credited));
    out.push(eq(`utilization ${k} expired`, "Σ those credits' expiredTokens", sum(inWindow.map((c) => Number(c.expiredTokens))), `utilization.${k}.expired`, w.expired));
    out.push(eq(`utilization ${k} = daily rows`, `Σ daily credited ${w.from} → ${w.to}`, sum(rows.filter((r) => r.day >= w.from && r.day <= w.to).map((r) => Number(r.credited))), "credited + durable", Number(w.credited) + Number(w.durable)));
  }
  return out;
}

/**
 * GET /api/finance `split`: split.check ok; per window work + coordination + other = total and the shares sum to 1;
 * each daily row's byLane sums to its sessionsTokens; the 7 d total = Σ the last 7 daily rows' sessionsTokens (and the
 * 30 d total the same over 30 rows, when the chart has all 30).
 */
function splitChecks(f: Json): Check[] {
  const sp = f.split;
  if (!sp) return [flag("split", false, "GET /api/finance has no `split` (server older than gr_3ougmyubdm step 1)")];
  const rows: Json[] = f.daily?.rows ?? [];
  const laneOff = rows.filter((r) => !r.byLane || Math.abs(sum(Object.values(r.byLane).map(Number)) - Number(r.sessionsTokens)) > 3);
  const out: Check[] = [flag("split check", sp.check?.ok, `ok ${sp.check?.ok}, diff ${fmt(sp.check?.diff)}, daily diff ${fmt(sp.check?.dailyDiff)} (${sp.check?.identity})`)];
  for (const k of ["d7", "d30"] as const) {
    const w = sp[k] ?? {};
    const parts = Number(w.work?.tokens) + Number(w.coordination?.tokens) + Number(w.other?.tokens);
    const shares = Number(w.work?.share) + Number(w.coordination?.share) + Number(w.other?.share);
    out.push(flag(`split ${k} parts`, Math.abs(parts - Number(w.total?.tokens)) <= 2 && (Number(w.total?.tokens) === 0 || Math.abs(shares - 1) <= 0.0003),
      `work ${fmt(w.work?.tokens)} (${(w.work?.share * 100).toFixed(1)}%) + coordination ${fmt(w.coordination?.tokens)} (${(w.coordination?.share * 100).toFixed(1)}%) + other ${fmt(w.other?.tokens)} = total ${fmt(w.total?.tokens)} (${w.total?.sessions} sessions, ${w.from} → ${w.to})`));
    const n = Number(w.days);
    if (rows.length >= n) {
      const tail = rows.slice(-n), got = sum(tail.map((r) => Number(r.sessionsTokens)));
      out.push(flag(`split ${k} = daily rows`, Math.abs(got - Number(w.total?.tokens)) <= Math.max(1, n / 2) && tail[0]?.day === w.from,
        `Σ last ${n} daily rows' sessionsTokens ${fmt(got)} = split.${k}.total ${fmt(w.total?.tokens)} (from ${tail[0]?.day} = ${w.from})`));
    }
  }
  out.push(flag("daily lanes per day", rows.length > 0 && laneOff.length === 0,
    laneOff.length ? `days whose byLane doesn't sum to sessionsTokens: ${laneOff.map((r) => r.day).join(", ")}` : `each of ${rows.length} days' byLane sums to its sessionsTokens (±3)`));
  return out;
}

/** GET /api/finance `daily`: dailyCheck ok; Σ rows' used + debits before the window = usedBank; each day's buildings sum to its used; Σ buildings = Σ rows. */
function dailyChecks(f: Json): Check[] {
  const d = f.daily, c = f.dailyCheck;
  if (!d) return [flag("daily", false, "GET /api/finance has no `daily` (server older than gr_epbcgb0hvs step 1)")];
  const rows: Json[] = d.rows ?? [];
  const rowsUsed = sum(rows.map((r) => r.used));
  const off = rows.filter((r) => sum(Object.values(r.byBuilding ?? {}).map(Number)) !== r.used);
  const today = new Date().toISOString().slice(0, 10);
  return [
    flag("dailyCheck", c?.ok, `ok ${c?.ok}, diff ${fmt(c?.diff)}, buildings diff ${fmt(c?.buildingDiff)} (${c?.identity})`),
    eq("daily used", "Σ daily.rows[].used + daily.usedBefore", rowsUsed + d.usedBefore, "finance.usedBank", f.usedBank),
    eq("daily undated", "daily.undatedUsed", d.undatedUsed, "finance.usedDonations", f.usedDonations),
    flag("daily buildings per day", off.length === 0, off.length ? `days whose buildings don't sum to used: ${off.map((r) => r.day).join(", ")}` : `each of ${rows.length} days' byBuilding sums to its used`),
    eq("daily buildings", "Σ daily.buildings[].tokens", sum((d.buildings ?? []).map((b: Json) => b.tokens)), "Σ daily.rows[].used", rowsUsed),
    flag("daily window", rows.length === d.days && rows.length <= 30 && d.to === today && rows.every((r, i) => i === 0 || Date.parse(r.day) - Date.parse(rows[i - 1].day) === 86_400_000),
      `${rows.length} consecutive UTC days ${d.from} → ${d.to} (today ${today}), at most 30`),
  ];
}

/** GET /api/finance `cash`: plans + API keys + hosting = total within a cent; perDollar = listUsd / total (null at $0); API keys ≤ list value. */
function cashChecks(c: Json | undefined, ck: Json | undefined): Check[] {
  if (!c) return [flag("cash", false, "GET /api/finance has no `cash` (server older than gr_qggxximtru step 2)")];
  const ratio = c.total > 0 ? Math.round((c.listUsd / c.total) * 100) / 100 : null;
  return [
    flag("cashCheck", ck?.ok, `ok ${ck?.ok}, diff ${ck?.diff} (${ck?.text})`),
    near("cash parts", "plans + apiKeys + hosting", Number(c.plans) + Number(c.apiKeys) + Number(c.hosting), "cash.total", Number(c.total), 0.01),
    flag("cash perDollar", c.perDollar === ratio, `perDollar ${c.perDollar} = round(listUsd $${Number(c.listUsd).toFixed(2)} / total $${Number(c.total).toFixed(2)}, 2) ${ratio}`),
    flag("cash apiKeys ≤ listUsd", Number(c.apiKeys) <= Number(c.listUsd) + 0.01, `apiKeys $${Number(c.apiKeys).toFixed(2)} ≤ listUsd $${Number(c.listUsd).toFixed(2)} (window ${c.from} → ${c.to})`),
  ];
}

/** Every grant row of a known grant (it carries `outcomeGroup`), at any depth of the spend tree. */
function grantRows(s: Json): Json[] {
  const out: Json[] = [];
  const walk = (n: Json) => { if (n.kind === "grant" && n.outcomeGroup) out.push(n); (n.children ?? []).forEach(walk); };
  (s.rows ?? []).forEach(walk);
  return out;
}

function grantChecks(s: Json): Check[] {
  const g = s.grants;
  if (!g) return [flag("grants present", false, "GET /api/finance/spend has no grants block")];
  const rows = grantRows(s), bo = g.byOutcome ?? {};
  const groups = ["done", "cut", "open"] as const;
  const byGroup = (o: string) => sum(rows.filter((r) => r.outcomeGroup === o).map((r) => r.tokens));
  return [
    flag("grants check", s.grantsCheck?.ok, `ok ${s.grantsCheck?.ok}, diff ${fmt(s.grantsCheck?.diff)} (${s.grantsCheck?.identity})`),
    eq("grants by outcome", "Σ byOutcome tokens", sum(groups.map((o) => Number(bo[o]?.tokens))), "Σ grant rows' tokens", sum(rows.map((r) => r.tokens))),
    flag("grants each outcome", groups.every((o) => Number(bo[o]?.tokens) === byGroup(o)), groups.map((o) => `${o} ${fmt(bo[o]?.tokens)} = rows ${fmt(byGroup(o))}`).join(", ")),
    eq("grants count", "grants.count", g.count, "distinct grant rows", new Set(rows.map((r) => r.id)).size),
    // closed grants' cost estimates (docs/how-work-gets-done.md §4): every range low ≤ high, in adjusted tokens
    flag("grant estimates", g.estimates?.unit === "adjusted tokens" && Array.isArray(g.estimates?.badRanges) && g.estimates.badRanges.length === 0 && g.estimates.inside <= g.estimates.closed,
      g.estimates ? `${g.estimates.inside} of ${g.estimates.closed} closed grants inside their estimate; low ≤ high on all (${g.estimates.unit})${g.estimates.badRanges.length ? `; low > high: ${g.estimates.badRanges.join(", ")}` : ""}` : "no estimates block"),
  ];
}

/** Each building's "Not under a grant" row against its lane rows; noGrant.byLane against the lane rows; every directed row has a source, every exploration row a proposal field. */
function noGrantChecks(s: Json): Check[] {
  const ng = s.noGrant;
  if (!ng) return [flag("lanes present", false, "GET /api/finance/spend has no noGrant block (server older than gr_utygatbi85)")];
  const buckets = (s.rows ?? []).flatMap((b: Json) => (b.children ?? []).filter((c: Json) => c.kind === "no-grant"));
  const lanes = buckets.flatMap((c: Json) => c.children ?? []);
  const bad = buckets.filter((c: Json) => sum((c.children ?? []).map((l: Json) => l.tokens)) !== c.tokens || (c.children ?? []).some((l: Json) => l.kind !== "lane")).length;
  const laneNames = ["directed", "exploration", "retainer", "manager", "before"];
  const byLane = (l: string) => sum(lanes.filter((r: Json) => r.lane === l).map((r: Json) => r.tokens));
  const rowsOf = (l: string) => lanes.filter((r: Json) => r.lane === l).flatMap((r: Json) => r.children ?? []);
  const dir = rowsOf("directed"), exp = rowsOf("exploration");
  return [
    flag("lanes check", s.noGrantCheck?.ok, `ok ${s.noGrantCheck?.ok}, diff ${fmt(s.noGrantCheck?.diff)} (${s.noGrantCheck?.identity})`),
    eq("lanes sum to the bucket", "Σ lane rows", sum(lanes.map((r: Json) => r.tokens)), "Σ \"Not under a grant\" rows", sum(buckets.map((c: Json) => c.tokens))),
    flag("lanes per building", bad === 0, `${buckets.length - bad} of ${buckets.length} buildings' "Not under a grant" rows equal their lane rows`),
    flag("lanes by lane", laneNames.every((l) => Number(ng.byLane?.[l]?.tokens) === byLane(l)), laneNames.map((l) => `${l} ${fmt(ng.byLane?.[l]?.tokens)} = rows ${fmt(byLane(l))}`).join(", ")),
    flag("directed sources", dir.every((r: Json) => r.source && "askedBy" in r.source), `${dir.length} directed rows carry source (${dir.filter((r: Json) => r.source?.id).length} with a source id, ${dir.filter((r: Json) => r.source?.askedById).length} with who asked)`),
    flag("exploration proposals", exp.every((r: Json) => r.proposal !== undefined) && exp.filter((r: Json) => r.proposal).length === ng.exploration?.proposals, `${exp.length} exploration rows carry proposal (${exp.filter((r: Json) => r.proposal).length} with one = noGrant.exploration.proposals ${ng.exploration?.proposals})`),
  ];
}

/** directedBySource (gr_k71b7b6px7): its check, Σ requests + untraced = noGrant.byLane.directed, per human = the same total, one row per source id. */
function directedSourceChecks(s: Json): Check[] {
  const d = s.directedBySource;
  if (!d) return [flag("requests present", false, "GET /api/finance/spend has no directedBySource block (server older than gr_k71b7b6px7)")];
  const rows = d.rows ?? [];
  const lane = Number(s.noGrant?.byLane?.directed?.tokens);
  return [
    flag("requests check", d.check?.ok, `ok ${d.check?.ok}, diff ${fmt(d.check?.diff)} (${d.check?.identity})`),
    eq("requests sum to the directed lane", "Σ directedBySource.rows + untraced", sum(rows.map((r: Json) => r.tokens)) + Number(d.untraced?.tokens), "noGrant.byLane.directed.tokens", lane),
    eq("requests per human", "Σ directedBySource.byAsker", sum((d.byAsker ?? []).map((r: Json) => r.tokens)), "noGrant.byLane.directed.tokens", lane),
    flag("requests distinct", new Set(rows.map((r: Json) => r.id)).size === rows.length && rows.length === d.total?.requests, `${rows.length} requests, one row per source id; ${fmt(d.untraced?.tokens)} untraced over ${d.untraced?.assignments} assignments`),
  ];
}

/**
 * Each step-priced grant row (it has step children) against its step + Off-step rows; each step row's ratio = spent ÷
 * price (2 decimals) and price = the table's for its size; `steps` per size has a ratio iff it has a sample.
 */
function stepChecks(s: Json): Check[] {
  if (!s.stepsCheck) return [flag("steps present", false, "GET /api/finance/spend has no stepsCheck (server older than gr_3na7vdmd52)")];
  const grants = grantRows(s).filter((g) => (g.children ?? []).some((c: Json) => c.kind === "step"));
  const kids = grants.flatMap((g) => (g.children ?? []).filter((c: Json) => c.kind === "step" || c.kind === "off-step"));
  const bad = grants.filter((g) => sum((g.children ?? []).map((c: Json) => c.tokens)) !== g.tokens || (g.children ?? []).some((c: Json) => c.kind !== "step" && c.kind !== "off-step")).length;
  const steps = kids.filter((c: Json) => c.kind === "step");
  const prices = s.stepPrices ?? {};
  const badRatio = steps.filter((c: Json) => c.step?.price !== prices[c.step?.size] || c.step?.ratio !== Math.round((c.tokens / c.step.price) * 100) / 100).map((c: Json) => c.name);
  const sizes = s.steps?.sizes ?? {};
  const cal = ["S", "M", "L"].map((k) => `${k} ${sizes[k]?.ratio ?? "–"} over ${sizes[k]?.sample ?? "?"}`).join(", ");
  return [
    flag("steps check", s.stepsCheck.ok, `ok ${s.stepsCheck.ok}, diff ${fmt(s.stepsCheck.diff)} on ${s.stepsCheck.grants} grant rows (${s.stepsCheck.identity})`),
    eq("steps sum to the grant rows", "Σ step + off-step rows", sum(kids.map((c: Json) => c.tokens)), "Σ step-priced grant rows", sum(grants.map((g) => g.tokens))),
    flag("steps per grant", bad === 0 && grants.length === s.stepsCheck.grants, `${grants.length - bad} of ${grants.length} step-priced grant rows equal their step + off-step rows (${steps.length} step rows, ${kids.length - steps.length} off-step)`),
    flag("step ratios", badRatio.length === 0, badRatio.length ? `ratio or price off on: ${badRatio.join("; ")}` : `${steps.length} step rows: price = table (${["S", "M", "L"].map((k) => `${k} ${fmt(prices[k])}`).join(", ")}), ratio = spent ÷ price`),
    flag("step calibration", !!s.steps && ["S", "M", "L"].every((k) => (sizes[k]?.ratio === null) === (sizes[k]?.sample === 0)), `steps done in ${s.steps?.days ?? "?"} days, median spent ÷ price: ${cal}`),
  ];
}

/** Three grant rows (the largest, the smallest, one cut if any) against GET /api/grants/:id: grantTokens, status and outcome agree. */
async function grantSampleChecks(s: Json): Promise<Check[]> {
  const rows = grantRows(s).sort((a, b) => b.tokens - a.tokens);
  if (!rows.length) return [];
  const pick = [...new Map([rows[0], rows[rows.length - 1], rows.find((r) => r.outcomeGroup === "cut") ?? rows[1]].filter(Boolean).map((r) => [r.id, r])).values()];
  return Promise.all(pick.map(async (r) => {
    const g = (await get(`/api/grants/${r.id}`)).grant ?? {};
    const ok = g.grantTokens === r.grantTokens && g.status === r.status && (g.outcome ?? null) === (r.outcome ?? null);
    return flag(`grant ${r.id}`, ok, `row ${fmt(r.grantTokens)} ${r.status} ${r.outcome} = /api/grants ${fmt(g.grantTokens)} ${g.status} ${g.outcome ?? null}`);
  }));
}

/**
 * Every grant's sessions (GET /api/sessions?grantId=, gr_4tf9hd64d5) sum to its GET /api/grants/:id spentTokens. A grant
 * whose session is running can move between the two reads, so a mismatch is read again (twice) before it counts.
 */
async function grantSessionChecks(s: Json): Promise<Check[]> {
  const ids = [...new Set(grantRows(s).map((r) => r.id as string))];
  const pair = async (id: string) => {
    const [g, ss] = await Promise.all([get(`/api/grants/${id}`), get(`/api/sessions?grantId=${encodeURIComponent(id)}`)]);
    return { id, spent: Number(g.grant?.spentTokens), sum: sum((ss.sessions ?? []).map((x: Json) => Number(x.adjustedOutputTokens))), n: (ss.sessions ?? []).length };
  };
  const out: Awaited<ReturnType<typeof pair>>[] = [];
  for (let i = 0; i < ids.length; i += 8) out.push(...await Promise.all(ids.slice(i, i + 8).map(pair)));
  for (let k = 0; k < 2; k++) for (const [i, r] of out.entries()) if (r.sum !== r.spent) out[i] = await pair(r.id);
  const bad = out.filter((r) => r.sum !== r.spent);
  const sessions = sum(out.map((r) => r.n)), tokens = sum(out.map((r) => r.sum));
  return [flag("grant sessions sum to spent", ids.length > 0 && bad.length === 0,
    bad.length ? bad.map((r) => `${r.id}: Σ sessions ${fmt(r.sum)} ≠ spentTokens ${fmt(r.spent)}`).join("; ")
      : `${ids.length} grants, ${fmt(sessions)} sessions, ${fmt(tokens)} adj. tokens: each grant's Σ /api/sessions?grantId= = /api/grants/:id spentTokens`)];
}

const KINDS = ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"] as const;
/**
 * The lane × token-kind table of one window (gr_lwgus14rd2 step 1): its rows' adj. tokens + the back-filled sessions not
 * counted = Σ the window's sessions (within half a token per session: each session is rounded once there), and the
 * buildings' tables add up to the town's.
 */
function laneKindChecks(window: string, lk: Json | undefined): Check[] {
  if (!lk) return [flag(`lane × kind ${window}`, false, `GET /api/finance/spend?window=${window} has no byLaneKind`)];
  const rows = (lk.rows ?? []) as Json[];
  const n = sum(rows.map((r) => Number(r.sessions))) + Number(lk.notCounted?.sessions);
  const tol = Math.max(1, n / 2);
  const counted = sum(rows.map((r) => Number(r.tokens))) + Number(lk.notCounted?.tokens);
  const blds = Object.values(lk.buildings ?? {}) as Json[];
  const bldSum = sum(blds.map((b) => sum(((b.rows ?? []) as Json[]).map((r) => Number(r.tokens))) + Number(b.notCounted?.tokens)));
  const kindsOk = rows.every((r) => Math.abs(sum(KINDS.map((k) => Number(r.kinds?.[k]?.tokens))) - Number(r.tokens)) <= 3);
  return [
    flag(`lane × kind ${window} rows sum to window sessions`, lk.window === window && Math.abs(counted - Number(lk.sessionsTokens)) <= tol,
      `Σ rows ${fmt(counted - Number(lk.notCounted?.tokens))} + not counted ${fmt(lk.notCounted?.tokens)} = sessions ${fmt(lk.sessionsTokens)} (±${fmt(tol)}, ${n} sessions, ${lk.from?.slice(0, 10)} to ${lk.to?.slice(0, 16)})`),
    flag(`lane × kind ${window} buildings`, Math.abs(bldSum - counted) <= tol && kindsOk, `Σ ${blds.length} buildings' tables ${fmt(bldSum)} = town ${fmt(counted)}; each row's kinds sum to its tokens (±3)`),
  ];
}
/**
 * Manager wakes (gr_lwgus14rd2 step 3): each building's days sum to its total, the buildings to the town's total and to
 * Σ manage sessions, and that is no more than the 7 d lane × kind table's manager row + its back-filled sessions.
 */
function wakeChecks(mw: Json | undefined, lk7d: Json | undefined): Check[] {
  if (!mw) return [flag("manager wakes", false, "GET /api/finance/spend has no managerWakes")];
  const blds = Object.values(mw.buildings ?? {}) as Json[];
  const tol = Math.max(1, Number(mw.total?.wakes) / 2);
  const daysOk = blds.every((b) => Math.abs(sum(((b.days ?? []) as Json[]).map((d) => Number(d.tokens))) - Number(b.total?.tokens)) <= tol
    && sum(((b.days ?? []) as Json[]).map((d) => Number(d.wakes))) === Number(b.total?.wakes));
  const bldSum = sum(blds.map((b) => Number(b.total?.tokens)));
  const mgr = Number(((lk7d?.rows ?? []) as Json[]).find((r) => r.lane === "manager")?.tokens ?? 0) + Number(lk7d?.notCounted?.tokens ?? 0);
  const wakes = Number(mw.total?.tokens);
  return [
    flag("manager wakes add up", daysOk && Math.abs(bldSum - wakes) <= tol && Math.abs(wakes - Number(mw.manageTokens)) <= tol && mw.check?.ok === true,
      `${blds.length} buildings' days sum to their totals; Σ buildings ${fmt(bldSum)} = town ${fmt(wakes)} = Σ manage sessions ${fmt(mw.manageTokens)} (±${fmt(tol)}, ${mw.total?.wakes} wakes, ${mw.total?.decided} decided, ${mw.total?.askActions ?? "no"} ask actions)`),
    flag("manager wakes ≤ manager row", !lk7d || wakes <= mgr + tol,
      `wake tokens ${fmt(wakes)} ≤ 7 d lane × kind manager row + not counted ${fmt(mgr)}`),
  ];
}
function mixChecks(m: Json | undefined, bm: Json | undefined): Check[] {
  if (!m) return [flag("mix present", false, "GET /api/finance has no mix")];
  const counts = KINDS.map((k) => Number(m.counts?.[k]));
  const weighted = sum(KINDS.map((k) => Number(m.weights?.[k]) * Number(m.counts?.[k])));
  const ageH = (Date.now() - Date.parse(m.computedAt)) / 3_600_000;
  return [
    eq("mix counts", "Σ mix.counts", sum(counts), "mix.rawTokens", m.rawTokens),
    flag("mix adjusted", Math.abs(weighted - m.adjustedTokens) <= 1, `Σ weight × count ${fmt(weighted)} = mix.adjustedTokens ${fmt(m.adjustedTokens)} (±1)`),
    flag("mix raw per adj.", Math.abs(m.rawPerAdjusted * m.adjustedTokens / m.rawTokens - 1) < 1e-4, `rawPerAdjusted ${Number(m.rawPerAdjusted).toFixed(3)} = rawTokens / adjustedTokens`),
    flag("mix shares", [m.rawShare, m.costShare].every((x: Json) => Math.abs(sum(KINDS.map((k) => Number(x?.[k]))) - 1) < 1e-9), `raw shares and cost shares each sum to 1`),
    flag("mix one record", bm?.computedAt === m.computedAt, `bank.mix.computedAt ${bm?.computedAt} = finance.mix.computedAt ${m.computedAt}`),
    flag("mix updated daily", ageH >= 0 && ageH < 26, `computed ${ageH.toFixed(1)} h ago (${m.source}, ${m.sessions} sessions, ${m.from?.slice(0, 10)} to ${m.to?.slice(0, 10)})`),
  ];
}

async function get(path: string): Promise<Json> {
  const res = await fetch(base + path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
  return (await res.json()) as Json;
}

async function main(): Promise<number> {
  const health = await get("/api/health").catch((e: Error) => ({ commit: `unknown (${e.message})` }));
  let round = 0, bodies: Json[] = [], result: Check[] = [];
  while (round < 3) {
    round++;
    bodies = await Promise.all(["/api/finance", "/api/finance/spend", "/api/finance/sources", "/api/bank", "/api/finance/fly"].map(get));
    const [f, s, src, bank, fly] = bodies as [Json, Json, Json, Json, Json];
    result = checks(f, s, src, bank, fly);
    if (result.every((c) => c.ok)) break;
  }
  const [f, s, src, , fly] = bodies as [Json, Json, Json, Json, Json];
  if (s.grants) result.push(...await grantSampleChecks(s));
  if (s.grants) result.push(...await grantSessionChecks(s));
  const lk7d = (await get("/api/finance/spend?window=7d").catch(() => ({}))).byLaneKind;
  result.push(...laneKindChecks("today", s.byLaneKind), ...laneKindChecks("7d", lk7d), ...wakeChecks(s.managerWakes, lk7d));
  console.log(`${base}: commit ${String(health.commit).slice(0, 7)}${round > 1 ? `, round ${round} of 3` : ""}`);
  console.log(`at: finance ${f.at}, spend ${s.at}, sources ${src.at}, fly ${fly.at}`);
  console.log(`usd at API list price: used $${Number(f.usd?.used).toFixed(2)}, left $${Number(f.usd?.left).toFixed(2)}, burn $${Number(f.usd?.burnPerDay).toFixed(2)}/day, inflow $${Number(f.usd?.inflowPerDay).toFixed(2)}/day`);
  console.log(`fly today ${fly.today?.day}: desks $${Number(fly.today?.deskUsd).toFixed(2)} + town $${Number(fly.today?.townUsd).toFixed(2)} = $${Number(fly.today?.totalUsd).toFixed(2)}; last ${fly.windowDays} days $${Number(fly.totals?.totalUsd).toFixed(2)} (desk time ${(Number(fly.totals?.deskMs) / 3_600_000).toFixed(1)} h, ${fly.totals?.sessions} sessions)`);
  if (s.grants) console.log(`grants: ${fmt(s.grants.spent)} spent on ${s.grants.count} (funded ${fmt(s.grants.funded)}): done ${fmt(s.grants.byOutcome.done.tokens)} on ${s.grants.byOutcome.done.count}, cut ${fmt(s.grants.byOutcome.cut.tokens)} on ${s.grants.byOutcome.cut.count}, open ${fmt(s.grants.byOutcome.open.tokens)} on ${s.grants.byOutcome.open.count}; ${s.grants.overFunding.count} over funding by ${fmt(s.grants.overFunding.tokens)}`);
  if (f.mix) console.log(`mix: 1 adj. token ≈ ${Number(f.mix.rawPerAdjusted).toFixed(1)} raw tokens, ${KINDS.map((k) => `${k} ${(f.mix.rawShare[k] * 100).toFixed(1)}%`).join(", ")} (${f.mix.formula})`);
  if (s.byLaneKind) console.log(`lane × kind today: ${(s.byLaneKind.rows as Json[]).map((r) => `${r.lane} ${fmt(r.tokens)} (cache writes ${(r.cacheWriteShare * 100).toFixed(1)}%)`).join(", ")}; not counted ${fmt(s.byLaneKind.notCounted.tokens)}`);
  if (s.managerWakes) console.log(`manager wakes 7 d: ${s.managerWakes.total.wakes} wakes, ${fmt(s.managerWakes.total.tokens)} adj. tokens, ${s.managerWakes.total.decided} decided (${s.managerWakes.total.askActions ?? "no"} ask actions); town-hall ${s.managerWakes.buildings?.["town-hall"]?.total?.decided ?? 0} decided`);
  if (f.split) console.log(`split: 7 d ${fmt(f.split.d7.total.tokens)}: work ${(f.split.d7.work.share * 100).toFixed(1)}%, coordination ${(f.split.d7.coordination.share * 100).toFixed(1)}%, other ${(f.split.d7.other.share * 100).toFixed(1)}%; 30 d ${fmt(f.split.d30.total.tokens)}: work ${(f.split.d30.work.share * 100).toFixed(1)}%, coordination ${(f.split.d30.coordination.share * 100).toFixed(1)}%`);
  if (f.utilization) console.log(`utilization: 7 d credited ${fmt(f.utilization.d7.credited)}, used ${fmt(f.utilization.d7.used)} (${(f.utilization.d7.usedShare * 100).toFixed(1)}%), expired ${fmt(f.utilization.d7.expired)}, left ${fmt(f.utilization.d7.left)}; 30 d credited ${fmt(f.utilization.d30.credited)}, used ${(f.utilization.d30.usedShare * 100).toFixed(1)}%`);
  for (const c of result) console.log(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.line}`);
  const failed = result.filter((c) => !c.ok).length;
  console.log(failed ? `${failed} of ${result.length} checks failed` : `all ${result.length} checks ✓`);
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code), (e: Error) => { console.error(`✗ ${base}: ${e.message}`); process.exit(1); });
