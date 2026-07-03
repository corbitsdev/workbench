# @workbench/tools-workflows

Workflow-run control tools for chat agents (`workflow_start`,
`workflow_list_runs`, `workflow_signal`). Hub-backed: the tool definitions
live here, but execution happens hub-side against the workflow run records
and the sidecar supervisor (the same `startWorkflowRun` / `resumeWorkflowRun`
service logic the `/workflow-exec` HTTP routes use).

- **Keyless** — no provider credential and no `seed-credentials` entry. The
  native `interchange.tools` factory (`defineHubBackedToolPackage`) declares
  the hub-RPC context as its only `requires` entry and forwards every call to
  the hub's scoped `/api/internal/hub-tools/run` endpoint, which authorizes
  against the agent definition's declared capabilities.
- `workflow_start` threads the calling conversation (the caller's Myra
  thread, resolved hub-side from the instance principal) into the run record
  as `originConversationId`, so chat-dock filtering works without the model
  supplying an id.
- `workflow_list_runs` is scoped to the calling member's own runs and, by
  default, to the current conversation (`allConversations: true` widens it).
- `workflow_signal` resolves a pending gate via the shared resume path
  (owner-gated; payloads validated by the resume-payload registry).

Hub execution lives in `apps/hub/src/tools/workflow-run-tools.ts`
(`HUB_BACKED_TOOLS`).

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
