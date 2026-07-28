// Tolerant sumble bridges for prospect-engine's former `nonFatal` list
// steps (pipeline / growthList / enterpriseList / addGrowth / addEnterprise).
// Split into its own npm package (rather than living inside
// `@workbench/tools-prospect-engine`) because the tool-manifest system pins
// exactly one credential provider per npm package
// (`packages/tool-manifest/src/derive.ts`'s `derivePackageProviders` throws
// on a package declaring two different providers) — `@workbench/tools-
// prospect-engine`'s own factory is already provider-less (`null`), so a
// sumble-credentialed bridge cannot live in the same package.
//
// `ActionPrimitive` has no error-swallow (`apps/sidecar/src/action-tool-
// handler.ts` awaits `ctx.perform` with no catch, and `runDeterministicTool
// Step` throws whenever the dispatched tool's outer `ToolResult.isError` is
// true — `step-tool-harness.ts`, unconditionally on the action path). So
// each bridge below invokes the real `sumble_*` tool in-process (this
// package declares the `sumble` credential in its own `requires`, exactly
// as `@workbench/tools-sumble`'s own `defineCredentialedToolPackage` factory
// does — `buildStepTools` fetches whatever every pinned factory's `requires`
// asks for, regardless of which factory owns the tool) and NEVER lets the
// outer envelope's `isError` become true: a thrown error or an `isError`
// result is caught and turned into a successful outer `ToolResult` whose
// `content` carries `{ isError: true, error }` instead.
//
// A native `action` step's `input` selector DSL has no rename primitive
// (`@intx/workflow`'s `FromSelector`/`ProjectSelector`/`MergeSelector`/
// `LiteralSelector` can only read a dot path, project a whitelist of
// existing keys, or merge whole objects) — so each bridge accepts the
// upstream fields verbatim and remaps them to the wrapped tool's arg names
// itself.

import {
  type AgentTool,
  type AnnotatedToolFactory,
  createToolRunner,
  defineTool,
} from "@intx/agent";
import type { ToolCall, ToolDefinition } from "@intx/types/runtime";
import {
  getToolCredential,
  toolCredentialEnvKey,
} from "@workbench/tool-credentials";
import {
  findAgentTool,
  invokeAgentTool,
  toleranceFailureContent,
  withToleranceEnvelope as tolerant,
} from "@workbench/tool-credentials/tolerance-envelope-dispatch";
import { SUMBLE_HUB_TOOLS } from "@workbench/tools-sumble";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function envRecord(env: unknown): Record<string, unknown> {
  return env as Record<string, unknown>;
}

// `tolerant`/`invokeAgentTool`/`findAgentTool` are the shared dispatch
// mechanics from `@workbench/tool-credentials/tolerance-envelope-dispatch`
// (Finding 2 follow-up) — this file, the slack bridge package, and
// `tools-prospect-engine`'s own `tolerant-bridges.ts` each carried a
// byte-identical local copy before this consolidation.

// ---------------------------------------------------------------------------
// sumble_get_organization_list bridge (pipeline, growthList, enterpriseList)
// ---------------------------------------------------------------------------

export const PROSPECT_ENGINE_READ_ORG_LIST_TOLERANT_DEFINITION: ToolDefinition =
  {
    name: "prospect_engine_read_organization_list_tolerant",
    description:
      "Tolerant wrapper over sumble_get_organization_list for the prospect-engine list reads (pipeline / growth / enterprise). Accepts an object carrying `listId`, or the intake field names `growthEngineListId` / `enterpriseEngineListId` (numeric or numeric-string). Any failure returns { isError: true, error } instead of throwing, so dedupe/extractListOrgs still degrade to an empty org-id list rather than failing the run.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
    },
  };

/**
 * Coerce a Sumble list id to the number the underlying tool requires.
 * Accepts finite numbers and non-empty numeric strings.
 */
function coerceListId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * Pull a list id out of object-shaped tool args. The selector DSL has no
 * rename primitive, so growthList/enterpriseList project intake fields
 * (`growthEngineListId` / `enterpriseEngineListId`) and pipeline uses
 * `{ listId }`. Bare scalars never reach this path — step-tool-harness
 * rejects non-object action inputs before dispatch.
 */
function extractListId(input: unknown): number | undefined {
  if (!isRecord(input)) return undefined;
  for (const key of [
    "listId",
    "growthEngineListId",
    "enterpriseEngineListId",
  ] as const) {
    const n = coerceListId(input[key]);
    if (n !== undefined) return n;
  }
  return undefined;
}

/**
 * Build the real `sumble_get_organization_list` tool LAZILY, inside the
 * handler — never at factory-construction time (a correctness fix).
 * `getToolCredential` throws `ToolCredentialMissingError` the instant the
 * tenant has no `sumble` credential configured; if that throw happened here
 * (as it originally did, eagerly in `factory`), the sidecar's
 * `buildStepTools` would silently drop this whole bridge package and the
 * step would hard-fail with `StepToolCredentialMissingError` — strictly
 * worse than the `nonFatal` degrade this migration replaces. Resolving the
 * credential inside `tolerant`'s try/catch instead means a missing
 * credential degrades to the same `{ isError: true, error }` envelope as
 * any other bridge failure.
 */
