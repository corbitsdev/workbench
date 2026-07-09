# Source-to-Artifact Workbench Contract

## Purpose

The workbench needs to support many GTM workflows without turning the product
into a workflow builder. Users should bring source material, choose an outcome,
review the decisions that matter, and approve usable artifacts. The system can
compose ingestion, analysis, generation, refinement, and delivery steps behind
the scenes, but the primary UI must stay outcome-oriented.

Core product rule:

> Users choose outcomes, not pipeline topology.

This contract defines the Workbench-level domain model. It does not define a new
workflow runtime. Interchange owns deployable workflow execution, durable runs,
grants, audit, persistence, signals, timers, retry, and child workflows.
Workbench owns intent, source selection, review surfaces, artifact presentation,
and delivery affordances.

## Ownership Boundary

| Concept     | Workbench owns                                                         | Interchange owns                                             |
| ----------- | ---------------------------------------------------------------------- | ------------------------------------------------------------ |
| Source      | Product meaning, selection UX, normalized metadata, provenance display | Durable storage and asset/reference substrate when available |
| Workflow    | Offering metadata and user-facing outcome                              | Deployable workflow definition and execution semantics       |
| Job         | User-facing run/session, current review gate, visible status           | Durable `workflow-run` state machine and event log           |
| Review gate | Human decision UX, validation copy, approved corrections               | Signals, gates, state transitions, persistence               |
| Artifact    | Output UX, versions, packages, approval state, reuse as source         | Artifact storage/reference substrate when available          |
| Hook        | Delivery affordance and status display                                 | Capability grants, credential access, execution audit        |

Workbench must not invent a second authz model, packaging model, node-graph
builder, or durable workflow engine.

## Canonical Terms

### Source

A Source is input material selected for a Job.

Examples:

- transcript
- markdown positioning document
- uploaded text or document
- brain/context file
- URL or web capture
- prior Artifact reused as input

Sources are inputs. They are not outputs, even when their content originated
from a previous workflow.

V1 storage rule: Workbench may store display and query metadata needed for the
user experience, such as title, kind, origin, extracted preview, and provenance
labels. Canonical content storage should stay behind `contentRef` and move to
the Interchange asset/reference substrate when available. Workbench should avoid
making its own long-lived content store the source of truth.

Minimum shape:

```ts
type SourceKind =
  | "transcript"
  | "markdown"
  | "document"
  | "brain-file"
  | "url"
  | "artifact";
type JsonSchemaRef = string;

interface Source {
  id: string;
  kind: SourceKind;
  title: string;
  origin: "user-upload" | "paste" | "integration" | "generated-artifact";
  contentRef: string;
  artifactId?: string;
  metadata: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
```

If an Artifact becomes useful input for another Job, the system creates or
selects a Source reference whose `kind` is `"artifact"` and whose `artifactId`
points back to the original output. The Artifact keeps its output identity,
version history, and provenance.

### Workflow Contract

