# Product

Workbench gives you a place to work with an AI co-worker that gets things
done through tools. Create a workbench and it comes with its own persistent
worker. You message it; it does the work.

## A workbench and its worker

Every workbench mints one worker, deployed through the stock deploy route.
There is no user-level agent following you from bench to bench, and no
template to pick: one starting point.

The worker opens as a new co-worker. Its first message greets you by name,
lists what it can do, and invites you to name it, or it picks a name of its
own. It then asks setup questions and offers capabilities from what exists
(a skill, a workflow, a connected service) and installs them in the
conversation once you approve.

## The harness

`packages/worker` is the default harness: the one definition package a
bench's worker, and any agent Workbench creates, deploys on. It carries a
small fixed tool set (mail, a working tree, artifacts, memory) and calls no
hub routes itself. A named agent appears only when an installed
package names it.

## Tools and skills

Capabilities come from `@corbits/*` tool and skill packages: connecting a
mail account, searching the web, running a scheduled digest. Anyone can
author a new one; the worker reuses an existing capability before
duplicating it. Write tools start ask-gated, and every approval is yours:
allow once, always allow (this workbench, this tool), ask every time, or
deny.

## Two tool surfaces

- **The worker is static.** It carries the harness's fixed set. Complex
  work goes to agents it creates rather than a growing tool list.
- **Created agents are granular.** An agent carries exactly the MCP servers
  its job needs, so every remote tool is its own approval decision.

## MCP

The workspace has one MCP catalog: connect a server in Tools (Exa is there
from day one, keyless) and its tools become callable like any native
`@corbits/*` tool, with no separate integration per server. Credentials are
connected once at the workspace and walk down to benches; grants never
inherit.

## Conversation

Talking to your worker, or to a teammate, is an ordinary mail thread. What
you send lands in an inbox; what the worker does happens through approvals
you can see. Scheduled runs post a compact brief in the thread with the full
artifact attached.
