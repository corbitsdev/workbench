import { createToolRunner } from "@intx/agent";
import type { AgentTool, AgentToolRunner } from "@intx/agent";
import type { ToolDefinition, ToolResult } from "@intx/types/runtime";
import { getToolCredential } from "@workbench/tool-credentials";
import { runTolerantTool } from "@workbench/tool-credentials/tolerance-envelope-dispatch";
import { createSumbleTools } from "@workbench/tools-sumble";
import type { SumbleToolsConfig } from "@workbench/tools-sumble";
import { createXTools } from "@workbench/tools-x";
import { parseAccountBrief } from "./parse";

// This workflow's own tool package inlines wrappers around @workbench/tools-sumble
// and @workbench/tools-x rather than pinning those packages directly, so it can
// give each Sumble facet (teams/jobs/signals) and the per-contact X enrichment a
// tolerant, non-throwing envelope — the thing `nonFatal` used to buy a
// `deterministicToolStep`, which a native `action` has no equivalent for
// (`ActionPrimitive`'s handler has no error-swallow; a throw fails the step and
// the run). `resolve` and `search_people` (contacts) stay genuinely fatal: they
// pass the underlying tool's ToolResult through unmodified, so a real failure
// still fails the run — contacts is load-bearing (the enrichment step iterates
// its `people` array).
//
// The underlying tool packages' factory functions (`createSumbleTools`,
// `createXTools`) are plain, credential-configured constructors — no sidecar
// dispatch, no separate tool-package pin required. This factory declares its
// OWN `requires: [toolCredentialEnvKey("sumble"), toolCredentialEnvKey("xai")]`
// (see interchange-tools.ts) and the sidecar's step-tool-harness resolves those
// credentials for THIS factory exactly as it would for @workbench/tools-sumble
// or @workbench/tools-x's own factories.

// Why the degrade lives INSIDE `content` and never in the outer `isError`:
// the native action dispatch path (`runDeterministicToolStep` in
// apps/sidecar/src/step-tool-harness.ts, ~line 1250) is used unconditionally
// for every action step, with no `nonFatal` flag ever set — and it THROWS
// whenever the dispatched tool's own `ToolResult.isError === true`. A
// wrapper that returned `{ isError: true, error }` at the outer level (the
// naive translation of "nonFatal used to swallow this") would still fail
// the step and the run — exactly the failure mode this migration exists to
// remove. So every tolerant wrapper below always returns a SUCCESSFUL outer
// `ToolResult` (`isError: false`) and encodes the real outcome as plain data
// in `content` (`{ ok: true, data }` / `{ ok: false, error }`); only the
// deliberately-fatal `resolve`/`search_people` wrappers ever set the outer
// `isError`, by passing the underlying tool's own field through unmodified.
export type SumbleAccountIntelToolsConfig = {
  sumble: SumbleToolsConfig;
};

function coerceArgsObject(
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof args._raw === "string") {
    const parsed: unknown = JSON.parse(args._raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("_raw fallback is not a JSON object");
    }
    return parsed as Record<string, unknown>;
  }
  return args;
}

/** Fatal passthrough: the underlying tool's `isError`/`content` survive
 * unmodified, so a genuine failure still fails the wrapping step (and, absent
 * `nonFatal`, the run) exactly as the pre-migration deterministic step did. */
async function runFatalPassthrough(
  runner: AgentToolRunner,
  toolName: string,
  callId: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ToolResult> {
  const result = await runner.run(
    { id: callId, name: toolName, arguments: args },
    signal,
  );
  return {
    callId,
    content: result.content,
    ...(result.isError !== undefined ? { isError: result.isError } : {}),
  };
}

export const SUMBLE_ACCOUNT_INTEL_FORMAT_REPORT_DOCUMENT_DEFINITION: ToolDefinition =
  {
    name: "sumble_account_intel_format_report_document",
    description:
      "Internal workflow helper. Pairs the researched account's organization domain with the synthesize agent's reply into the { title, body } shape write_artifact expects, so the persist step never reshapes the agent's reply field.",
    inputSchema: {
      type: "object",
      properties: {
        organizationDomain: {
          type: "string",
          description:
            "The researched account's organization domain, used as the artifact title.",
        },
        reply: {
          type: "string",
          description:
            "The synthesize agent's account intelligence brief text.",
        },
      },
      required: ["organizationDomain", "reply"],
    },
  };

function createSumbleAccountIntelFormatReportDocumentTool(): AgentTool {
  return {
    kind: "full",
    definition: SUMBLE_ACCOUNT_INTEL_FORMAT_REPORT_DOCUMENT_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const organizationDomain = args.organizationDomain;
      const reply = args.reply;
      if (
        typeof organizationDomain !== "string" ||
        organizationDomain.trim().length === 0
      ) {
        return {
          callId: call.id,
          isError: true,
          content: "organizationDomain is required",
        };
      }
      if (typeof reply !== "string" || reply.trim().length === 0) {
        return { callId: call.id, isError: true, content: "reply is required" };
      }
      return {
        callId: call.id,
        content: { title: organizationDomain.trim(), body: reply },
      };
    },
  };
}

