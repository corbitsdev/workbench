# Workbench — Positioning

Workbench's identity is horizontal. This document is the canonical statement of
what the product is, what category it plays in, and what the GTM workflow family
is (and is not) to that identity. Product copy, docs, and architecture decisions
should not contradict it.

## What Workbench is

**Workbench is an agentic workspace: the place a team puts AI to work on its own
evidence, safely.**

Three parts, one surface:

1. **AI teammates** — personal (Myra) and shared (Oat, others) agents with
   identities, inboxes, grants, and provenance: the same multiplayer physics as
   people.
2. **The team's evidence** — captured as a side effect of work the team already
   does (mail, calls, tasks, artifacts, connected tools). Answers are cited or
   silent. External systems stay the systems of record.
3. **One action surface** — everything that needs a human lands in one place and
   is decidable in place. Nothing external executes without sign-off.

The product is the combination. Remove any leg and it collapses into an existing
category: agents without evidence are generic copilots; evidence without action
is enterprise search; action without supervision is an autonomy pitch this
product deliberately refuses to make.

## Category and point of view

Category: **agentic workspace** (equivalently, "AI teammate workspace").
Horizontal by design — nothing in the inbox, agents, grants, workflows, or
evidence substrate is vertical-specific.

The narrative:

1. **The bottleneck for AI at work is trust, not intelligence.** Autonomous
   agents fail in business settings because nobody can let software talk to
   customers or touch the CRM unsupervised.
2. **Assistants fail for the opposite reason: they know nothing.** A copilot
   without the team's calls, deals, and promises produces generic drafts people
   rewrite anyway.
3. **The missing product is a workplace, not a smarter agent.** A shared surface
   where AI teammates and humans operate on the same evidence, under the same
   permissions, with human sign-off exactly where money and reputation are at
   stake.

Each buyer-facing claim is backed by architecture that already exists or is on
the locked roadmap:

| Claim                      | What backs it                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| AI teammates, not tools    | Agents have inboxes, identities, grants, provenance — the same multiplayer physics as humans  |
| They know _your_ business  | Evidence captured as a side effect of working; answers cited or silent                        |
| They never act without you | HITL execute and approval gates on every external side effect — the trust rail is the product |
| Your data stays yours      | BYO LLM keys, owner-plugged self-host inference endpoints, sources stay systems of record     |

## What GTM is in this picture

**The first workflow pack and the current go-to-market wedge — not the
identity.**

- The call-to-collateral pipelines are one family of deployed workflows on a
  generic substrate: proof the model works, demoable, with a named budget owner.
- Different teams get different workflow packs on the same workbench. The
  substrate (inbox, agents, grants, evidence, workflows) is the product; packs
  are content.
- Go-to-market may stay GTM-first for as long as it converts. Product docs,
  naming, and architecture must not encode GTM as identity.
- The monorepo name (`gtm-workbench`) is deliberately left unchanged — renaming
  it is infra churn, not identity.

## What Workbench is not

- Not a vertical GTM tool (GTM is a pack).
- Not enterprise search or a wiki (no browse-first knowledge surface).
- Not an autonomy platform (external side effects are HITL by doctrine, not by
  limitation).
- Not a data lake (evidence is projected, not dumped; sources stay systems of
  record).
- Not a vendor SKU (external engines and papers are cited design sources, never
  product brands).

## One-liner

> **Workbench — AI teammates for your team. They know your business, they
> prepare the work, and nothing goes out without you.**

Wedge-specific variants may substitute the audience ("…for your GTM team")
without changing the identity.