A Workflow Contract is the Workbench-facing contract for a reusable recipe. It
describes how a workflow appears to users and what Workbench surfaces it needs.
It is not an executable workflow definition. It points to a deployed workflow
definition owned by the Interchange runtime (the native `@intx/workflow`
definition deployed via the admin CLI's **Local actions → Push a workflow**; see DEPLOYING_WORKFLOWS.md).

Examples:

- Call to collateral
- Markdown to GTM content
- Brain files to campaign package
- Transcript to pain point brief

Minimum shape:

```ts
interface WorkbenchWorkflowContract {
  id: string;
  title: string;
  description: string;
  acceptedSourceKinds: SourceKind[];
  requiredOptions: WorkflowOption[];
  optionalOptions: WorkflowOption[];
  reviewGates: ReviewGateDefinition[];
  outputArtifactKinds: string[];
  hookKinds: string[];
  runtimeRef?: string;
  createdAt: string;
  updatedAt: string;
}
```

Use `runtimeRef` only as a reference to the actual executable workflow. Execution
semantics, durable state, retries, signals, timers, grants, audit, and child
workflows remain Interchange-owned.

### Workflow Option

A Workflow Option is a user-facing configuration field required or accepted
before a Job starts. Options are how Workbench gives users control without
showing internal steps.

Examples:

- output artifact kinds
- audience
- brand voice source
- tone
- destination hook preference

Minimum shape:

```ts
type WorkflowOptionKind =
  | "single-select"
  | "multi-select"
  | "text"
  | "boolean"
  | "source-picker"
  | "hook-picker";

interface WorkflowOption {
  id: string;
  kind: WorkflowOptionKind;
  label: string;
  description?: string;
  required: boolean;
  defaultValue?: unknown;
  choices?: Array<{ label: string; value: string }>;
  validationSchema?: JsonSchemaRef;
}
```

Required options should be limited to decisions the workflow cannot safely infer.
Optional options should stay behind a secondary affordance so workflow launch
does not become a configuration form.

### Offering Suggestion Rule

An Offering Suggestion Rule describes when Workbench should recommend an
Offering from selected Sources and context.

Minimum shape:

```ts
interface OfferingSuggestionRule {
  id: string;
  sourceKinds?: SourceKind[];
  requiredMetadataKeys?: string[];
  contextKeys?: string[];
  confidence: "low" | "medium" | "high";
  reason: string;
}
```

Suggestion rules should explain why an Offering is relevant in product language,
for example: "This looks like positioning material, so Workbench can create GTM
content from it."

### Offering

An Offering is the product-facing wrapper around a Workflow. It is what appears
in the Workbench catalog, rail, command menu, or contextual suggestions.

Examples:

- Create sales collateral
- Extract pain points
- Draft LinkedIn posts
- Turn brain files into a campaign package

Minimum shape:

```ts
interface WorkflowOffering {
  id: string;
  workflowId: string;
  title: string;
  description: string;
  acceptedSourceKinds: SourceKind[];
  suggestedWhen: OfferingSuggestionRule[];
  requiredOptions: WorkflowOption[];
  optionalOptions: WorkflowOption[];
  outputArtifactKinds: string[];
  createdAt: string;
  updatedAt: string;
}
```

The UI should suggest Offerings based on selected Sources and available context.
It should not expose raw steps such as summarize, extract, generate, humanize,
and post as the normal launch experience.

### Job

A Job is one execution of a Workflow Contract with selected Sources, options,
state, and outputs. A Job is a session/run, not the reusable recipe.

Minimum shape:

```ts
type JobStatus =
  | "queued"
  | "running"
  | "waiting-for-review"
  | "generating"
  | "delivering"
  | "done"
  | "failed"
  | "canceled";

interface Job {
  id: string;
  workflowId: string;
  offeringId?: string;
  runtimeRunRef?: string;
  status: JobStatus;
  currentReviewGateId?: string;
  sourceIds: string[];
  artifactIds: string[];
  options: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
```

When backed by Interchange, `runtimeRunRef` points to the durable workflow run.
Workbench displays the Job and review gates; Interchange executes and resumes
the run.

### Review Gate

A Review Gate is a human decision point in a Job. It is the product-safe way to
expose control without showing workflow topology.

Common gate types:

- source confirmation
- extracted findings review
- pain point selection
- content option selection
- brand voice confirmation
- artifact approval
- delivery confirmation

Each Review Gate must declare or map to a known renderer pattern. Renderer kinds
keep dynamic workflows from becoming bespoke UI for every flow.

Suggested renderer kinds:

- `source-confirmation`
- `finding-selection`
- `content-option-selection`
- `artifact-approval`
- `voice-refinement`
- `delivery-confirmation`
- `status-only`

Minimum shape:

```ts
type ReviewGateStatus =
  | "pending"
  | "active"
  | "approved"
  | "rejected"
  | "skipped";
type ReviewGateAction =
  | "approve"
  | "reject"
  | "edit"
  | "select"
  | "skip"
  | "continue";

interface ReviewGateDefinition {
  id: string;
  kind: string;
  rendererKind: string;
  title: string;
  description?: string;
  required: boolean;
  inputSchema?: JsonSchemaRef;
  decisionSchema?: JsonSchemaRef;
  supportedActions: ReviewGateAction[];
  statusSummaryTemplate?: string;
}

interface ReviewGate {
  id: string;
  jobId: string;
  definitionId: string;
  kind: string;
  status: ReviewGateStatus;
  inputRefs: string[];
  decision: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}
```

Review gates should appear as clear review surfaces: what the system found, what
decision is needed, what happens next, and what artifacts or later steps the
decision affects.

The renderer contract is intentionally product-level, not framework-specific.
Each gate must describe the payload it expects, the decision it records, the
actions it supports, and the summary Workbench can show in progress/history
surfaces. If a gate cannot map to an existing `rendererKind`, the workflow likely
needs a dedicated UI/package ticket before it can be treated as a cheap library
workflow.

### Artifact

An Artifact is an output produced or curated by a Job.

Examples:

- LinkedIn post
- follow-up email
- one-pager
- battlecard
- pain point brief
- call summary
- launch package
- single-page HTML (`web`)
- multi-file static site (`web_site`)

Artifacts are outputs. They can later be selected as Sources, but that does not
erase their output identity.

Canonical minimum shape:

```ts
interface WorkbenchArtifact {
  id: string;
  jobId: string;
  parentId: string | null;
  kind: string;
  title: string;
  content: string;
  sourceIds: string[];
  reviewGateIds: string[];
  generatedBy: "agent" | "human" | "import";
  status: "draft" | "approved" | "rejected";
  version: number;
  createdAt: string;
  updatedAt: string;
}
```

The existing `Artifact` shared type remains the current compatibility shape for
the transcript workflow. It still carries `sessionId` and optional
`painPointId`. New source-to-artifact work should treat those as compatibility
fields, not the canonical contract. Canonical provenance is `jobId`,
`sourceIds`, `reviewGateIds`, `generatedBy`, parent/version lineage, and `kind`.

Compatibility shape:

```ts
interface CurrentTranscriptArtifact {
  id: string;
  sessionId: string;
  parentId: string | null;
  painPointId: string | null;
  kind: string;
  title: string;
  content: string;
  status: "draft" | "approved" | "rejected";
  version: number;
  createdAt: string;
  updatedAt: string;
}
```

### Package

A Package is a curated group of Artifacts that can be reviewed, exported, or
delivered together.

Examples:

- launch package
- call follow-up package
- sales collateral package
- social post set

Minimum shape:

```ts
interface ArtifactPackage {
  id: string;
  jobId: string;
  title: string;
  artifactIds: string[];
  status: "draft" | "approved" | "delivered";
  createdAt: string;
  updatedAt: string;
}
```

### Hook

A Hook is an optional final action after review or approval.

Examples:

- copy/export
- download package
- save artifact
- draft email
- draft or schedule social post
- publish `web` or `web_site` artifact to a hosted URL (Vercel; human approval before deploy)
- webhook/custom action placeholder

Minimum shape:

```ts
type HookStatus = "available" | "disabled" | "running" | "succeeded" | "failed";

interface DeliveryHook {
  id: string;
  jobId: string;
  artifactIds: string[];
  kind: string;
  status: HookStatus;
  requiredCapabilities: string[];
  destinationRef?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
```

Hook availability must derive from connected accounts and Interchange
grants/capabilities. Workbench should not store or evaluate a separate
permission model.

Hooks have two product modes:

- **Draft affordance**: Workbench creates a draft, export, copied payload, or
  handoff object the user can inspect before final delivery.
- **Execute delivery**: Interchange executes the capability-scoped action,
  evaluates grants, accesses credentials, records audit, handles retries, and
  reports delivery status.

Workbench may present and initiate either mode, but the capability boundary and
delivery execution belong to Interchange.

## Workflow Authoring Contract

A new workflow should be cheap to add when it can be described with existing
Workbench surfaces and Interchange runtime capabilities. Before implementing a
new workflow, define this contract:

- **Outcome**: The product-facing thing the user is trying to get done.
- **Accepted Source kinds**: Which inputs can launch the workflow.
- **Required options**: The minimum choices needed before the Job can start.
- **Optional options**: Advanced controls that should stay out of the primary
  launch path.
- **Review gates**: Human decisions the workflow needs, each mapped to a known
  `rendererKind`.
- **Artifact kinds**: Outputs the Job can produce and which package/grouping
  behavior they need.
- **Hook affordances**: Draft and delivery actions that may appear after
  approval.
- **Runtime mapping**: Local/current implementation reference and, when
  available, Interchange deployed workflow reference.

If a workflow cannot fit this contract without custom execution semantics,
custom authz, or a one-off UI surface, it should graduate into its own project
instead of being treated as a cheap library workflow.

## Review Gate UX Pattern

Every Job should present a small number of review gates rather than every
pipeline step. A review gate needs:

- context: selected Sources and what the system did with them
- decision: the specific human choice required
- impact: what this decision will affect
- action: approve, edit, reject, select, or continue
- history: prior decisions and generated outputs

The UI should hide internal steps by default. Advanced users can inspect history
or logs, but the primary surface stays outcome-driven.

## Example: Markdown Positioning File to GTM Content

User goal: create sales and social content from a positioning document.

1. User selects a markdown positioning file.
2. Workbench suggests "Create sales collateral" and "Draft LinkedIn posts."
3. User chooses the GTM content Offering and selects desired outputs.
4. A Job starts with the markdown Source.
5. The workflow normalizes the Source and extracts summary, positioning angles,
   and pain points.
6. Review gate: user selects which findings should drive content generation.
7. The workflow generates selected Artifacts, such as a LinkedIn post and
   follow-up email.
8. Review gate: user approves, rejects, or requests refinement per Artifact.
9. Optional Hook: copy, export, save package, or draft to a connected channel.

Visible user flow:

```text
Choose source -> Choose outcome -> Review findings -> Approve artifacts -> Export
```

Internal workflow topology stays hidden.

## Example: Brain Files to Collateral Package

User goal: generate a content package from several context files.

1. User drops multiple files into the Brain/context library.
2. Workbench normalizes them as Sources and detects useful context, such as
   brand voice, product positioning, or customer notes.
3. User selects an outcome such as "Create launch package."
4. A Job starts with multiple Sources and optional brand voice context.
5. The workflow extracts usable claims, proof points, audience, and content
   constraints.
6. Review gate: user confirms the selected audience, claims, and voice.
7. The workflow generates a package of Artifacts.
8. Review gate: user approves individual Artifacts and the Package.
9. Optional Hooks draft or deliver approved Artifacts where capabilities exist.

This uses the same Source, Job, Review Gate, Artifact, Package, and Hook model as
the markdown flow. Only the Offering and workflow definition differ.

## Open Questions

- How should the current transcript-era `sessionId` artifact compatibility field
  migrate to canonical `jobId` once implementation work begins?
- Which Artifact kinds remain closed unions in UI renderers, and which are
  free-form strings from workflow definitions?
- How much review-gate history should be visible by default versus tucked into
  an inspector?
- Which v1 Hooks should execute in-app versus create drafts only?
- Where should the first Source normalization metadata live before the
  Interchange asset substrate is available?
