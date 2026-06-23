# @workbench/tools-gamma

Gamma deck-generation tools for GTM Workbench agents.

## What this package is

This package wraps the Gamma SaaS API (https://gamma.app) as a set of `AgentTool` instances. Agents use these tools to list themes, generate decks from a template, and list the workbench's curated template registry.

## Direct HTTP is acceptable here

Gamma's `POST /generations/from-template` is a SaaS generation endpoint, not an LLM inference provider. Direct HTTP from a hub tool is the correct pattern — the same as `@workbench/tools-firecrawl`. Do NOT add `gamma` to an agent's `credentialRequirements`; that field is for inference sources only. Resolve the Gamma API key via `resolveCredentialRequirement` in the hub tool registry at call time.

See AGENTS.md "Third-party generation APIs (Gamma)" for the authoritative explanation of this boundary decision.

## API endpoint notes

Verified against the official docs (https://developers.gamma.app). The REST API exposes: `POST /generations`, `POST /generations/from-template`, `GET /generations/{id}`, `GET /themes`, `GET /folders`, `POST /gammas/{gammaId}/archive`, `DELETE /gammas/{gammaId}`.

## There is no list-templates endpoint

Gamma's REST API has **no** endpoint to list templates — and no endpoint to list gammas/documents at all. A "template" is simply an existing single-page gamma referenced by its `gammaId` (copied from the Gamma app); `POST /generations/from-template` takes that `gammaId` plus a prompt that fills placeholder tokens.

Because of this, `gamma_list_templates` and the hub route `GET /workflows/gamma/templates` return a **workbench-owned curated registry** (`GAMMA_TEMPLATES` in `templates.ts`), not a live Gamma call. The registry is empty until templates are added.

The only way to enumerate templates programmatically is the **MCP** tool `get_gammas` (`type: template`), which requires OAuth 2.0 / Dynamic Client Registration rather than the REST `X-API-KEY`. That auto-sourcing path is not yet implemented.
