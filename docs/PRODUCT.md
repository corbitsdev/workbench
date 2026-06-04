# GTM Workbench — Product Documentation

## What We're Building

A human-in-the-loop (HITL) tool that turns sales call transcripts into polished, publishable collateral.

The agent reads a transcript, extracts pain points, and generates targeted collateral (email, LinkedIn, one-pager, battlecard) for each one. The user reviews every step — approving pain points, reviewing collateral, refining selected pieces, and exporting the final output.

This is **intentionally not** a fully automated pipeline. The agent handles analysis and first-draft generation. The human handles curation, approval, and refinement. That is the product.

The broader workbench pattern is source-to-artifact: users bring source material,
choose an outcome, review the important decisions, approve artifacts, and
optionally deliver them. Users choose outcomes, not pipeline topology. The
canonical model lives in [SOURCE_TO_ARTIFACT.md](./SOURCE_TO_ARTIFACT.md).

## Target Users

- Sales and marketing teams who want to turn call insights into usable content
- Teams that need lightweight, fast collateral without waiting for a content team

## Core Value Propositions

- **Fast**: Paste a transcript, get draft collateral in minutes
- **Reviewable**: Every step is human-approved, not black-box automation
- **Resumable**: Sessions are saved, so users can return and iterate
- **Exportable**: Final output is assembled and ready to copy, download, or deliver

## Prototype Stages

1. **Call Selection** — Paste transcript or pick from recent calls
2. **Live Analysis** — Extract pain points with severity, context, and direct quote
3. **Collateral Review** — Card-by-card approval, rejection, inline improvement
4. **Improvement** — Per-item feedback and regeneration
5. **Final Export** — Copy, download, or deliver assembled collateral
6. **Session Dashboard** — Resume prior sessions, re-export, iterate

## Workbench Model

The current transcript workflow is the first concrete version of a more general
workbench model:

1. **Sources** — Input material such as transcripts, markdown files, uploaded
   documents, brain/context files, URLs, or prior artifacts reused as inputs
2. **Jobs** — One run of a workflow against selected sources and options
3. **Review Gates** — Human decisions that steer the job without exposing the
   full internal pipeline
4. **Artifacts** — Generated or curated outputs, including collateral, briefs,
   summaries, and packages
5. **Hooks** — Optional delivery actions such as copy, export, draft, schedule,
   post, or send

The product should surface named outcomes such as "Create sales collateral" or
"Draft LinkedIn posts" rather than raw internal steps like summarize, extract,
generate, humanize, and post.

## Intake Scope

- **Primary**: Paste raw transcript, VTT, or rough notes
- **Secondary**: Optional recent-call picker from Granola API
- **Out of scope (v2)**: Full CRM sync (Attio, Salesforce, etc.)

## Acceptance Criteria

- Users must authenticate via Google OAuth (optional domain allowlist for team gating)
- Transcript can be pasted and submitted
- Pain point analysis is generated and reviewable
- Users can select which pain points continue to collateral generation
- Collateral is generated per pain point
- Users can approve / reject pieces during review
- Users can improve an individual piece with feedback
- Final output can be copied or exported
- Session state is persisted and can be resumed
- Usable without full production CRM sync