function buildReadOrgListTool(env: Record<string, unknown>): AgentTool {
  const credential = getToolCredential(env, "sumble");
  const entry = SUMBLE_HUB_TOOLS.sumble_get_organization_list;
  if (entry === undefined) {
    throw new Error(
      "prospect-engine sumble-list-bridge: sumble_get_organization_list is not registered in SUMBLE_HUB_TOOLS",
    );
  }
  const tools = entry.createTools(credential);
  return findAgentTool(
    tools,
    "sumble_get_organization_list",
    "prospect-engine sumble-list-bridge",
  );
}

export const prospectEngineSumbleListBridge: AnnotatedToolFactory = defineTool({
  id: "@workbench/tools-prospect-engine-sumble-bridge/list",
  requires: [toolCredentialEnvKey("sumble")],
  factory: (env) => {
    const record = envRecord(env);
    return createToolRunner([
      {
        kind: "full",
        definition: PROSPECT_ENGINE_READ_ORG_LIST_TOLERANT_DEFINITION,
        handler: async (call: ToolCall, signal: AbortSignal) => {
          const listId = extractListId(call.arguments);
          if (listId === undefined) {
            return {
              callId: call.id,
              isError: false,
              content: toleranceFailureContent("listId is required"),
            };
          }
          return tolerant(call.id, () =>
            invokeAgentTool(
              buildReadOrgListTool(record),
              {
                id: call.id,
                name: "sumble_get_organization_list",
                arguments: { listId },
              },
              signal,
            ),
          );
        },
      },
    ]);
  },
});

// ---------------------------------------------------------------------------
// sumble_add_organization_list_organizations bridge (addGrowth, addEnterprise)
// ---------------------------------------------------------------------------

export const PROSPECT_ENGINE_ADD_ORG_LIST_TOLERANT_DEFINITION: ToolDefinition =
  {
    name: "prospect_engine_add_organization_list_tolerant",
    description:
      "Tolerant wrapper over sumble_add_organization_list_organizations for the prospect-engine Growth/Enterprise list writes. Accepts `lane` ('growth' | 'enterprise') plus the merged trigger payload (growthEngineListId / enterpriseEngineListId) and formatReport output (growthOrganizationIds / enterpriseOrganizationIds), and picks the lane-matching pair itself — no reshape step needed. Any failure returns { isError: true, error } instead of throwing; this write is one of several nightly outputs (the report + ledger persist regardless).",
    inputSchema: {
      type: "object",
      properties: {
        lane: { type: "string", enum: ["growth", "enterprise"] },
      },
      required: ["lane"],
      additionalProperties: true,
    },
  };

/**
 * Same lazy-construction fix as `buildReadOrgListTool` above: the
 * credential is resolved inside `tolerant`'s try/catch, not at
 * factory-construction time, so a missing `sumble` credential degrades this
 * bridge's own tool instead of dropping the whole package.
 */
function buildAddOrgListTool(env: Record<string, unknown>): AgentTool {
  const credential = getToolCredential(env, "sumble");
  const entry = SUMBLE_HUB_TOOLS.sumble_add_organization_list_organizations;
  if (entry === undefined) {
    throw new Error(
      "prospect-engine sumble-add-bridge: sumble_add_organization_list_organizations is not registered in SUMBLE_HUB_TOOLS",
    );
  }
  const tools = entry.createTools(credential);
  return findAgentTool(
    tools,
    "sumble_add_organization_list_organizations",
    "prospect-engine sumble-add-bridge",
  );
}

export const prospectEngineSumbleAddBridge: AnnotatedToolFactory = defineTool({
  id: "@workbench/tools-prospect-engine-sumble-bridge/add",
  requires: [toolCredentialEnvKey("sumble")],
  factory: (env) => {
    const record = envRecord(env);
    return createToolRunner([
      {
        kind: "full",
        definition: PROSPECT_ENGINE_ADD_ORG_LIST_TOLERANT_DEFINITION,
        handler: async (call: ToolCall, signal: AbortSignal) => {
          const args = (call.arguments ?? {}) as Record<string, unknown>;
          const lane = args.lane;
          const listId =
            lane === "growth"
              ? args.growthEngineListId
              : args.enterpriseEngineListId;
          const organizationIds =
            lane === "growth"
              ? args.growthOrganizationIds
              : args.enterpriseOrganizationIds;
          if (typeof listId !== "string" || listId.length === 0) {
            return {
              callId: call.id,
              isError: false,
              content: toleranceFailureContent("listId is required"),
            };
          }
          return tolerant(call.id, () =>
            invokeAgentTool(
              buildAddOrgListTool(record),
              {
                id: call.id,
                name: "sumble_add_organization_list_organizations",
                arguments: {
                  listId,
                  organizationIds: Array.isArray(organizationIds)
                    ? organizationIds
                    : [],
                },
              },
              signal,
            ),
          );
        },
      },
    ]);
  },
});
