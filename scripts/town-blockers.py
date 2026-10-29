#!/usr/bin/env python3
"""Town blockers: the top wait times of the last 7 days, measured from the event log (docs/manual.md, "Town blockers").

Usage (on a desk or any shell with the town token):
  AGENT_TOWN_URL=https://muster.town AGENT_TOWN_TOKEN=at_... python3 -I scripts/town-blockers.py [--days 7] [--cache ~/.cache/town-events.json]

It pages GET /api/events?since=<id>&limit=500 forward from the cache (or from the start the first time), keeps the cache,
and prints one markdown table per blocker: redeploy drains, decisions waiting on a human, assignments waiting on a
redeploy or a colleague, budgets exhausted. Work waiting on a time (waitFor {after}) is scheduled, not blocked (Mitchell,
town hall mt_xywhisvdcm): it gets its own line under section 3 and is left out of the blocker rows and "Pending now". The Workshop manager pastes the tables into the "Town blockers" topic page at
every rollup. Every number is derived only from the events named in the code below; nothing is estimated.
"""
import argparse, collections, json, os, re, statistics, sys, urllib.request
from datetime import datetime, timedelta

ap = argparse.ArgumentParser()
ap.add_argument("--days", type=int, default=7)
ap.add_argument("--cache", default=os.path.expanduser("~/.cache/town-events.json"))
args = ap.parse_args()
URL = os.environ.get("AGENT_TOWN_URL", "https://muster.town").rstrip("/")
TOK = os.environ["AGENT_TOWN_TOKEN"]

def fetch(cache):
    ev = json.load(open(cache)) if os.path.exists(cache) else []
    since = ev[-1]["id"] if ev else 0
    while True:
        req = urllib.request.Request(f"{URL}/api/events?since={since}&limit=500", headers={"Authorization": f"Bearer {TOK}"})
        batch = json.load(urllib.request.urlopen(req))["events"]
        if not batch: break
        ev.extend(batch); since = batch[-1]["id"]
        if len(batch) < 500: break
    os.makedirs(os.path.dirname(cache), exist_ok=True)
    json.dump(ev, open(cache, "w"))
    return ev

P = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))
def med(xs): return statistics.median(xs) if xs else 0
def pct(xs, q): xs = sorted(xs); return xs[min(len(xs) - 1, int(len(xs) * q))] if xs else 0
def mx(xs): return max(xs) if xs else 0

ev = fetch(args.cache)
now = P(ev[-1]["ts"]); since = now - timedelta(days=args.days)
print(f"Town blockers, {args.days} days to {now.strftime('%Y-%m-%d %H:%M')}Z, from {len(ev)} events (last id {ev[-1]['id']})\n")

# 1. Redeploys: "Redeploy requested by X" … "Redeploy: draining, waiting for N session(s) to end: … (up to M min)" … "drain timed out" |
#    "pull again after the drain" … "Redeploy finished". Drain wait = first "draining" line to the drain's end.
redeploys, cur = [], None
for e in (e for e in ev if e["type"] == "system"):
    t, ts = e["text"], P(e["ts"])
    if t.startswith("Redeploy requested by") and cur is None:
        cur = {"start": ts, "by": t.split("by ")[1].strip(), "drain_start": None, "drain_end": None, "waited_on": 0, "timed_out": False, "killed": [], "joins": 0}
    elif cur is None: continue
    elif "request joins the running one" in t: cur["joins"] += 1
    elif t.startswith("Redeploy: draining, waiting for"):
        cur["drain_start"] = cur["drain_start"] or ts
        m = re.search(r"to end: (.*?) \(up to (\d+) min\)", t); cur["waited_on"] = max(cur["waited_on"], len(m.group(1).split(", "))); cur["cap"] = int(m.group(2))
    elif t.startswith("Redeploy: drain timed out"): cur["timed_out"] = True; cur["drain_end"] = ts; cur["killed"] = t.split("startup): ")[1].split(", ")
    elif t.startswith("Redeploy: drain … ok"): cur["drain_end"] = ts; cur["drain_start"] = cur["drain_start"] or ts
    elif t.startswith("Redeploy: pull again after the drain") and cur["drain_end"] is None: cur["drain_end"] = ts
    elif t.startswith("Redeploy finished") or t.startswith("Redeploy failed"): cur["end"] = ts; redeploys.append(cur); cur = None