// -------------------------------------------------------------------------
// prepare-review-gate — fatal. Shapes the synthesize agent's strict-JSON
// reply into the `UIBlock`-shaped `choice` the `review` gate's `STEP_UI`
// entry reads via `gateFromOutput`/`gateSourceStep` (see index.ts + the
// dock-block derivation in `@workbench/blocks`'s `blocksFromStepUI`). A
// malformed reply here is a genuine agent-contract violation (the synthesize
// system prompt REQUIRES strict JSON), not a best-effort data source — it
// fails the step (and the run) rather than rendering a degraded gate a human
// could approve into persisting garbage.
// -------------------------------------------------------------------------

export const SUMBLE_ACCOUNT_INTEL_PREPARE_REVIEW_GATE_DEFINITION: ToolDefinition =
  {
    name: "sumble_account_intel_prepare_review_gate",
    description:
      "Internal workflow helper. Shapes the synthesize agent's reply into the choice UIBlock the review gate's STEP_UI entry renders via gateFromOutput. Fatal — a malformed reply is a genuine contract violation, not a degraded facet.",
    inputSchema: {
      type: "object",
      properties: {
        reply: {
          type: "string",
          description:
            "The synthesize agent's account intelligence brief text.",
        },
      },
      required: ["reply"],
    },
  };

function reviewGatePrompt(brief: {
  title: string;
  content: string;
  contactsCsv: string;
  slackDraft: string;
}): string {
  const sections = [`# ${brief.title}`, brief.content];
  if (brief.contactsCsv.trim().length > 0) {
    sections.push(`## Contacts (CSV)\n${brief.contactsCsv}`);
  }
  if (brief.slackDraft.trim().length > 0) {
    sections.push(`## Slack draft\n${brief.slackDraft}`);
  }
  return sections.join("\n\n");
}

function createPrepareReviewGateTool(): AgentTool {
  return {
    kind: "full",
    definition: SUMBLE_ACCOUNT_INTEL_PREPARE_REVIEW_GATE_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const reply = args.reply;
      if (typeof reply !== "string" || reply.trim().length === 0) {
        return { callId: call.id, isError: true, content: "reply is required" };
      }
      const decoded = parseAccountBrief({ reply });
      if (decoded.status !== "ok") {
        return {
          callId: call.id,
          isError: true,
          content: "synthesize reply did not decode to a valid account brief",
        };
      }
      return {
        callId: call.id,
        content: {
          kind: "choice",
          prompt: reviewGatePrompt(decoded.value),
          options: [
            {
              id: "approve",
              label: "Approve & save",
              payload: { approved: true },
            },
            { id: "reject", label: "Reject", payload: { approved: false } },
          ],
        },
      };
    },
  };
}

// -------------------------------------------------------------------------
// resolve — fatal. Renames `organizationDomain` (the intake field's own name)
// to `identifier` (the underlying tool's arg), which a step-input selector
// cannot do; the wrapper's own arg is instead named to match the intake
// field verbatim, so the workflow step needs no argMap at all.
// -------------------------------------------------------------------------

export const SUMBLE_ACCOUNT_INTEL_RESOLVE_ORGANIZATION_DEFINITION: ToolDefinition =
  {
    name: "sumble_account_intel_resolve_organization",
    description:
      "Resolve the researched account to a Sumble organization by domain or slug. Fatal — downstream steps read the resolved org record, so a failed lookup fails the run.",
    inputSchema: {
      type: "object",
      properties: {
        organizationDomain: {
          type: "string",
          description:
            "Company domain or Sumble org slug to resolve, verbatim from the intake field.",
        },
      },
      required: ["organizationDomain"],
    },
  };

function createResolveOrganizationTool(sumble: AgentToolRunner): AgentTool {
  return {
    kind: "full",
    definition: SUMBLE_ACCOUNT_INTEL_RESOLVE_ORGANIZATION_DEFINITION,
    handler: async (call, signal) => {
      const args = coerceArgsObject(call.arguments);
      const identifier = args.organizationDomain;
      if (typeof identifier !== "string" || identifier.trim().length === 0) {
        return {
          callId: call.id,
          isError: true,
          content: "organizationDomain is required",
        };
      }
      return runFatalPassthrough(
        sumble,
        "sumble_resolve_organization",
        call.id,
        { identifier },
        signal,
      );
    },
  };
}

