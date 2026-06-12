# @workbench/tools-gamma

Gamma deck-generation tools for GTM Workbench agents.

## What this package is

This package wraps the Gamma SaaS API (https://gamma.app) as a set of `AgentTool` instances. Agents use these tools to list templates, list themes, and generate decks from templates.

## Direct HTTP is acceptable here

Gamma's `POST /generations/from-template` is a SaaS generation endpoint, not an LLM inference provider. Direct HTTP from a hub tool is the correct pattern — the same as `@workbench/tools-firecrawl`. Do NOT add `gamma` to an agent's `credentialRequirements`; that field is for inference sources only. Resolve the Gamma API key via `resolveCredentialRequirement` in the hub tool registry at call time.

See AGENTS.md "Third-party generation APIs (Gamma)" for the authoritative explanation of this boundary decision.

## API endpoint notes

The endpoint paths used here (`/templates`, `/themes`, `/generations/from-template`) follow plausible REST conventions. Verify these against the live Gamma API docs before deploying — the Gamma API is not publicly documented at time of writing.