r = [x for x in redeploys if x["start"] >= since and x.get("end")]
wall = [(x["end"] - x["start"]).total_seconds() / 60 for x in r]
waited = [x for x in r if x["waited_on"]]
dw = [(x["drain_end"] - x["drain_start"]).total_seconds() / 60 for x in waited if x["drain_end"]]
print("## 1. Redeploy drain\n")
print("| Measure | Value |\n|---|---|")
print(f"| Redeploys finished | {len(r)} ({len(r)/args.days:.1f}/day; by {', '.join(f'{k} {v}' for k, v in collections.Counter(x['by'].split(' (')[0] for x in r).most_common())}) |")
print(f"| Request to back up, all redeploys | sum {sum(wall):.0f} min; median {med(wall):.1f} min; p90 {pct(wall, .9):.1f} min; max {mx(wall):.1f} min |")
print(f"| Drained with sessions running | {len(waited)} of {len(r)}; drain wait sum {sum(dw):.0f} min; median {med(dw):.1f} min; max {mx(dw):.1f} min (cap {collections.Counter(x.get('cap') for x in waited).most_common(1)[0][0] if waited else '-'} min) |")
print(f"| Drains timed out | {sum(x['timed_out'] for x in r)}; sessions killed and their assignments re-queued: {sum(len(x['killed']) for x in r)} |")
print(f"| Sessions told 'a redeploy is waiting for you' | {sum(x['waited_on'] for x in r)} session-waits; {sum(x['joins'] for x in r)} requests joined a running redeploy |")
print(f"| Per day | {', '.join(f'{d} {n}' for d, n in sorted(collections.Counter(x['start'].strftime('%m-%d') for x in r).items()))} |")

# 2. Decisions waiting on a human: grant.proposed -> funded/countered/rejected; report docs -> doc.decision with decidedBy us_…;
#    grant.checkpoint -> funded (continued) / closed / updated.
gp, gw = {}, []
for e in ev:
    if e["type"] == "grant.proposed": gp[e["payload"]["grantId"]] = P(e["ts"])
    if e["type"] in ("grant.funded", "grant.countered", "grant.rejected") and e["payload"].get("grantId") in gp:
        g = e["payload"]["grantId"]; gw.append(((P(e["ts"]) - gp[g]).total_seconds() / 3600, e["type"], g, P(e["ts"]))); del gp[g]
cp, cw = {}, []
for e in ev:
    if e["type"] == "grant.checkpoint": cp[e["payload"]["grantId"]] = P(e["ts"])
    if e["type"] in ("grant.funded", "grant.closed", "grant.updated") and e["payload"].get("grantId") in cp:
        g = e["payload"]["grantId"]; cw.append(((P(e["ts"]) - cp[g]).total_seconds() / 3600, g, P(e["ts"]))); del cp[g]
dc, rw = {}, []
for e in ev:
    if e["type"] == "doc.created" and e["payload"].get("docType") == "report": dc[e["payload"]["docId"]] = (P(e["ts"]), e["text"])
    if e["type"] == "doc.decision" and e["payload"].get("docId") in dc:
        d = e["payload"]["docId"]; human = str(e["payload"].get("decidedBy", "")).startswith("us_")
        rw.append(((P(e["ts"]) - dc[d][0]).total_seconds() / 3600, d, P(e["ts"]), human, dc[d][1])); del dc[d]
g7 = [w for w in gw if w[3] >= since]; c7 = [w for w in cw if w[2] >= since]
h7 = [w for w in rw if w[3] and w[2] >= since]; a7 = [w for w in rw if not w[3] and w[2] >= since]
hd = sorted([w[3] for w in g7] + [w[2] for w in c7] + [w[2] for w in h7])
sit = []
for t in hd:
    if sit and (t - sit[-1][-1]).total_seconds() < 1800: sit[-1].append(t)
    else: sit.append([t])
