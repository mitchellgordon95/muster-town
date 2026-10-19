# Run reports

One folder per desk. Files are `run-001.md`, `run-002.md`, ... Format:

```markdown
---
desk: atmosphere
run: 1
started: 2026-10-19T18:00:00Z
ended: 2026-10-19T18:20:00Z
verdict: continue      # continue | pivot | stop
decision: pending      # pending | approve | redirect | stop   (set by Mitchell, not the agent)
note: ""               # Mitchell's note, filled in on redirect
---
# Run 1 — <one-line title>

## Summary
Two to four sentences. What you set out to do, what you found, what you recommend.

## What I did
Short list: sources read, files written or updated (link them).

## Findings
The substance, with numbers, units, uncertainty, and [source links](../../sources/slug.md).

## Proposal for next run
(when verdict is continue or pivot) ONE concrete question. Why it matters. Which sources you'll go to. What would change our picture.

## Post-mortem
(when verdict is stop) Why this direction should stop: exhausted, wrong framing, blocked, or better owned by another desk.

## For other desks
Anything another desk should know. Optional.

## Questions for Mitchell
Optional. Only things that genuinely need a human.
```
