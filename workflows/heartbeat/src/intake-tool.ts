// Best-effort, in-process intake wrapper (CL-4464).
//
// `ActionPrimitive` has no `nonFatal` field (@intx/workflow's primitives.ts).
// Action dispatch runs through the same `runDeterministicToolStep`
// (apps/sidecar/src/step-tool-harness.ts) deterministicToolStep uses, and that
// function THROWS whenever the dispatched tool's outer `ToolResult.isError`
// is `true` — `nonFatal` is the only escape, and `ActionOpts` has no such
// field, so a native action's dispatched tool must never set the outer
// `isError`, not even by throwing (the sidecar's tool runner converts a
// thrown handler error into `isError: true` — see `createToolRunner`,
// interchange/packages/agent/src/tool.ts — which would hit the same throw).
// So this tool's contract is: ALWAYS return a completed, non-error
// `ToolResult`; a missing/rejected source credential or a source-side
// failure is carried INSIDE `content` as `{ isError: true, error }` instead —
// exactly the per-source shape `mergeHeartbeatBriefSources`
// (`@workbench/shared`'s `heartbeat-brief-merge.ts`) already expects to find
// per source once it unwraps the step's (now always-successful) envelope.
//
// It resolves the named source's own tool credential in-process — the
// source packages' `create*Tools(config)` functions are plain,
// dependency-light functions exported from each package's "." entrypoint,
// the same sanctioned pattern `defineCredentialedToolPackage`
// (`packages/tool-credentials/src/factory.ts`) uses — and dispatches through
// `createToolRunner` so a thrown source-tool error is caught into a result
// this wrapper can then re-flatten into `content`, never re-throwing it.
//
// One wrapper tool, parameterized by `tool` name, rather than one hand-written
// copy per source: every wired source shares the same fetch-tool contract
// (`BriefSourceFetchInputSchema` — `{ enabledSources?, createdAfter? }`, see
// `@workbench/shared`'s `HEARTBEAT_BRIEF_SOURCE_FETCH_ARG_MAP`) and the same
// credential shape (`ToolCredential` — `{ apiKey, baseURL }`), so a single
// `{ tool, enabledSources?, createdAfter? }` handler dispatches all of them.
// Only the per-provider `createXTools` function reference genuinely differs
// per source package — `SOURCE_TOOL_BUILDERS` below is that (small, honest)
// per-source table; `assertSourceToolBuildersCoverWiredSources` fails loudly
// at module load if a `WIRED_BRIEF_SOURCES` entry has no builder registered,
// so a newly-wired source can't silently fall through to "unknown source
// tool" at runtime.
import { createToolRunner, type AgentTool } from "@intx/agent";
import type { ToolDefinition, ToolResult } from "@intx/types/runtime";
import {
  getToolCredential,
  toolCredentialEnvKey,
  ToolCredentialMissingError,
} from "@workbench/tool-credentials";
import { WIRED_BRIEF_SOURCES, toleranceFailureContent } from "@workbench/shared";
import { createGranolaTools } from "@workbench/tools-granola";
import { createLinearToolByName } from "@workbench/tools-linear";
import { createAttioTools } from "@workbench/tools-attio";
import { createVercelTools } from "@workbench/tools-vercel";

type SourceCredentialConfig = { apiKey: string; baseUrl?: string };
type SourceToolBuilder = (config: SourceCredentialConfig) => AgentTool[];

/** Per-source-package `create*Tools` reference, keyed by the wired fetch tool name. */
const SOURCE_TOOL_BUILDERS: Record<
  string,
  { providerName: string; build: SourceToolBuilder }
> = {
  granola_list_notes: { providerName: "granola", build: createGranolaTools },
  linear_list_issues: {
    providerName: "linear",
    build: (config) => createLinearToolByName(config, "linear_list_issues"),
  },
  attio_recent_activity: { providerName: "attio", build: createAttioTools },
  vercel_list_deployments: { providerName: "vercel", build: createVercelTools },
};

function assertSourceToolBuildersCoverWiredSources(): void {
  const missing = WIRED_BRIEF_SOURCES.filter(
    (source) => SOURCE_TOOL_BUILDERS[source.tool] === undefined,
  ).map((source) => source.tool);
  if (missing.length > 0) {
    throw new Error(
      `heartbeat intake-tool: WIRED_BRIEF_SOURCES has no SOURCE_TOOL_BUILDERS entry for: ${missing.join(", ")}. Add a builder in workflows/heartbeat/src/intake-tool.ts.`,
    );
  }
}
assertSourceToolBuildersCoverWiredSources();

