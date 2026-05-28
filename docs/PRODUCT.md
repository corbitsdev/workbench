# GTM Workbench — Product Documentation

## What We're Building

A human-in-the-loop (HITL) tool that turns sales call transcripts into polished, publishable collateral.

The agent reads a transcript, extracts pain points, and generates targeted collateral (email, LinkedIn, one-pager, battlecard) for each one. The user reviews every step — approving pain points, reviewing collateral, refining selected pieces, and exporting the final output.

This is **intentionally not** a fully automated pipeline. The agent handles analysis and first-draft generation. The human handles curation, approval, and refinement. That is the product.

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

## Intake Scope

- **Primary**: Paste raw transcript, VTT, or rough notes
- **Secondary**: Optional recent-call picker from Granola API
- **Out of scope (v2)**: Full CRM sync (Attio, Salesforce, etc.)

## Acceptance Criteria

- Transcript can be pasted and submitted
- Pain point analysis is generated and reviewable
- Users can select which pain points continue to collateral generation
- Collateral is generated per pain point
- Users can approve / reject pieces during review
- Users can improve an individual piece with feedback
- Final output can be copied or exported
- Session state is persisted and can be resumed
- Usable without full production auth or CRM sync
