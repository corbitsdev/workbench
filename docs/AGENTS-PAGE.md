# Settings · Agents

Settings · Agents (`apps/web/src/pages/agents-settings-section.tsx`) is a
bench's one surface for its agents: the definitions a person can launch
from, and the instances currently running from them. It is a Settings
section, not a rail destination (CL-5990) — agent definitions are the only
thing this surface manages; talking to an agent is a chat (Start chat), and
looping one into a conversation is a workbench mention.

## Definitions and instances

A **definition** (`workflow_definition`) is a reusable template: a name, an
optional description, a system prompt, and (optionally) a model, folded into
a single-step workflow asset. A definition's status is `deployed`
(launchable) or `stopped`.

An **instance** (`workflow_run`) is a live launch of a definition — a
running agent with its own mailbox address. An instance's status is one of
`deployed`, `running`, `updating`, `error`, or `stopped`, exactly the
vocabulary `GET /api/tenants/:tenantId/workflows/runs` reports.

The page lists both in one place, as two tabs sharing one search box and one
grid/table view toggle. An instance whose `definitionId` does not resolve
against the tenant's own definitions listing is marked **Unlinked
definition** rather than hidden — the page never silently drops a row it
cannot fully explain.

Every list excludes legacy workbench-host definitions
(`@corbits/chat/workbench-host-naming`'s `isWorkbenchHostDefinitionName`):
pre-CL-6330 databases may still carry those rows, and they were internal
plumbing, not agents a person created.

## Creating an agent

The "Create agent" action opens a form for identity (name, handle,
description) and definition (system prompt, model) and posts to
`POST /api/tenants/:tenantId/agent-definitions`, added by
`@corbits/agent-directory`. The route:

1. Builds a single-step, folded workflow definition from the submitted
   fields (`buildAgentDefinitionWorkflow`) — the same shape
   `@corbits/assistant-workflow` and `@corbits/chat`'s workbench host produce,
   parametrized instead of fixed — and renders it as a source codebase
   (`@corbits/workflow-source`'s `renderWorkflowSourceTree`), never a bare
   `workflow.json` envelope. `workflow.json` is retired; nothing writes it.
2. Creates a `workflow`-kind asset and writes that source tree into it
   in-process (`AssetService.populateAsset` — no git subprocess), which
   produces a commit.
3. Deploys that commit through Interchange's native source pipeline
   (install -> sidecar probe -> gate -> freeze) via the same
   `WorkflowDeployer` `@corbits/agent-workflow-authoring`'s
   agent-authored-workflow registry calls, which projects the first-class
   `workflow_definition` row over the asset (CL-7363).

The definition lands with the schema's default status (`deployed`) and a
materialized asset, so it is immediately invitable and launchable — no
separate deploy step, and no page reload needed to see it appear. Every
subsequent edit (instructions, model, tools, skills, restore) writes a new
commit and redeploys the same way; a definition frozen before CL-7363
stays launchable as-is and only redeploys through the native pipeline on
its next edit — no data migration.

A deploy that finds no connected sidecar fails the write outright (502,
`unavailable`) rather than falling back to the old bare-freeze path — no
fallback, per this repo's ground rules.

**Tools and a model provider are not exposed on the create form.** The
platform's wire contract for a workflow definition
(`WorkflowDefinitionResponse` in `@intx/types`) carries no tool-package
field, and `@intx/agent`'s `defineAgent` does not accept a caller-supplied
`toolPackagePins` on its authoring-time config — it is vendored, read-only
source. The five catalog workflow packages (`granola-call`,
`process-granola-call`, `morning-brief`, `pain-point-collateral`,
`collateral-generation`) build their `AgentDefinition`s directly against
that type instead, and do set `toolPackagePins` (CL-5999) — but this
create-form path is unrelated to those packages and still has no field to
carry one. A model is accepted as a bare canonical name only; the provider
is resolved fresh against the tenant's catalog at launch time
(`resolveDefinitionSources`), never baked into the definition.

## The mailbox address

An instance's mailbox address (`WorkflowRunResponse.address`) is never
rendered as visible text on this page. It is reachable only through a
"Copy address" control that writes it to the clipboard.
