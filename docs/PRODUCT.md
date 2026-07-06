# GTM Workbench — Product Documentation

## What We're Building

A human-in-the-loop (HITL) GTM workspace where AI agents and workflows assist users in turning sales call data into publishable collateral assets.

The agent layer handles analysis and first-draft generation. The human handles curation, approval, and refinement at every stage. This is **intentionally not** a fully automated pipeline.

The broader workbench pattern is source-to-artifact: users bring source material, choose an outcome, review the important decisions, approve artifacts, and optionally deliver them. Users choose outcomes, not pipeline topology. The canonical model lives in [SOURCE_TO_ARTIFACT.md](./SOURCE_TO_ARTIFACT.md).

## Agents

### Myra — Personal AI Agent

Every user gets a personal AI agent named **Myra**. Myra acts as a Chief of Staff / Executive Assistant. Each user receives their own Myra instance (provisioned automatically on join) within the shared global org tenant. Myra can coordinate across workbenches and serves as the user's persistent, intelligent assistant throughout the platform.

**Multi-thread chat.** Myra is the default, chat-first experience: the app opens directly into a conversation. A user can run **multiple parallel Myra chats** ("threads") — each thread is a separate, full Myra (its own tools, skills, and history), not a saved transcript. Myra's durable **memory is shared across all of a user's threads**, not per-thread: what she learns in one chat (the standing brief on the person, durable facts, contacts) is available in the others. The widened left sidebar lists every thread with **+ New Chat**, and threads can be renamed or deleted. The app remembers the last-active thread, so reopening the app (or the docked quick-chat available on non-chat pages) lands the user back where they were. Workflow run history lives on its own **Workflows** page.

**Document understanding.** A user can attach an image or a **document (PDF)** to a Myra message. Images Myra reads directly. Documents she reads through a dedicated **File Parser** — the uploaded file is turned into text and handed to Myra — so she understands PDFs **regardless of her own chat model**, which cannot read documents natively. The attached document appears as a chip on the message. Myra can also read a document a user or workflow saved earlier as an artifact.

### Oat — Workspace Granola Agent

**Oat** is a shared workspace agent that processes Granola call recordings and surfaces them as call document artifacts in the workbench. Oat runs in the shared GTM Workbench Interchange tenant. Oat processes calls when prompted; recurring, scheduled ingestion is moving to workflows.

## How It Works

Workflows are deployed pipelines that run on Interchange's native workflow runtime. The user starts a run, watches its steps progress, and approves the human-in-the-loop gates — all in a single generic run console; there is no per-workflow bespoke UI.

1. **Oat processes calls** — Oat ingests Granola call recordings and creates call document artifacts when prompted.
2. **User starts a workflow run** — e.g. Collateral Generation against selected call documents.
3. **The run console shows progress** — each step's status streams in live; at a review gate the user approves (or rejects) before the run continues.
4. **Outputs are artifacts** — results are stored as artifact rows and can be reviewed, refined, re-used as inputs, or exported.

## Command Palette

A global command palette gives keyboard-first navigation across the workbench. Pressing **Cmd+K** (Ctrl+K on Windows/Linux) from anywhere opens a centered search overlay; Escape closes it and returns focus to wherever the user was. Typing fuzzy-matches two kinds of results, grouped by category:

- **Go to** — jump to any top-level area (Chats, Artifacts, Workflows, Skills, Tools, Insights, Settings)
- **Entities** — conversations, agents, workflows, artifacts, skills, and tools in the active workbench

Selecting a result navigates straight to it. Navigation commands are matched on the client; entity results come from a server-side search scoped to the active workbench, so the palette only ever surfaces what the user is allowed to see. Each entity type contributes its top few matches, with a "Load more" control to pull the next batch.

## Workflows Currently Shipped

Each workflow is a deployed pipeline (`collateral-generation`, `gamma-presentation-creator`, `resource-enrichment`, `reddit-opportunity-scanner`, `blind-ab-comparison`). Examples:

