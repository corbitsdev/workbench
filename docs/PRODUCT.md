# GTM Workbench — Product Documentation

## What We're Building

A human-in-the-loop (HITL) GTM workspace where AI agents and workflows assist users in turning sales call data into publishable collateral assets.

The agent layer handles analysis and first-draft generation. The human handles curation, approval, and refinement at every stage. This is **intentionally not** a fully automated pipeline.

The broader workbench pattern is source-to-artifact: users bring source material, choose an outcome, review the important decisions, approve artifacts, and optionally deliver them. Users choose outcomes, not pipeline topology. The canonical model lives in [SOURCE_TO_ARTIFACT.md](./SOURCE_TO_ARTIFACT.md).

## Inbox — the home surface

The app now opens into the **Inbox**, not a chat thread. The inbox is a
per-principal mailbox (every user and every agent instance has one) that also
serves as the "Now" dashboard: a single prioritized list of everything that
needs the user's attention, ranked **gate asks first, then unread mail, then
open tasks** (a blocked workflow run always outranks an unread message, which
always outranks an open task). Mail delivery into a principal's inbox is
authorized to senders in the same tenant domain — an agent instance can write
to a user's inbox, but only within the tenant it's provisioned in — and every
inbox list and detail route derives the caller's identity from their session,
never from a client-supplied id.

The inbox is live: new mail, a landing brief, or a triage handoff appears the
moment it is delivered (a content-free push signal tells the open app to
refresh; a gentle poll remains as fallback).

A notifications bell in the app chrome surfaces unread counts (and lists
recent open tasks alongside mail), and a
registry-driven onboarding tour (its shown/dismissed state is a persisted user
preference, not local-only UI state) introduces new users to the inbox model
on first login.

## Automations

Two ways work can start without a user opening the app:

- **Scheduled triggers** — a durable, per-user schedule (daily, UTC-hour
  cadence) that fires a workflow run. Users manage their own schedules from a
  dedicated page. One heartbeat schedule is seeded automatically per Myra
  instance so Myra can check in on a cadence even if the user never sets up a
  schedule themselves. The **owner turns automations on or off** from the
  Capabilities page — scheduling, triage, and task sync are each a toggle,
  disabled by default, with no deploy needed to flip them.
- **Webhook triggers** — a user can mint a webhook that starts a workflow run
  when an external system posts to it. The public endpoint is secret-authenticated
  and rate-limited per source IP to prevent abuse; a failed or unauthorized
  request returns a generic not-found rather than revealing which triggers
  exist.

Users shape their own morning brief: when it arrives (their brief hour), which
sources feed it (per-source toggles — Granola calls today, more as
integrations land; a toggled-off or unavailable source is simply absent, never
reported as a failure), and which catalog workflows run alongside it, their
outputs landing in the inbox as their own items.

## Ephemeral triage Myra

When a message from outside the platform lands in a user's inbox, an
ephemeral, read-only instance of Myra can triage it before the user sees it —
summarizing, flagging what needs a decision, and handing back a threaded
"Myra triaged: …" note in the same inbox. Triage runs as a short-lived
per-message session (not a standing agent) on a fast, economical model with a
lean toolset, is bounded so a burst of inbound mail can't run the queue wild,
ignores bounce/no-reply mail and mail from other agents (a triage handoff is
terminal — two people's triage agents can never loop), and is a toggle the
owner controls. The
default autonomy level for this and other agent-initiated action is
**prepare-only** — the agent drafts and hands back, it does not send or act on
the user's behalf, unless the user raises their own autonomy preference.

## Native tasks

Tasks are now a first-class object in the workbench, not something that only
exists in a connected CRM. A user (or an agent acting for them) can create a
task, and the workbench can push it out to a connected external system (Attio
and Linear today) and reconcile state back. From a task in the inbox, the user
sends it to a system with an explicit confirmation; a quiet chip on the task
shows where it's linked or that it's on its way. Pushes and reconciliation
happen server-side; a push failure never surfaces as a user-facing error, it's
retried in the background.

## Agents

### Myra — Personal AI Agent

Every user gets a personal AI agent named **Myra**. Myra acts as a Chief of Staff / Executive Assistant. Each user receives their own Myra instance (provisioned automatically on join) within the shared global org tenant. Myra can coordinate across workbenches and serves as the user's persistent, intelligent assistant throughout the platform.

**Multi-thread chat.** The app's home surface is the Inbox (see below), but Myra chat remains the default way to work with the assistant directly. A user can run **multiple parallel Myra chats** ("threads") — each thread is a separate, full Myra (its own tools, skills, and history), not a saved transcript. Myra's durable **memory is shared across all of a user's threads**, not per-thread: what she learns in one chat (the standing brief on the person, durable facts, contacts) is available in the others. The widened left sidebar lists every thread with **+ New Chat**, and threads can be renamed or deleted. The app remembers the last-active thread, so reopening the app (or the docked quick-chat available on non-chat pages) lands the user back where they were. Workflow run history lives on its own **Workflows** page.

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

## Settings

User-facing preferences (triage autonomy, notification behavior, tour
dismissal, and similar) are validated against a shared preference registry
rather than accepted as free-form values — a write to an unregistered
preference key is rejected. Users manage these from the Settings page.

A registry entry can declare `availableWhen` — a signal (a workflow kind
deployed, a provider connected, or an owner-granted capability) the setting's
control depends on. The Settings page hides (never disables) a control whose
signal is unmet; a setting with no `availableWhen` always renders. The
morning-brief time and its notification toggles require the heartbeat
workflow to be deployed, and auto-sending tasks to a CRM requires the Attio
connection.

## Target Users

- Sales and marketing teams who want to turn call insights into usable content
- Teams that need lightweight, fast collateral without waiting for a content team

## Core Value Propositions

- **Fast**: Select call artifacts, get draft collateral in minutes
- **Reviewable**: Every step is human-approved, not black-box automation
- **Resumable**: Sessions are saved, so users can return and iterate
- **Exportable**: Final output is assembled and ready to copy, download, or deliver — including **hosted static sites** (`web` single-page HTML and `web_site` multi-file bundles) that Myra can publish to a **public Vercel URL** after explicit human approval

## Workbench Model

The current workflow is the first concrete version of a more general workbench model:

1. **Sources** — Input material such as call documents, uploaded files, brain/context files, URLs, or prior artifacts reused as inputs
2. **Jobs** — One run of a workflow against selected sources and options
3. **Review Gates** — Human decisions that steer the job without exposing the full internal pipeline
4. **Artifacts** — Generated or curated outputs, including collateral, briefs, summaries, and packages
5. **Hooks** — Optional delivery actions such as copy, export, draft, schedule, post, send, or **publish a web artifact to Vercel** (preview by default; production only when the user asks)

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
