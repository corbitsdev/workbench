# Workflow Workbench Feedback

## Context

This feedback responds to the idea of a workflow mode with a published input schema, published output schema, no chat interface, and only workflow status/progress UI.

The current `m6-workflow-runtime` branch already points in this direction: workflows are deployed as git-backed `@intx/workflow` assets, the hub stays workflow-agnostic, and the sidecar supervisor executes `workflow.json` rather than app-specific hub code. The adjacent asset substrate work should improve the durable identity story for workflow outputs and artifacts.

## Recommendation

Yes, this is a good direction, but it should be framed as a workflow product surface, not a replacement for the agent/chat runtime.

A chatless workflow surface should be a first-class contract layered on the workflow runtime: form input, status/progress, human gates, and typed outputs. Agents and chat can still exist inside individual steps, but the user-facing mode does not need to expose a chat transcript.

## Why It Fits

- The current branch already treats workflows as git-backed assets, not hub code.
- The hub deploy path is generic: callers push a serialized workflow definition, the hub validates it, resolves deploy config, and hands it to the workflow deploy orchestrator.
- The sidecar runtime already has the execution primitives needed for a status-only UI: step execution, event logs, awaitable human gates, output refs, and terminal status.
- Interchange workflow definitions already model inputs and outputs internally through selectors, step output materialization, and event-sourced run state.
- Asset substrate work should make workflow outputs better suited for durable references rather than ad hoc raw content fields.

## Main Missing Contract

The missing piece is not simply removing chat. The missing piece is publishing workflow invocation and observation contracts:

- Input schema
- Output schema or artifact schema
- Status vocabulary
- Current-step/progress model
- Awaited signal schema
- Error shape
- Output artifact refs or asset IDs
- Display metadata for generic UI rendering

Without these contracts, a chatless UI will become another set of workflow-specific branches in the app.

## Sequencing

This should land after the asset substrate work.

The asset substrate branch moves artifact bodies into git-backed content repos and changes how workflow/artifact storage behaves. A status-only workflow UI should not bind tightly to transitional artifact tables or raw content columns that are about to move. It should return stable asset IDs/refs and let the artifact substrate own content retrieval/versioning.

Suggested sequence:

1. Land the workflow runtime/deploy substrate.
2. Land the asset substrate migration.
3. Define a package-owned workflow contract shape beside `defineWorkflow(...)`.
4. Add generic hub run APIs that validate input and expose status/output refs.
5. Build the chatless UI from workflow metadata and runtime state, not workflow-specific React code.

## Strong Objections

- Do not let each workflow invent its own status model in the web app. Status should derive from the workflow runtime/event log plus package-owned metadata.
- Do not expose arbitrary `unknown` step output as the public output schema. Public output should be an authored, validated projection of the terminal result.
- Do not encode product workflow rules in `apps/web` or `apps/hub`. Domain-specific schemas, labels, artifact kinds, and business rules belong in packages.
- Do not make chatlessness mean no human-in-the-loop. The runtime's `awaitSignal` gates are exactly the right primitive for approvals, selections, and review checkpoints.
- Do not treat this as a fully automated pipeline. The product constraint is still human-in-the-loop workflows.

## What To Build Next

Add package-level workflow metadata beside each `defineWorkflow(...)` export, for example:

```ts
export const contract = defineWorkflowContract({
  kind: 'collateral-generation',
  inputSchema,
  outputSchema,
  signals,
  display,
  artifactKinds,
});
```

Add generic hub APIs along these lines:

- `POST /api/v1/workflow-runs/:kind` validates the request body against the workflow input schema and starts a run.
- `GET /api/v1/workflow-runs/:id` returns status, current step, awaited signal, progress, output refs, and terminal result.
- `POST /api/v1/workflow-runs/:id/signals/:name` validates a human signal payload and resumes the run.

The response shape should be stable and generic enough for all workflows:

```ts
type WorkflowRunView = {
  id: string;
  kind: string;
  status: 'queued' | 'running' | 'awaiting_signal' | 'completed' | 'failed' | 'cancelled';
  currentStep?: string;
  awaitedSignal?: {
    name: string;
    schema: unknown;
    display?: unknown;
  };
  outputs?: {
    schemaVersion: string;
    value?: unknown;
    artifacts?: Array<{ assetId: string; kind: string; title: string }>;
  };
  error?: { message: string; code?: string };
};
```

## Product Shape

The resulting UX can be:

1. Pick a workflow.
2. Fill a typed intake form generated from the workflow input contract.
3. Start the run.
4. Watch status/progress derived from the runtime event log.
5. Respond to human gates when the run awaits a signal.
6. Review/export typed outputs and artifact refs.

Chat remains optional. It can still be useful for exploratory or corrective interaction, but it should not be required for workflows whose inputs, gates, and outputs are known upfront.

## Bottom Line

I am positive on the idea. It matches the direction of the workflow runtime branch and becomes much cleaner after the asset substrate work lands.

The key is to make published schema plus status a first-class workflow contract layered on the runtime, not a bespoke shortcut around chat.
