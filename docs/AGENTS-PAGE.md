# The Agents page

The Agents page (`apps/web/src/pages/agents-page.tsx`) is a bench's one
surface for its agents: the definitions a person can launch from, and the
instances currently running from them.

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

Every list excludes the chat surface's channel-host machinery
(`@corbits/chat/channel-host-naming`'s `isChannelHostDefinitionName`): a
channel's anchor run is internal plumbing, not an agent a person created.

## Creating an agent

The "Create agent" action opens a form for identity (name, handle,
description) and definition (system prompt, model) and posts to
`POST /api/tenants/:tenantId/agent-definitions`, added by
`@corbits/agent-directory`. The route:

1. Builds a single-step, folded `workflow.json` from the submitted fields
   (`buildAgentDefinitionWorkflow`) — the same shape
   `@corbits/assistant-workflow` and `@corbits/chat`'s channel host produce,
   parametrized instead of fixed.
2. Creates a `workflow`-kind asset and writes that JSON into it in-process
   (`AssetService.populateAsset` — no git subprocess).
3. Projects a first-class `workflow_definition` row over the asset
   (`ensureWorkflowDefinitionForAsset`).

The definition lands with the schema's default status (`deployed`) and a
materialized asset, so it is immediately invitable and launchable — no
separate deploy step, and no page reload needed to see it appear.

**Tools and a model provider are not exposed on the create form.** The
platform's wire contract for a workflow definition
(`WorkflowDefinitionResponse` in `@intx/types`) carries no tool-package
field, and `@intx/agent`'s `defineAgent` does not thread a caller-supplied
`toolPackagePins` onto the built definition — no production builder in this
codebase sets one today. A model is accepted as a bare canonical name only;
the provider is resolved fresh against the tenant's catalog at launch time
(`resolveDefinitionSources`), never baked into the definition.

## The mailbox address

An instance's mailbox address (`WorkflowRunResponse.address`) is never
rendered as visible text on this page. It is reachable only through a
"Copy address" control that writes it to the clipboard.
