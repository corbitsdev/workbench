# Multi-Source Collateral

Choose mixed sources, pick content types, generate drafts, swipe review with
optional feedback regenerate, and save approved pieces as workbench artifacts.

Linear: [CL-4034](https://linear.app/abklabs/issue/CL-4034)

## Flow

1. **Sources** — multi-select workbench artifacts, Granola notes, Linear issues,
   and/or free text (at least one required).
2. **Content** — pick content types (LinkedIn post/article, Twitter post/article,
   short/mid/long blog), optional audience/tone/goal, optional per-type system
   prompt override.
3. **Review** — swipe each draft Good / Bad / Regenerate (with feedback).
4. **Optional regenerate** — one revise pass, then final Good/Bad review.
5. **Persist** — `artifact_create` for each approved piece.

## Prompt customization (v1)

Each content type has a default system prompt in `src/prompts.ts`. On the
**Content** step, expand **Customize prompt** for a selected type and paste a
full override. That override is applied only for that type in **this run**
(stored on the options resume payload as `systemPromptByType`). There is no
tenant-scoped durable skill store in v1 — run-level overrides are the
deploy-free customization path.

## Package

- `@workbench/workflow-multi-source-collateral` — native `@intx/workflow` definition
- Panel: `./ui` (run page)
- Dock: `./blocks` (progress + run-page links; complex gates stay on the panel)

## Deploy

Register/deploy like other packs (see `docs/DEPLOYING_WORKFLOWS.md`). Kind:
`multi-source-collateral`. Embedded def lives at
`apps/hub/generated/workflow-defs/multi-source-collateral.json` (`humanGateCount: 4`).

## Tools used

| Tool                                                  | Role                         |
| ----------------------------------------------------- | ---------------------------- |
| `artifact_list` / `artifact_read` / `artifact_create` | Source + persist             |
| `granola_list_notes` / `granola_get_note`             | Call notes                   |
| `linear_list_issues` / `linear_get_issue`             | Tickets (`list` is nonFatal) |

## Resume signals

Registered in hub `resume-payload-registry`:

- `sources`
- `options`
- `review` (`shouldRegenerate` + `regenerateItems` + `approvedPieces`)
- `review-final` (`approvedPieces` only)