// -------------------------------------------------------------------------
// contacts (search_people) — fatal. Same slug rename as teams/jobs/signals,
// but load-bearing: the enrich-contacts step iterates this step's `people`
// array, so a failed lookup must still fail the run.
// -------------------------------------------------------------------------

export const SUMBLE_ACCOUNT_INTEL_SEARCH_PEOPLE_DEFINITION: ToolDefinition = {
  name: "sumble_account_intel_search_people",
  description:
    "Find people at the resolved organization. Fatal — the enrich-contacts step iterates this step's structured `people` array, so a failed lookup fails the run rather than feeding it a non-array.",
  inputSchema: {
    type: "object",
    properties: {
      slug: {
        type: "string",
        description:
          "The resolved organization's own `slug` field, passed through verbatim.",
      },
      limit: {
        type: "number",
        description: "Maximum number of people to return. Defaults to 10.",
      },
    },
    required: ["slug"],
  },
};

function createSearchPeopleTool(sumble: AgentToolRunner): AgentTool {
  return {
    kind: "full",
    definition: SUMBLE_ACCOUNT_INTEL_SEARCH_PEOPLE_DEFINITION,
    handler: async (call, signal) => {
      const args = coerceArgsObject(call.arguments);
      const slug = args.slug;
      if (typeof slug !== "string" || slug.trim().length === 0) {
        return { callId: call.id, isError: true, content: "slug is required" };
      }
      const limit = typeof args.limit === "number" ? args.limit : 10;
      return runFatalPassthrough(
        sumble,
        "sumble_search_people",
        call.id,
        { organizationSlug: slug, limit },
        signal,
      );
    },
  };
}

// -------------------------------------------------------------------------
// teams / jobs / signals — best-effort. Each is a thin, non-throwing wrapper:
// the underlying Sumble call's failure becomes a `{ ok: false, error }`
// envelope inside a SUCCESSFUL ToolResult (outer `isError` stays false), not a
// thrown error or an outer `isError: true` — the native `action` dispatch path
// (`runDeterministicToolStep` in apps/sidecar/src/step-tool-harness.ts) throws
// on any tool result with `isError: true` when `nonFatal` is not set, and a
// native `action` step has no `nonFatal` tag to set. Swallowing the failure
// INSIDE the tool's own content is what keeps the facet best-effort.
// -------------------------------------------------------------------------

function facetDefinition(name: string, description: string): ToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description:
            "The resolved organization's own `slug` field, passed through verbatim.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 25.",
        },
      },
      required: ["slug"],
    },
  };
}

function createFacetTool(
  definition: ToolDefinition,
  underlyingToolName: string,
  runner: AgentToolRunner,
): AgentTool {
  return {
    kind: "full",
    definition,
    handler: async (call, signal) => {
      const args = coerceArgsObject(call.arguments);
      const slug = args.slug;
      if (typeof slug !== "string" || slug.trim().length === 0) {
        return {
          callId: call.id,
          isError: false,
          content: { ok: false, error: "slug is required" },
        };
      }
      const limit = typeof args.limit === "number" ? args.limit : 25;
      const envelope = await runTolerantTool(
        runner,
        underlyingToolName,
        call.id,
        { organizationSlug: slug, limit },
        signal,
      );
      return { callId: call.id, isError: false, content: envelope };
    },
  };
}

export const SUMBLE_ACCOUNT_INTEL_LIST_TEAMS_DEFINITION = facetDefinition(
  "sumble_account_intel_list_teams",
  "List the resolved organization's teams. Best-effort — a failed lookup returns a `{ ok: false, error }` envelope instead of failing the run; `synthesize` writes the brief from whichever facets succeeded.",
);

export const SUMBLE_ACCOUNT_INTEL_LIST_JOBS_DEFINITION = facetDefinition(
  "sumble_account_intel_list_jobs",
  "List the resolved organization's open jobs. Best-effort — a failed lookup returns a `{ ok: false, error }` envelope instead of failing the run; `synthesize` writes the brief from whichever facets succeeded.",
);

export const SUMBLE_ACCOUNT_INTEL_SEARCH_SIGNALS_DEFINITION = facetDefinition(
  "sumble_account_intel_search_signals",
  "Scan the resolved organization's buying/intent signals. Best-effort — a failed lookup returns a `{ ok: false, error }` envelope instead of failing the run; `synthesize` writes the brief from whichever facets succeeded.",
);