/** Provider names every wired source needs a resolved tool credential for. */
export const HEARTBEAT_INTAKE_SOURCE_PROVIDERS: readonly string[] = [
  ...new Set(Object.values(SOURCE_TOOL_BUILDERS).map((e) => e.providerName)),
].sort();

/** `requires` entries for the wrapper factory — one env key per wired provider. */
export const HEARTBEAT_INTAKE_SOURCE_ENV_KEYS: readonly string[] =
  HEARTBEAT_INTAKE_SOURCE_PROVIDERS.map(toolCredentialEnvKey);

export const HEARTBEAT_INTAKE_SOURCE_DEFINITION: ToolDefinition = {
  name: "heartbeat_intake_source",
  description:
    "Internal heartbeat workflow helper. Best-effort fetch for one wired brief source: resolves the named source tool's credential and invokes it in-process. This tool ALWAYS completes successfully (isError is never true) — a missing/rejected credential or a source-side error is carried inside the returned content as { isError: true, error } instead, so one source's outage degrades the brief to a 'not available' note instead of failing the whole unattended heartbeat run.",
  inputSchema: {
    type: "object",
    properties: {
      tool: {
        type: "string",
        description:
          "The wired source's fetch tool name (e.g. granola_list_notes).",
      },
      enabledSources: {
        type: "array",
        items: { type: "string" },
        description:
          "The firing member's currently-enabled brief source keys, forwarded verbatim to the source tool.",
      },
      createdAfter: {
        type: "string",
        description:
          "The heartbeat's fire-time lookback cutoff, forwarded verbatim to the source tool.",
      },
    },
    required: ["tool"],
  },
};

function degraded(callId: string, error: string): ToolResult {
  return { callId, isError: false, content: toleranceFailureContent(error) };
}

function resultContent(callId: string, content: unknown): ToolResult {
  if (typeof content === "string") {
    return { callId, isError: false, content };
  }
  return { callId, isError: false, content: JSON.stringify(content) };
}

/**
 * Builds the wrapper `AgentTool`. `env` is the sidecar-injected factory env
 * (shared across every factory loaded for this step, keyed by
 * `workbench.cred.<provider>` — see `@workbench/tool-credentials`), so the
 * same credential value `@workbench/tools-granola/granola`'s own factory
 * would have read is available here too.
 */
export function createHeartbeatIntakeSourceTool(
  env: Record<string, unknown>,
): AgentTool {
  return {
    kind: "full",
    definition: HEARTBEAT_INTAKE_SOURCE_DEFINITION,
    handler: async (call, signal) => {
      const args = call.arguments;
      const toolName = args.tool;
      if (typeof toolName !== "string" || toolName.trim().length === 0) {
        return degraded(call.id, "heartbeat_intake_source: tool is required");
      }
      const entry = SOURCE_TOOL_BUILDERS[toolName];
      if (entry === undefined) {
        return degraded(
          call.id,
          `heartbeat_intake_source: unknown source tool "${toolName}"`,
        );
      }
      let credential;
      try {
        credential = getToolCredential(env, entry.providerName);
      } catch (err) {
        if (err instanceof ToolCredentialMissingError) {
          return degraded(
            call.id,
            `source unavailable: no ${entry.providerName} credential configured`,
          );
        }
        return degraded(
          call.id,
          err instanceof Error ? err.message : String(err),
        );
      }
      const runner = createToolRunner(
        entry.build({ apiKey: credential.apiKey, baseUrl: credential.baseURL }),
      );
      const forwardArgs: Record<string, unknown> = {};
      if (args.enabledSources !== undefined) {
        forwardArgs.enabledSources = args.enabledSources;
      }
      if (args.createdAfter !== undefined) {
        forwardArgs.createdAfter = args.createdAfter;
      }
      const result = await runner.run(
        { id: call.id, name: toolName, arguments: forwardArgs },
        signal,
      );
      if (result.isError) {
        const message =
          typeof result.content === "string"
            ? result.content
            : JSON.stringify(result.content);
        return degraded(call.id, message);
      }
      return resultContent(call.id, result.content);
    },
  };
}
