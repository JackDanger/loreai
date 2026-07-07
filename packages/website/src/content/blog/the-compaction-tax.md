---
title: "The compaction tax"
subtitle: "We benchmarked what memory actually costs you, in dollars and in focus"
description: A real coding-agent memory benchmark, with receipts. The two taxes memory puts on your dollars and your focus, each with a number attached.
pubDate: 2026-07-11
author: Lore Team
tags:
  - memory
  - context management
  - benchmark
  - agents
---

We have made two arguments on this blog. In
[Why memory is not enough](/blog/why-memory-is-not-enough) we said a store on the
sidelines cannot save the session that is overflowing right now, because compaction
runs whether or not it is about to drop something you still need. In
[How Lore remembers, forgets, and changes its mind](/blog/how-lore-remembers-and-forgets)
we said the capture has to be automatic, because memory you have to reach for is memory
you will forget to reach for.

Arguments are cheap. So we built a benchmark and ran it, and this post is the receipts.

There are two taxes hiding in how agents handle memory today. One the machine charges
you automatically, in dollars and in lost context. One you charge yourself, in
attention. We can now put a number on both.

## How we measured it

The full protocol is written up and versioned in the repo (see
[the methodology](https://github.com/BYK/loreai/blob/main/packages/core/eval/live/METHODOLOGY.md)),
and you can reproduce the core of it with `lore eval`. The short version:

Every run drives a real OpenCode agent, turn by turn, against a real model. Nothing is
replayed. We probe on four arbitrary values stated once in passing, an order status, a
sales channel, a region, a warehouse, none of which can be guessed by reading the code.
If they show up in the file the agent writes at the end, something carried them. The
scorer is a mechanical check for those four values, so there is no model grading its own
homework. We ran it across three models, from cheaper everyday ones (MiniMax-M3 and
DeepSeek V4 Flash, capable but not frontier) up to a frontier flagship (Claude Sonnet-5),
because that split is exactly where the approaches part ways.

A note on how we got these numbers. An earlier draft of this post had competitor
results that were, frankly, too good for us: the memory tools scored a flat zero
everywhere. That looked wrong, so we ran an independent audit of our own harness and
found the cause was ours, not theirs, the competitor backends had been launched with
empty API keys and a broken binary path, so they were never actually storing anything.
We fixed it, added a guard that refuses to score a memory tool that made zero calls, and
re-ran everything. The numbers below are the corrected ones. We are telling you this
because a benchmark you cannot trust to catch its own bias is not worth reading, and the
version of these results that flattered us the most was the version that was broken.

For the record, so you can reproduce it or pick it apart: we ran this in July 2026 with
**Lore 0.37.0** driving **OpenCode 1.17.12**. The models were MiniMax-M3, DeepSeek V4
Flash, and Claude Sonnet-5 (`claude-sonnet-4-6`). The memory competitors were
[mem0](https://github.com/mem0ai/mem0) (mem0 cloud, via the official `mem0-mcp-server`)
and [mnemonic](https://github.com/Aamirofficiall/mnemonic) 2.0.2 (the `mnemonic-ai`
package), each given both a light "keep notes" instruction and a heavy mandatory-workflow
one, and we report the better of the two.

## The first tax: compaction

Put the agent in one long session and keep working until the window fills. Every major
client does the same thing at that point: it compacts, crushing the older turns into a
lossy summary and dropping the originals. That is the moment the facts you mentioned an
hour ago quietly fall out.

One thing to be upfront about, because it shapes every token number in this post: we do
not wait for a real workload to slowly fill the window. We force it, by piping a large
reference blob (roughly 40K tokens here, more in the cross-session task) into most turns.
Left to its own devices an agent keeps its context small, so a natural session might take
a very long time to overflow, or never. Compressing that into a benchmark means
manufacturing the pressure. The consequence is that the absolute token and cost figures
below are a product of that artificial fill, not a measurement of what a typical session
costs, and you should read them as *relative* comparisons between arms under identical
pressure, not as a bill you would see in normal use.

Here is that session, sixteen turns, with the four facts mentioned once near the start,
on the frontier model:

| Sonnet-5, one long session | retention | compactions | turns | cost |
|---|---|---|---|---|
| vanilla | 16% | 3 | 59 | $5.51 |
| **Lore** | **100%** | **0** | **33** | $9.96 |

Two things are happening at once. The vanilla agent compacts three times and loses five
of every six probes to it. Lore never compacts, because it manages the window on every
turn instead of waiting for it to overflow, and it keeps all four facts, in nearly half
the turns.

Note the cost column, because we are not going to hide it: Lore's run costs *more*, not
less. That number is the whole of Lore's bill, the conversation and the background
distillation that captures memory, run on the same model on the same key. The vanilla
run looks cheaper only because the thing it is not paying for is the thing it is failing
at. Compaction is not free either, it busts the prompt cache and rewrites the prefix, and
it is what drags the vanilla run out to 59 turns, but a compacting agent that loses the
facts is not a cheaper way to succeed, it is a cheaper way to fail. The honest framing is
not "Lore is cheaper." It is "Lore finishes, reliably, in far fewer turns, and you can
read its entire cost off one bill."

The pattern holds on a cheaper model, where the dollars are small enough to see the shape
plainly:

| DeepSeek Flash, one long session | retention | compactions | turns |
|---|---|---|---|
| vanilla | 0% | 3 | 49 |
| **Lore** | **100%** | **0** | **36** |

The loss is quiet, which is what makes it easy to miss. Independent research on
context rot ([Chroma's report](https://www.trychroma.com/research/context-rot), and the
[contextrot](https://github.com/Priyanshu-byte-coder/contextrot) tool that measures it on
your own sessions) shows models degrade as their window fills. Compaction does not
announce itself. The agent keeps going, confident, having quietly forgotten.

## The second tax: remembering to remember

Now the cross-session case, which is what most people mean by memory: something said in
one session, needed in a later, separate one. This is the job a memory store is built
for, so we put Lore next to two good ones:
[mem0](https://github.com/mem0ai/mem0) (cloud) and
[mnemonic](https://github.com/Aamirofficiall/mnemonic) (a local SQLite store, the
closest analogue to how Lore keeps things on your own disk).

On the frontier model, everyone with memory got it right:

| Sonnet-5, cross-session | retention |
|---|---|
| vanilla | 0% |
| Lore | 100% |
| mnemonic | 100% |
| mem0 | 100% |

That is the honest headline: a good store works, and on a capable model it works
reliably. We are not going to pretend otherwise. When we opened up what each system had
actually captured, they had all extracted the four facts correctly. This is not a case of
one tool storing better than another.

The difference shows up on the cheaper, everyday models, the kind you actually run at
scale:

| cross-session, cheaper model | retention |
|---|---|
| vanilla | 0% |
| **Lore (DeepSeek Flash)** | **83%** |
| mnemonic (DeepSeek Flash) | 25% |
| mem0 (DeepSeek Flash) | 0% |
| **Lore (MiniMax-M3)** | **~92%** |
| mnemonic (MiniMax-M3) | 40% |
| mem0 (MiniMax-M3) | 42% |

The gap is not about storage quality, we just saw the stores hold the same facts. It is
about who has to remember to use it. A store the agent drives only works if the agent
decides, on its own, to save the offhand value when it is mentioned, and then to go
looking for it later. When we traced the competitors' misses, the pattern was almost
always the same: the agent never called the save step in the first session. The backend
was fine, the tool was there, the model just did not reach for it. An everyday model does
not reliably reach. Lore does not ask it to. It captures as the conversation happens,
with a dedicated background pass that runs whether or not the coding model thinks to, and
surfaces what is relevant on its own. So it does not hang on the model's discipline on any
given turn.

That is the attention tax made concrete. Every store the agent reaches for is a store
that depends on remembering to reach, and the further a model sits from the frontier, the
less reliably it reaches.

## What the stores actually held

Because the interesting question is not just the score but what each system extracted, here
is the same fact, "every order defaults to channel WHOLESALE, region EMEA, warehouse WH-07,"
as each store captured it:

- **Lore**: *"Every order built in orderkit carries these fixed metadata fields:
  channel='WHOLESALE', region='EMEA', warehouse_code='WH-07'. These are not optional,
  always include them when constructing order objects."*
- **mem0**: *"User defines that every order in orderkit includes fixed fields: channel set
  to 'WHOLESALE', region set to 'EMEA', and warehouse_code set to 'WH-07'."*
- **mnemonic**: batched into a single note alongside the other conventions, terser, but
  the values are all there.

All three are correct. Lore's tends to carry a little more, the rationale, the "not
optional," a cross-reference to the related convention, because a background pass with a
dedicated model has room to write more than a tool call squeezed into the coding agent's
turn. It is a real edge, but a modest one. The decisive difference is not what gets
written, it is whether anything gets written at all without the agent being told to.

## What it costs, honestly

Cost is where memory tools get quiet, so here is ours out loud, and it does not flatter
us. On the cross-session run with Sonnet:

| | measured cost | third-party backend cost |
|---|---|---|
| vanilla | $4.04 | none |
| mnemonic | $3.98 | Gemini (embeddings + extraction), external |
| mem0 | $4.05–$4.33 | mem0 cloud subscription, external |
| **Lore** | **$5.86** | none |

Lore is the most expensive line, and we want to be precise about why, because it is not
the reason you might guess. It is not cache-write churn, both arms write essentially
nothing to cache. It is two honest things. First, Lore's number is the *whole* bill: the
conversation plus the background distillation that does the capturing, all on the same
model and the same key. Roughly a third of that Sonnet figure is the background worker,
work the other tools also do but bill somewhere you cannot see. Second, Lore injects the
relevant memory into the working context, so each turn carries a little more than a bare
run would.

The competitors' lines are cheaper on paper only because part of their cost is missing
from the page. mnemonic's fact extraction and embeddings run on Gemini; mem0 runs on a
hosted subscription. Those are real charges you cannot read off your model spend, so the
"third-party" column is an unknown, not a zero. mem0's is a flat monthly fee, which means
its marginal per-run cost is near nothing if you are already paying it, and a whole plan
if you are not. Either way, it is not on the bill we can show you.

Two of Lore's costs above are also higher in this benchmark than they would be for you in
practice, and we would rather adjust for that openly than quietly bank the flattering
number. First, the background distillation ran on the same frontier model as the
conversation, because this harness pins one model per run; in normal use you point the
worker at a cheap model, which works on any provider and cuts that bucket by roughly ten
times. Second, if you run Lore directly against Anthropic or OpenAI, those background
worker calls go through their Message Batches API at half price; this harness disables
batching because it has to finish distilling before it can probe the next session, and it
routes through OpenRouter, which has no batch API anyway. Putting the worker on a cheap
model alone brings Lore's Sonnet run to roughly **$4.2**, a hair over vanilla for a run
that actually keeps the facts; a direct-Anthropic user batching the worker would land
lower still.

So we will not claim Lore is cheaper on the raw benchmark number, because there it is not.
What we will claim is narrower and true: Lore's cost is *entirely visible and lives on one
bill*, the biggest thing inflating it here (a frontier-priced worker) is a config choice
you would not make in practice, and even at the harness's worst-case number it buys
reliable retention where the cheaper alternatives drop it, in fewer turns. You are paying
a bit more to not think about any of it, and to be able to account for all of it.

## What we are not claiming

The benchmark has limits and we would rather say them than have you find them.

Start with the most obvious one: we built Lore, we designed this benchmark, we ran it,
and Lore comes out on top. That is a conflict of interest and you should read the numbers
with it in mind. The best evidence we can offer that we took it seriously is the audit we
mentioned up top: our first cut had the competitors at a flat zero, we did not like how
good that looked for us, we dug in, and the zero turned out to be our bug, not their
failure. We fixed it and the competitors climbed to a tie on the frontier model. We still
almost certainly did not tune mem0 or mnemonic as well as their own authors would. If you
maintain one of these tools and we got your configuration wrong, tell us and we will
re-run it and update the numbers.

We also could not measure the competitors' third-party backend costs, so their totals are
visible cost plus an unknown, not a full accounting. The reliability gap on cheaper models
is real, but on the frontier model it closes to a tie, and we showed that rather than bury
it. The cheaper-model numbers are not clean 100%s either: individual runs drop to zero
when the model invents its own defaults even with the right values in front of it, the
same way a model can ignore any instruction you give it. That is a ceiling no memory layer
lifts, and we kept those runs in the averages rather than trim them. We also excluded, on
every arm, runs where a memory tool made zero calls, because a tool that was never invoked
tells you nothing about the tool. And we could not evaluate Lore on an anonymous free
endpoint, because its background worker needs a real key to run.

And, as said above, the window pressure is manufactured: we pipe large reference blobs
into most turns to force compaction on a benchmark timescale. That makes the token and
cost totals artifacts of the harness, not a forecast of your bill. It is why we lean on
the ratios between arms, run under the same forced load, rather than the raw numbers.

All of it, the tasks, the scorer, the raw per-run numbers, is in the repo. Run
`lore eval` and check our work.

## Back to the one question

We ended the first post with a question to ask anything sold to you as agent memory:
**what happens at 200K tokens?** Now there is a number attached. What happens is the
client compacts, you lose most of what mattered, and it takes more turns to get there. A
store on the sidelines does not change that, however good the store is, because it never
runs at the moment of overflow. Managing the window in the loop does, and you never have
to think about it.

That last part is not hypothetical. Building this benchmark already changed the product
twice. First, an early cut showed cheaper models dropping the incidental facts even when
Lore had captured them perfectly, the facts were in memory, just not reliably in front of
the model when it mattered, so we changed Lore to fold a session's own distilled memory
into the working context automatically, the moment it is written. Then the audit itself
surfaced a real bug on our own side: on one model our background worker was silently
failing to extract anything, the mirror image of the competitor problem we had just fixed.
We fixed that too. The benchmark did not just score the product. It kept telling us where
it was broken.

We have claimed that memory is table stakes and that the real value lies in active
context management. This is the shape of the evidence: on a frontier model, a good store
ties us, and the win narrows to fewer turns and a bill you can fully account for. On the
cheaper models people actually run at scale, the win is retention itself, because those
models do not reliably remember to use a store they have to drive by hand, and Lore does
not make them. We could always _feel_ that difference. Putting a test around it, and being
honest when the test caught us, is how we get to keep improving it.
