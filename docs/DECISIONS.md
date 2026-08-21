# Product decisions

Rulings the owner has made that are not derivable from the code, and that
have been re-litigated more than once. Read this before building anything in
these areas. A decision here overrides an inference from the existing code:
if the code disagrees with a row below, the code is the thing that is wrong.

Add a row when the owner decides something that a future contributor would
otherwise get wrong. Keep each row short enough to read in full.

## Search

**The top-bar search filters the current page. `Cmd+K` is the global command
palette. They are separate things.**

The magnifier in the stage top bar searches within whatever page you are on —
Files filters files, Skills filters skills. `Cmd+K` opens the global palette
that reaches workbenches, people, actions and pages. Do not merge them, and do
not make one open the other.

## Routines

**A routine delivers into a workbench the person selects.**

The destination is chosen when the routine is created, and is editable
afterwards. Never auto-create a delivery workbench, and never name one after
the routine. If a selected destination no longer exists, ask for a new one
rather than minting a replacement.

**A routine that cannot run yet offers setup, not "Run now".**

When a routine's tools need connectors or keys that are not connected, say
what is missing in the person's words and lead into the connect flow. A
control that is going to fail should not be rendered.

## Agents

**Jimmy is an agent, not a workbench template.** He is added to a bench, and
ideally available in every bench. Due diligence, by contrast, is a template
like code review, and Scout is its participant.

## Chat

**A person's own messages align right; everything else aligns left.** This is
per viewer — the same message is right-aligned for its author and
left-aligned for everyone else in a shared bench. Alignment only; this is not
a return to chat bubbles.

## First run

**A brand-new tenant has everything it needs on first sign-in.** Not on a
later visit, not after a retry. Provisioning either completes or fails
loudly; a half-provisioned tenant that looks fine until the first click is
the defect, and reconciling on a later sign-in is a safety net rather than
the answer.

## Setup

**There is one setup path, and it is easy.** No demo mode, no demo-only
seeds, no branch that exists to make a demonstration look good. Local
convenience flags must be impossible to inherit into a real deployment rather
than relying on an operator to strip them.

## Workflows

**Workflows are code, and they live in the hub's git-backed store.** Agents
author workflow source, it is stored in `RepoStore`, and it deploys from
there under the agent's own grants. Everything runs on Interchange's workflow
runtime — where `@intx/*` already provides something, workbench consumes it
rather than reimplementing it.

## Scale of change

**Less is more.** Prefer removing a concept to adding one. A smaller change
that genuinely works beats a larger one that is partly wired, and a rule that
a check enforces beats a rule written down and hoped for.
