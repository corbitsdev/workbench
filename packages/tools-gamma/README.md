# @workbench/tools-gamma

Gamma deck-generation tools for GTM Workbench agents.

## What this package is

This package wraps the Gamma SaaS API (https://gamma.app) as a set of `AgentTool` instances. Agents use these tools to list themes, generate decks from a template, and list the workbench's Gamma templates.

## Direct HTTP is acceptable here

Gamma's `POST /generations/from-template` is a SaaS generation endpoint, not an LLM inference provider. Direct HTTP from a hub tool is the correct pattern — the same as `@workbench/tools-firecrawl`. Do NOT add `gamma` to an agent's `credentialRequirements`; that field is for inference sources only. Resolve the Gamma API key via `resolveCredentialRequirement` in the hub tool registry at call time.

See AGENTS.md "Third-party generation APIs (Gamma)" for the authoritative explanation of this boundary decision.

## API endpoint notes

Verified against the official docs (https://developers.gamma.app). The REST API exposes: `POST /generations`, `POST /generations/from-template`, `GET /generations/{id}`, `GET /themes`, `GET /folders`, `POST /gammas/{gammaId}/archive`, `DELETE /gammas/{gammaId}`.

## Generated decks are shared with the workspace by default

Gamma creates each generation under the API key's own identity. Without an explicit `sharingOptions`, the deck defaults to private-to-that-identity and never surfaces for the workspace members who own the key (CL-2635). So both generate call sites send `WORKSPACE_SHARING_OPTIONS` (`shared.ts`): `workspaceAccess: "fullAccess"` (visible + editable to the whole workspace) and `externalAccess: "view"` — which Gamma documents as "Access level for external users (via shared link)", i.e. link-gated viewing, not public/indexed. Any future plain `POST /generations` path must send the same constant.

## Deck PDF export

Both from-template generate call sites send `exportAs: GENERATION_EXPORT_FORMAT` (`"pdf"`, `shared.ts`). Gamma runs an automatic export after generation and, on the completed `GET /generations/{id}`, returns an `exportUrl` alongside `gammaUrl`/`gammaId`. `GenerationResultSchema` carries `exportUrl` as optional, so a deck generated without export support (or before this change) still resolves — the field is simply absent.

The `exportUrl` is a **temporary download link that expires after ~1 week** and is not tied to the API key. It is therefore not persisted as-is. The Gamma workflow threads `exportUrl` into `artifact_link_gamma_presentation` as `pdfUrl`; the hub handler downloads the bytes and stores them durably in the `upload` table (BYTEA), referenced from the artifact's `source.upload`, and served by `GET /artifacts/:id/download`. The PDF is supplementary to the deck link: an oversize (> `MAX_UPLOAD_BYTES`), empty, or failed fetch degrades to persisting the deck link without a PDF rather than failing the deck save.

## Deck URL field (`gammaUrl` / `url`)

The completed deck's link has been seen under `url` as well as `gammaUrl` in older packed tool output shapes (the presentation workflow's `blocks.ts` reader already tolerates `gammaUrl ?? url`). `pollGeneration` normalizes a `url`-only completed response up to `gammaUrl` before parsing (and rejects an empty deck link rather than persisting a blank one), and both generate tools return the same validated shape via `toDeckResult` — `gammaUrl`, `url` (a mirror of `gammaUrl`), `gammaId`, and `exportUrl` (empty when there is no PDF). This keeps a downstream consumer keyed on any of those fields resolving without a fallback — notably the presentation workflow's `persist` step, whose `argMap` maps the artifact tool's `url` arg from `gammaUrl` and `pdfUrl` from `exportUrl` with a hard, no-fallback presence check that would otherwise sink the deck save when a field is absent.

## No live deck-status reflection

Generation status is a synchronous in-tool poll (`pollGeneration`): the render step blocks until the deck is `completed`, surfaced to the user only as the workflow step's own progress. Gamma exposes **no webhook and no API to observe a published deck's later manual edits**, so there is no way to reflect post-generation deck changes back into Workbench. Decks are one-shot: create in the workflow, then edit manually in Gamma.

## There is no list-templates endpoint

Gamma's REST API has **no** endpoint to list templates — and no endpoint to list gammas/documents at all. A "template" is simply an existing single-page gamma referenced by its `gammaId` (copied from the Gamma app); `POST /generations/from-template` takes that `gammaId` plus a prompt that fills placeholder tokens.

Because of this, templates are a **workbench-owned, DB-backed resource**, not a live Gamma call. Each template is a row in `workbench_template` / `workbench_template_version` (kind `gamma`) whose config is `{ gammaId, description }` — a human-facing `description` plus the `gammaId` to render from. There is no static `GAMMA_TEMPLATES` array.

Templates are managed over the hub REST API:

- `GET /api/v1/gamma-templates` — list templates visible to the active workbench (its own plus those inherited from ancestor tenants up to the global tenant). Each row carries `canManage`, computed per-caller from the grant store.
- `POST /api/v1/gamma-templates` — create; the creator is granted `manage` on `template:<id>` via the Interchange grant system.
- `PUT` / `DELETE /api/v1/gamma-templates/:id` — gated on a `manage` grant (`authorize(...)`), so anyone in the tenant can use a template but only its owner (or a delegate/admin) can edit or delete it.
- `POST /api/v1/gamma-templates/:id/delegates` — grant `manage` to another principal (owner-only).

Two consumers list templates: the **agent** uses the hub-backed `gamma_list_templates` tool (the `gammaTemplates` factory in `src/interchange-tools.ts`, executed hub-side via `HUB_BACKED_TOOLS` over `POST /api/internal/hub-tools/run`), which is reachable from both live sessions and workflow steps (CL-2597); the **web** (the `/settings/tools/:id` manager and the workflow intake UI) uses `GET /api/v1/gamma-templates`.

The Gamma **MCP** tool `get_gammas` (`type: template`) can enumerate the user's own Gamma templates, but requires OAuth 2.0 / Dynamic Client Registration rather than the REST `X-API-KEY`; that auto-sourcing path is not implemented.