gaps = [(sit[i + 1][0] - sit[i][-1]).total_seconds() / 3600 for i in range(len(sit) - 1)]
print("\n## 2. Decisions waiting on a human (Town Hall in-tray)\n")
print("| Measure | Value |\n|---|---|")
print(f"| Grant proposals decided | {len(g7)}; wait median {med([w[0] for w in g7]):.1f} h; p90 {pct([w[0] for w in g7], .9):.1f} h; max {mx([w[0] for w in g7]):.1f} h; sum {sum(w[0] for w in g7):.0f} h |")
print(f"| Checkpoints continued or closed | {len(c7)}; wait median {med([w[0] for w in c7]):.1f} h; max {mx([w[0] for w in c7]):.1f} h |")
print(f"| Rollups and reports decided by a human | {len(h7)}; wait median {med([w[0] for w in h7]):.1f} h; p75 {pct([w[0] for w in h7], .75):.1f} h; p90 {pct([w[0] for w in h7], .9):.1f} h; max {mx([w[0] for w in h7]):.1f} h; {sum(1 for w in h7 if w[0] > 6)} waited over 6 h |")
print(f"| Human sittings (decisions less than 30 min apart) | {len(sit)} sittings for {len(hd)} decisions ({len(sit)/args.days:.1f}/day); gap between sittings median {med(gaps):.1f} h; max {mx(gaps):.1f} h |")
print(f"| Open now | proposals {len(gp)} (oldest {mx([(now - t).total_seconds() / 3600 for t in gp.values()]):.1f} h); checkpoints held {len(cp)} (oldest {mx([(now - t).total_seconds() / 3600 for t in cp.values()]):.1f} h); undecided reports {len(dc)} |")
print(f"| For contrast: resident reports decided by managers | {len(a7)}; wait median {med([w[0] for w in a7]) * 60:.0f} min; p90 {pct([w[0] for w in a7], .9):.1f} h |")

# 3. Assignments waiting: assignment.created (payload.waitFor) -> assignment.status active.
cr, pend, waits = {}, {}, []
for e in ev:
    if e["type"] == "assignment.created": cr[e["payload"]["assignmentId"]] = (P(e["ts"]), e["payload"], e["text"]); pend[e["payload"]["assignmentId"]] = P(e["ts"])
    if e["type"] == "assignment.status":
        a, s = e["payload"]["assignmentId"], e["payload"]["status"]
        if s == "pending": pend[a] = P(e["ts"])
        else:
            pend.pop(a, None)
            if s == "active" and a in cr and P(e["ts"]) >= since:
                w = cr[a][1].get("waitFor") or {}; waits.append(((P(e["ts"]) - cr[a][0]).total_seconds() / 60, next(iter(w), "none"), a, cr[a][2]))
by = collections.defaultdict(list)
for w in waits: by[w[1]].append(w[0])
print("\n## 3. Assignments waiting before they start\n")
print("| Waiting on | Started | Wait median | p90 | max |\n|---|---|---|---|---|")
for k in ("deploy", "assignment", "decision", "none"):
    xs = by.get(k, [])
    if xs: print(f"| {k} | {len(xs)} | {med(xs):.0f} min | {pct(xs, .9):.0f} min | {mx(xs) / 60:.1f} h |")
# scheduled (a time) is by design: pending ones whose time is still ahead are not counted as waiting
runs = lambda a: (cr[a][1].get("waitFor") or {}).get("after") if a in cr else None
sched = {a: t for a, t in pend.items() if runs(a) and P(runs(a)) > now}
blk = {a: t for a, t in pend.items() if a not in sched}
print(f"| Pending now (not scheduled) | {len(blk)} | oldest {mx([(now - t).total_seconds() / 3600 for t in blk.values()]):.1f} h | | |")
xs = by.get("after", [])
print(f"\nScheduled, not a blocker: {len(xs)} started on their time{f' (created to start median {med(xs):.0f} min)' if xs else ''}; {len(sched)} scheduled now{': next ' + min(runs(a) for a in sched)[:16].replace('T', ' ') + ' UTC' if sched else ''}.")
be = [e for e in ev if e["type"] == "budget.exhausted" and P(e["ts"]) >= since]
print(f"\n## 4. Budgets exhausted\n\n{len(be)} times: {', '.join(f'{k} {v}' for k, v in collections.Counter(e['text'].split(' used')[0].split(' has run')[0] for e in be).most_common())}")
