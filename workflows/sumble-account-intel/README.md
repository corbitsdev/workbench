# @workbench/workflow-sumble-account-intel

A human-in-the-loop account intelligence workflow. Given an account (company
domain or Sumble company ID), it researches the account across Sumble — resolving the
organization, then pulling teams, open jobs, technology stack, contacts, and
buying signals — enriches each contact with an X/Twitter search (Sumble returns
LinkedIn-sourced people only), synthesizes a reviewable account intelligence
brief (including a contacts CSV and a Slack-ready draft), and, after human
approval, persists the brief as a `research` artifact.

## Flow

Every step after `intake` is a native `action` — there is no `map` and no
`deterministicToolStep` left in this workflow.

1. `intake` — human names the account (`organizationDomain`, optional `pushToAttio`).
2. `resolve` — `sumble_account_intel_resolve_organization` (load-bearing; not best-effort).
3. `teams` / `jobs` — `sumble_account_intel_list_teams` / `sumble_account_intel_list_jobs` (org shape).
4. `techStack` — `sumble_get_org_tech_stack`.
5. `contacts` — `sumble_account_intel_search_people` (load-bearing; not best-effort).
6. `signals` — `sumble_account_intel_search_signals`.
7. `enrichSocial` — `sumble_account_intel_enrich_contacts`, one per-contact `x_search` iterated inside the tool.
8. `synthesize` — inline inference (`LLM_WRITER_MODEL`) producing strict JSON.
9. `review` — human approves the brief.
10. `packageArtifact` — `write_artifact` persists the brief.

### Best-effort facets, without `nonFatal`

`ActionPrimitive` has no error-swallow (`apps/sidecar/src/action-tool-handler.ts`
awaits `ctx.perform` with no catch — any throw fails the step and the run), so
`teams`, `jobs`, `signals`, and `enrichSocial` get their best-effort behavior
from THIS PACKAGE'S OWN tool wrappers (`src/tools.ts`), not from a step tag:
`sumble_account_intel_list_teams`/`list_jobs`/`search_signals`/`enrich_contacts`
each call the real Sumble/X tool internally and catch its failure, returning a
`{ ok: false, error }` envelope inside a SUCCESSFUL `ToolResult` (outer
`isError` stays `false`) rather than throwing or setting `isError: true` — the
native action dispatch path throws on any `isError: true` result when
`nonFatal` is not set, and an `action` step has no `nonFatal` tag to set.
`resolve` and `contacts` (`search_people`) stay genuinely fatal: their wrappers
pass the underlying tool's `isError`/`content` straight through unmodified, so
a real failure still fails the run — `contacts` is load-bearing (the
enrichment step iterates its `people` array).

### `enrichSocial` folds a `map` into one tool

The former per-contact `map` over `x_search` is gone.
`sumble_account_intel_enrich_contacts` iterates the contacts step's `people`
array INSIDE the tool (mirroring how `granola_spawn_call_runs` fans out per
note) because `MapPrimitive.step` is typed `StepPrimitive`, not the `Primitive`
union `action` belongs to, and the deploy capability walk only reads
`primitive.step.agent` for a map node — an `action` cannot be a map's inner
step at all.

### Wrappers own their own field names — no `argMap` anywhere

Every wrapper tool in `src/tools.ts` declares its OWN input field names to
match the upstream step's own output field verbatim (`organizationDomain`,
`slug`, `people`) rather than the underlying Sumble/X tool's field names
(`identifier`, `organizationSlug`, `query`) — the rename that used to require
the `argMap` escape hatch now happens in TypeScript inside the wrapper, not in
a step selector, so every step's `input` is a plain `from`/`project`/`merge`
selector.

### In-process invocation, not a new tool-package pin

`src/tools.ts` imports `@workbench/tools-sumble`'s and `@workbench/tools-x`'s
exported factory functions (`createSumbleTools`, `createXTools`) directly and
calls them in-process — it does not pin those packages' own
`interchange.tools` factories. This workflow's own factory
(`src/interchange-tools.ts`) declares `requires: [toolCredentialEnvKey("sumble"),
toolCredentialEnvKey("xai")]`; the sidecar's step-tool-harness resolves a
factory's declared `requires` env keys the same way regardless of which
package declares them, so this factory's credentials resolve exactly as
`@workbench/tools-sumble`'s/`@workbench/tools-x`'s own factories would.

## Attio push — intentionally out of band (not a v1 dependency)

The intake and review gates collect a `pushToAttio` flag, but the workflow does
NOT include an Attio step. The `@intx/workflow` runtime's only conditional
primitive is `gate`, an exclusive-OR **branch** (routes to a `then` step or an
`else` step and skips the not-selected branch's closure). It cannot express
"optionally run one extra trailing side-effect step" without introducing a
no-op `else` leaf — a stub, which the repo's "no stubs" rule forbids. Combined
with the product constraint that **CRM sync (Attio) must not be a v1
dependency**, the Attio push is intentionally left as an out-of-band follow-up:
the approved brief carries the operator's `pushToAttio` intent for a downstream
consumer to act on, and no Attio call runs inside this workflow.