// -------------------------------------------------------------------------
// enrich-contacts — best-effort, and folds the former `map` over
// `x_search` into one tool that iterates internally. `MapPrimitive.step` is
// typed `StepPrimitive` (not the `Primitive` union) in
// `interchange/packages/workflow/src/definition/primitives.ts`, and the
// deploy capability walk (`extractAgent` in
// `interchange/packages/workflow-deploy/src/capability-walk.ts`) only reads
// `primitive.step.agent` for a map node — an `action` cannot be a map's inner
// step at all. Moving the per-contact loop inside this tool (mirroring
// `granola_spawn_call_runs`'s in-tool fan-out) turns the whole facet into one
// plain `action` step and drops the `map` entirely.
// -------------------------------------------------------------------------

export const SUMBLE_ACCOUNT_INTEL_ENRICH_CONTACTS_DEFINITION: ToolDefinition = {
  name: "sumble_account_intel_enrich_contacts",
  description:
    "Enrich each Sumble contact with an X/Twitter search (Sumble gives LinkedIn only). Iterates internally — one X search per contact. Best-effort per contact: a dead xAI call for one contact never fails the run or the other contacts' results.",
  inputSchema: {
    type: "object",
    properties: {
      people: {
        type: "array",
        description:
          "The contacts step's structured `people` array (each item at least has a `name` field).",
        items: { type: "object" },
      },
    },
    required: ["people"],
  },
};

function isContactWithName(
  value: unknown,
): value is { name: string } & Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).name === "string" &&
    (value as Record<string, unknown>).name !== ""
  );
}

const ENRICH_CONTACTS_X_SEARCH_LIMIT = 5;

/**
 * `xai` is resolved LAZILY, inside the handler, never at factory-construction
 * time (a correctness fix). enrich-contacts is documented best-effort —
 * "a dead xAI call for one contact never fails the run or the other
 * contacts' results" — but the ORIGINAL wiring resolved the `xai` credential
 * eagerly in `interchange-tools.ts`'s factory, so a tenant with no xAI
 * credential configured at all threw `ToolCredentialMissingError` while
 * building the whole tool package — dropping not just enrich-contacts but
 * also the genuinely-required `resolve`/`search_people`/facet tools sharing
 * this factory. Resolving `xai` here instead means a missing credential
 * degrades every contact's envelope, exactly like a dead call would, while
 * leaving the rest of the package (and the `sumble` credential it needs)
 * unaffected.
 */
function createEnrichContactsTool(env: Record<string, unknown>): AgentTool {
  return {
    kind: "full",
    definition: SUMBLE_ACCOUNT_INTEL_ENRICH_CONTACTS_DEFINITION,
    handler: async (call, signal) => {
      const args = coerceArgsObject(call.arguments);
      const people = Array.isArray(args.people) ? args.people : [];
      let xRunner: AgentToolRunner;
      try {
        const credential = getToolCredential(env, "xai");
        xRunner = createToolRunner(
          createXTools({
            apiKey: credential.apiKey,
            baseURL: credential.baseURL,
          }),
        );
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const results = people.map((person: unknown) => ({
          ok: false as const,
          error,
          name: isContactWithName(person) ? person.name : undefined,
        }));
        return {
          callId: call.id,
          isError: false,
          content: { people: results },
        };
      }
      const results = await Promise.all(
        people.map(async (person: unknown, index: number) => {
          if (!isContactWithName(person)) {
            return { ok: false as const, error: "contact is missing a name" };
          }
          const envelope = await runTolerantTool(
            xRunner,
            "x_search",
            `${call.id}-${index}`,
            { query: person.name, limit: ENRICH_CONTACTS_X_SEARCH_LIMIT },
            signal,
          );
          return { ...envelope, name: person.name };
        }),
      );
      return { callId: call.id, isError: false, content: { people: results } };
    },
  };
}

/** Workflow-owned tools private to sumble-account-intel. `env` is the
 * sidecar-injected factory env, forwarded so enrich-contacts can resolve its
 * `xai` credential lazily inside its own handler (see above). */
export function createSumbleAccountIntelTools(
  config: SumbleAccountIntelToolsConfig,
  env: Record<string, unknown>,
): AgentTool[] {
  const sumbleRunner = createToolRunner(createSumbleTools(config.sumble));
  return [
    createSumbleAccountIntelFormatReportDocumentTool(),
    createPrepareReviewGateTool(),
    createResolveOrganizationTool(sumbleRunner),
    createSearchPeopleTool(sumbleRunner),
    createFacetTool(
      SUMBLE_ACCOUNT_INTEL_LIST_TEAMS_DEFINITION,
      "sumble_list_teams",
      sumbleRunner,
    ),
    createFacetTool(
      SUMBLE_ACCOUNT_INTEL_LIST_JOBS_DEFINITION,
      "sumble_list_jobs",
      sumbleRunner,
    ),
    createFacetTool(
      SUMBLE_ACCOUNT_INTEL_SEARCH_SIGNALS_DEFINITION,
      "sumble_search_signals",
      sumbleRunner,
    ),
    createEnrichContactsTool(env),
  ];
}