- **Collateral Generation** — call documents into case studies, one-pagers, and email drafts.
- **SEO / Resource Enrichment** — a product-catalog spreadsheet into row-by-row option variants; the user picks the best per field in a review gate and exports the chosen copy as a CSV.

## Skill Library

Users can build and manage a personal library of **skills** — reusable AI instruction sets that extend agent behavior. A skill is a markdown file (or a bundle of files) that defines a prompt, persona, or procedure. Skills are attached to agents to shape how those agents respond.

Key capabilities:

- **Upload** — create a skill from pasted markdown, a single file, a folder, or a zip archive
- **Choose where to share it** — when the user belongs to more than one tenant (e.g. a workbench plus the org), upload offers a "Who can access this skill?" chooser to pick which one; with a single tenant there is no choice, so the skill is simply created there
- **Browse** — view all skills the user can access; each card shows the owner, when it was last edited, and its access label (the sharing tenant's name)
- **Inspect** — the detail page renders the skill's files in a file-tree sidebar; `SKILL.md` is shown as rendered markdown with a source/preview toggle
- **Version history** — the detail page lists every saved version (sequential `v1, v2, …` with a short commit id, author, and date); the creator can restore any prior version, which is recorded as a new version
- **Delete** — owners can permanently remove a skill and its git store from the detail page; deletion requires an inline confirmation step

A skill is visible to everyone in the tenant it was created in and that tenant's descendants (e.g. a skill in the org is visible in every workbench under it). Per-user private skills are deferred until users have a personal tenancy.

## Target Users

- Sales and marketing teams who want to turn call insights into usable content
- Teams that need lightweight, fast collateral without waiting for a content team

## Core Value Propositions

- **Fast**: Select call artifacts, get draft collateral in minutes
- **Reviewable**: Every step is human-approved, not black-box automation
- **Resumable**: Sessions are saved, so users can return and iterate
- **Exportable**: Final output is assembled and ready to copy, download, or deliver

## Workbench Model

The current workflow is the first concrete version of a more general workbench model:

1. **Sources** — Input material such as call documents, uploaded files, brain/context files, URLs, or prior artifacts reused as inputs
2. **Jobs** — One run of a workflow against selected sources and options
3. **Review Gates** — Human decisions that steer the job without exposing the full internal pipeline
4. **Artifacts** — Generated or curated outputs, including collateral, briefs, summaries, and packages
5. **Hooks** — Optional delivery actions such as copy, export, draft, schedule, post, or send

The product should surface named outcomes such as "Create sales collateral" or "Draft LinkedIn posts" rather than raw internal steps.

### Adding a workflow

A workflow is a deployed pipeline, not a per-user configuration. An operator authors it as a native
workflow package and deploys it to the hub (see [DEPLOYING_WORKFLOWS.md](../DEPLOYING_WORKFLOWS.md));
its inference credentials are resolved from the tenant's LLM credential at deploy time. Once
deployed, users start runs and approve gates — there is no per-step credential/tool install flow in
the product app. Adding a new workflow needs no hub change, only a new package and a push.

## Intake Scope

- **Primary**: Oat surfaces Granola call recordings as call document artifacts
- **Secondary**: Manual paste of raw transcript, VTT, or rough notes
- **Out of scope (v2)**: Full CRM sync (Attio, Salesforce, etc.)

## Acceptance Criteria

- Users must authenticate via Google OAuth (optional domain allowlist for team gating)
- Oat processes Granola calls into call document artifacts
- Users can trigger Collateral Generation by selecting input artifacts and output types
- Each output type generates independently in parallel
- Results are stored as artifact rows with provenance
- Users can review, refine, and export generated artifacts
- Session state is persisted and can be resumed
- Usable without full production CRM sync
- API keys and credentials are encrypted at rest by the storage layer (not by application code)
