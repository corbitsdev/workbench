# GTM Workbench — Product Documentation

## What We're Building

A human-in-the-loop (HITL) GTM workspace where AI agents and workflows assist users in turning sales call data into publishable collateral assets.

The agent layer handles analysis and first-draft generation. The human handles curation, approval, and refinement at every stage. This is **intentionally not** a fully automated pipeline.

The broader workbench pattern is source-to-artifact: users bring source material, choose an outcome, review the important decisions, approve artifacts, and optionally deliver them. Users choose outcomes, not pipeline topology. The canonical model lives in [SOURCE_TO_ARTIFACT.md](./SOURCE_TO_ARTIFACT.md).

## Agents

### Myra — Personal AI Agent

Every user gets a personal AI agent named **Myra**. Myra acts as a Chief of Staff / Executive Assistant, living in the user's personal Interchange tenant. Myra can coordinate across workbenches and serves as the user's persistent, intelligent assistant throughout the platform.

### Oat — Workspace Granola Agent

**Oat** is a shared workspace agent that continuously processes Granola call recordings and surfaces them as call document artifacts in the workbench. Oat runs in the shared GTM Workbench Interchange tenant.

## How It Works

1. **Oat processes calls** — Oat automatically ingests Granola call recordings and creates call document artifacts.
2. **User triggers Collateral Generation** — The user selects N input artifacts (e.g. call documents) and N output types (e.g. case study, one-pager, email draft). Each combination generates independently.
3. **Each output is an independent artifact** — Results are stored as artifact rows and can be reviewed, refined, re-used as inputs, or exported.

## Output Types Currently Supported

- Case study
- One-pager
- Email draft

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

## Intake Scope

- **Primary**: Oat automatically surfaces Granola call recordings as call document artifacts
- **Secondary**: Manual paste of raw transcript, VTT, or rough notes
- **Out of scope (v2)**: Full CRM sync (Attio, Salesforce, etc.)

## Acceptance Criteria

- Users must authenticate via Google OAuth (optional domain allowlist for team gating)
- Oat continuously processes Granola calls into call document artifacts
- Users can trigger Collateral Generation by selecting input artifacts and output types
- Each output type generates independently in parallel
- Results are stored as artifact rows with provenance
- Users can review, refine, and export generated artifacts
- Session state is persisted and can be resumed
- Usable without full production CRM sync
