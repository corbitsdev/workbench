# Choosing models by concept

An agent asks for a model by what the work needs. It never names one.

A model named from memory is a guess about a bench the agent cannot see —
the bench may not have that model, may not be able to reach it, or may not
be willing to pay for it. A **concept** names a kind of work instead, which
is a question this bench can answer from its own connected providers, its
own capability data, and its own prices.

The answer is always a **chain**: the models this bench can reach for that
work, cheapest first, with fallbacks behind the head. Never a single model —
one model is not a fallback plan.

## The vocabulary

Ceilings are USD per million tokens, input and output separate. The mix is
the reference workload that defines "cheapest" for that concept: an
input-heavy concept ranks a model that is cheap on input first.

| id                   | when to use                                                   | requires                                                        | ceiling in / out | mix in / out |
| -------------------- | ------------------------------------------------------------- | --------------------------------------------------------------- | ---------------- | ------------ |
| `cheap-loop`         | A step that runs hundreds of times: classify, tag, route.     | `plain-text`                                                    | 0.30 / 1.00      | 1 / 0.05     |
| `bulk-extraction`    | Pull fields out of a pile of documents into a fixed shape.    | `plain-text`, `structured-output`                               | 0.60 / 2.50      | 4 / 0.10     |
| `long-document`      | Read something very large end to end and answer about it.     | `plain-text`                                                    | 3.00 / 12.00     | 10 / 0.25    |
| `judgment-heavy`     | Hard calls where being right matters more than being cheap.   | `plain-text`, `reasoning-content`                               | 6.00 / 30.00     | 1 / 1        |
| `everyday-assistant` | Live chat with a person, using tools as it goes.              | `plain-text-streaming`, `function-calling-multi-turn-streaming` | 3.00 / 15.00     | 2 / 0.5      |
| `agentic-workhorse`  | Multi-step tool work run unattended to completion.            | `function-calling-multi-turn`, `structured-output`              | 3.00 / 15.00     | 3 / 1        |
| `deep-tool-reasoner` | Long autonomous work where a wrong tool call is expensive.    | `function-calling-with-thinking`, `reasoning-content`           | 8.00 / 40.00     | 3 / 1        |
| `code-work`          | Read, write and run code against a repository.                | `function-calling-multi-turn`, `structured-output`              | 4.00 / 20.00     | 5 / 1        |
| `image-reader`       | Screenshots, scans, diagrams — describe or extract from them. | `vision-input`, `plain-text`                                    | 3.00 / 12.00     | 2 / 0.25     |
| `image-maker`        | Produce a picture rather than words.                          | `image-output`                                                  | 2.00 / 10.00     | 1 / 0.5      |
| `voice-in`           | Take spoken input — a recording or a live call.               | `audio-input`                                                   | 2.00 / 10.00     | 2 / 0.5      |
| `fresh-facts`        | Answers that must reflect the world right now, with sources.  | `grounding`, `plain-text`                                       | 4.00 / 16.00     | 2 / 0.5      |

`code-work` prefers `code-execution` rather than requiring it: requiring it
would exclude most relay deployments, which can still read and write code
perfectly well.

`long-document` requires only `plain-text` because the capability that
expressed "handles a huge input" — `long-context` — is baked onto catalog
offerings but is not in `@intx/types`' storable capability vocabulary, so
nothing can filter on it. Its 10M-token reference mix carries that meaning
instead: it ranks the model that is cheap on enormous inputs first, which is
the decision the capability was standing in for. When the vocabularies
converge, `long-context` moves into `requires` and this paragraph goes away.

## How a chain is resolved

1. **The need.** A concept id, or a bare capability set. An unknown concept
   is an error naming the real ones — never a silent fall back to "anything".
2. **What this bench can reach.** The tenant-visible offerings (inheritance,
   shadowing and disable-cascade already applied by the platform) whose
   provider has a credential.
3. **Capability filter.** The offering must advertise every capability the
   concept requires — the same predicate the platform's own source
   resolution uses, so a chain resolved here is never rejected downstream.
4. **Bench policy.** Deny first, then allow (which applies only when
   non-empty). Entries match an exact model name, `provider:<name>`, or
   `<provider>/<model>`.
5. **Price.** The active `model_pricing` row at the resolving instant,
   normalized to USD per million tokens. A missing or partial row is
   unknown, never zero.
6. **Ceilings.** Soft by default: an over-ceiling model is flagged and sorted
   last, not dropped, so a bench whose only provider is expensive still gets
   an answer. A bench can set its own ceiling hard, which excludes instead.
7. **Order.** Within each bucket — priced-and-within, priced-and-over,
   unpriced — cheapest first for the concept's mix, then catalog priority,
   then model name, provider name, and offering id, the same tiebreakers the
   settings UI and the workbench-creation default already use.
8. **Provider preference, then diversify.** A bench that pins providers keeps
   only those; a bench that prefers them fronts them. If every entry that
   survives shares one provider and another provider qualifies, the last slot
   goes to it — a one-provider chain is not a fallback chain.

An empty chain comes back empty, with the reason each candidate was
excluded. Nothing is substituted in to avoid answering "nothing here can do
that".

## What a bench can set

`inference_catalog.bench_model_policy`, one row per bench, all of it
optional:

- `allow` / `deny` — selector lists.
- `maxInputUsdPerMTok` / `maxOutputUsdPerMTok` — the bench-wide ceiling.
- `ceilingIsHard` — whether that ceiling excludes or merely demotes.
- `conceptCeilings` — raise or lower one concept's ceiling without forking
  the vocabulary.
- `providerPreference` — `pin` or `prefer`, the platform's own shape.

A bench with no row is unconstrained. That is deliberate: a freshly
connected bench with one provider gets a working chain with no configuration
at all.

## The tools

`@corbits/catalog-tools` publishes three read-only tools onto the agent:
`list_model_concepts`, `pick_models`, and `estimate_run_cost`. None of them
accepts a model name. They reach `@corbits/inference-catalog`'s
run-authenticated surface at `/api/workflow-inference-catalog`.

## Where capability data comes from

Every offering workbench seeds now carries the capabilities the pinned
catalog observed for that deployment — see
[model-seeding.md](model-seeding.md). A deployment the catalog has never
probed (a local Ollama model, an open-weight relay) is seeded with an empty
list and is therefore invisible to concept resolution, which is the honest
state: a guessed capability routes real work to a model that cannot do it.
