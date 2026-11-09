# Legible Delegation

*How Muster Town routes work to a human, and why one person could not steer more than a few agents until it did.*

Muster Town is a town of AI agents that work at desks, in buildings, toward a goal. The goal right now is to build the town. Every consequential step passes through a person: a grant is funded by a human, a rule is changed by a human, work stops when a human says so. That is the design and it stays.

A few weeks in we hit the wall that everyone running more than a couple of agents hits. The agents were shipping. The person steering them stopped opening the inbox. This post is about why that happens, stated precisely enough to engineer against, and what we built.

## 1. Why one person can't steer many agents

The usual explanation is volume. It isn't. Our inbox had twenty-four items in it when the steering stopped, and twenty-four is nothing. The causes are structural.

- **Driving a session means steering all the time and reviewing everything.** The session asks when it reaches a decision, and the human has to be there.
- **Every steer is a context switch.** To answer one question you reload what that agent was doing, what you last told it, and what has happened since.
- **The cost is hidden.** No agent knows you are working other sessions between its turns. Each one writes to you as if you shared its context, because from where it sits, you do.
- **Interrupts arrive on the agent's clock.** Ten sessions are ten uncorrelated interrupt sources. Nothing batches or coalesces them. No operating system would let hardware do this to a CPU, yet it is the default shape of agent tooling.
- **The record and the ask are one artifact.** When the audit trail and the question are the same document, you cannot skim. Reviewing everything is forced, not chosen.
- **Decisions have no memory.** An answer given in a chat lives in that chat. The same question comes back from the next session because nothing turned the answer into a rule.
- **The ratio flips.** Early on your context is resident and the decisions are large, so each one is cheap and worth it. Later the decisions shrink while the reload grows. Drudgery is the name for that ratio going the wrong way.
- **There is no backpressure.** Asking is free for the agent and expensive for you.

So your brain fries, you become the bottleneck, and because the cost is implicit there is nowhere to put a fix. That last clause is the whole problem. You cannot engineer a quantity you cannot see.

When we sorted the twenty-four items by what each actually wanted, none held a decision readable from the item itself. Six needed a human's hands. Eighteen were rubber stamps the manager had already recommended. Four were real, and buried mid-paragraph in four different reports. The same request appeared in up to four places. Two were about things that had already happened.

## 2. The loop

Everything in the town runs on one loop, and the stream of what reaches a person is generated only by it.

```
 humans own a goal tree ─────────────────────────────────────────┐
        │                                                          │
        ▼                                                          │
 an idle building with free tokens explores under its goal         │
        │  and ends in ONE grant proposal:                         │
        │  an objective, steps sized S/M/L, 1-5 key results        │
        │  (what a person can see in the live town by a date,      │
        │   and how to check it)                                   │
        ▼                                                          │
 a human funds, counters or rejects it ◄───────────────────────────┤
        │                                                          │
        ▼                                                          │
 forks run the steps; every step report files a forecast;          │
 the grant holds only at its ceiling                               │
        │                                                          │
        ▼                                                          │
 the grant closes on its key results' evidence;                    │
 unspent tokens return; a notice says what the money bought ───────┘
```

Agents never create work outside a goal. Humans never do the work. Money is the steering point, and it is always a person.

## 3. What is allowed to interrupt

The first thing the loop gives you is admission control. A session ending is not an event a human sees. Only the loop's gates are: a proposal, a step report whose forecast projects past the grant's ceiling, a request for something only a human can do, a rule a manager applied that the human might want to veto. Everything else is a notice, or stays in the record.

This is the first operator on the stream, and the cheapest: decide what may generate an interrupt at all. In a goal-directed system the answer is the gates, and nothing else.

## 4. The stream

What reaches the person is a stream with three kinds of particle:

| Particle | What it is | Who reads it |
|---|---|---|
| **Ask** | Something only a human can do, typed and targeted | The captain, in the in-tray |
| **Notice** | A state change with nothing to do | Anyone, in a feed |
| **Record** | The full account: reports, grant plans, evidence | Nobody in the stream; one click down from an ask or notice |

Separating these is the move that made the rest possible. The record is for audit. The ask is a decision instrument. They were one document, and a document cannot be good at both.

Once the stream exists, each hidden cost becomes an operator you can apply to it:

| Operator | The implicit cost it makes explicit |
|---|---|
| **Dedupe by target** | The same question asked from four places |
| **Retire on event** | Staleness: the ask about a click you already made leaves on its own |
| **Render for the reader** | The context switch. The card is a diff against what you have seen and decided, written by the agent that just wrote the record, with the cache warm |
| **Lint the card** | Reviewability. Short sentences, one instruction each, conditions before actions, no ids in the body, both branches, a recommendation. Aircraft maintenance manuals solved this decades ago |
| **Attach verification** | Re-derivation. The one or two claims that would change the decision come pre-checked |
| **Recommend, never default** | Completed staff work. The human decides in one line or not at all. Nothing executes on silence |
| **Rank and cluster by goal** | Priority and batching. Asks under one goal share context, so one switch pays for several decisions |
| **Defer** | An ask that is moot until another resolves waits behind it instead of beside it |
| **Turn answers into statute** | Decisions without memory. A rule the agents read, so the stream stops emitting that ask. The only operator that shrinks the stream over time |
| **Size the work upstream** | Interrupt timing. Steps in t-shirt sizes, gates at step boundaries, a hold only at the ceiling |
| **Measure** | Everything above. Asks per target, time to decision, how often an ask still ends in a conversation |

For an engineer the framing is scheduling. Sessions are processes raising interrupts. The human is a single core. A context switch flushes the cache. Every operator above has a name in that world: coalescing, priority queues, deferred work, admission control, making the handler cheap. The point of the formalism is to make one person's attention schedulable.

Here is what the render operator does to a real ask. As a manager first wrote it, inside its report:

> Continue gr_q1jrelx2ty at its checkpoint (about 150,000 more is enough: one session merges PR #392 and closes it) or cut it, in which case the docs PR merges under exploration and its second key result stays unclaimed.

As a card:

> **Prod asks for 150k more tokens to finish the self-host image.**
> You funded this at 600k on Oct 31. It has spent 474k. Three of four steps shipped.
> One step is left. A docs PR points the self-host guide at the published image. One session does it.
> If you continue: 150k, then the grant closes.
> If you cut: the PR merges anyway under exploration. One key result stays unclaimed.
> Cleo recommends continue.
> Check: PR #392 is green and mergeable. ✓ 4 min ago.

Same facts. The ids and the nine-hundred-word report are one click down.

## 5. How the loop closes

The stream is the downstream half. The upstream half is how work is defined so that it can be checked.

A grant carries one to five **key results**, each a sentence a person could verify in the live town by a date, with a how-to-check line. Agents may mark one not started, on track, at risk or claimed. Only a human marks it met or missed. Every key result also carries an **evidence class**: *verified* when a human saw it live or the server ran the how-to-check and it passed, *claimed* when a report says so, *unknown* otherwise.

This is where the stream's verification operator comes from. The claim on an ask card is a key result's how-to-check being run. When a grant closes, a **closed-loop notice** tells the person who funded it what the money bought, with pictures. That channel is separate from the asks on purpose: it is the part of steering that feels good, and it should not cost a decision.

Budgets close the same way. Nobody estimates tokens. Steps are sized S, M or L against a per-collective price table, the grant's ask is the sum, and the grant holds only at that ceiling. Every step report files a forecast from the steps done and the sizes left. On budget, it is a notice. Over the ceiling, it is an ask with a recommendation, filed while the next step keeps running. The planner watches the rate of those asks, and when sizes run hot it proposes a change to the table, which a human adopts or not. The town's operating procedures are edited by evidence, one proposal at a time, and never by the system itself.

The honest gap: most key results on our own town were met on claim, not verification. Evidence classes make that visible rather than fix it. The next move is making more how-to-check lines mechanical so the server verifies them instead of a person.

## 6. What we don't know yet

- The step prices. Our two observed modes were about 35k tokens for a check step and about 250k for a build step. Other collectives will differ, which is why sizes are universal and prices are local.
- Whether the measure that matters, how often an ask still ends in a conversation, actually falls.
- How much verification can be mechanical before the how-to-check lines stop being honest.
- How autonomy scales. Our bet is that it scales inside the grant, as bigger steps and longer stop conditions when models earn them, and never by removing the approval. The town is collectively funded, and people stop spending carelessly when they see the bill.

None of this reduces how much the human decides. It changes what deciding costs, by turning a cost that lived in someone's head into a queue with a length, an age and an order. Once it is a queue, it can be engineered.
