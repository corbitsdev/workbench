// Tolerant bridge tools for prospect-engine's readLedger and mail steps
// (the pipeline/growthList/enterpriseList/addGrowth/addEnterprise
// sumble bridges live in `@workbench/tools-prospect-engine-sumble-bridge`,
// and the notify slack bridge in
// `@workbench/tools-prospect-engine-slack-bridge` — split into their own npm
// packages because the tool-manifest system pins exactly one credential
// provider per npm package, and this package's own factory is already
// provider-less). `ActionPrimitive` has no error-swallow
// (`apps/sidecar/src/action-tool-handler.ts` awaits `ctx.perform` with no
// catch), and `runDeterministicToolStep` throws whenever the dispatched
// tool's outer `ToolResult.isError` is true — unconditionally on the action
// path (`step-tool-harness.ts`).
//
// The fix moves the tolerance INSIDE a tool this workflow owns: each bridge
// below is its own `defineTool` factory (same env-DI shape
// `@workbench/tool-credentials/factory`'s `defineCredentialedToolPackage` /
// `defineHubBackedToolPackage` use), invokes the real underlying tool
// in-process against the SAME env the sidecar's `buildStepTools` already
// resolves for every pinned package in a step (`step-tool-harness.ts`
// builds one `factoryEnv` — agent env + fetched tool credentials + hub-RPC
// context — and calls every pinned factory with it), and catches both a
// thrown error and an `isError` `ToolResult` into a plain, SUCCESSFUL outer
// `ToolResult` whose `content` carries `{ isError: true, error }` instead —
// the outer envelope's `isError` is never set to true. The step then never
// throws and converts cleanly to a native `action` — one call per step,
// unchanged checkpoints.
//
// A native `action` step's `input` selector DSL (`@intx/workflow`'s
// `FromSelector`/`ProjectSelector`/`MergeSelector`/`LiteralSelector`) has no
// rename primitive — it can only read a dot path, project a whitelist of
// existing keys, or merge whole objects. So each bridge below accepts the
// upstream step's field names verbatim (`text`, `title`, `userAddress`, …)
// and remaps them to the wrapped tool's own arg names INSIDE the handler,
// where a plain rename is just code.
//
// Duplication of the underlying tool's dispatch shape (hub-RPC forward) is
// deliberate: this workflow owns its tolerance, the shared tool packages
// (`@workbench/tools-artifact`, `@intx/tools-mail`) keep throwing for every
// other caller (multi-source-collateral's `artifact_read`, heartbeat's
// `mail_send`, etc).

import {
  type AnnotatedToolFactory,
  createToolRunner,
  defineTool,
} from "@intx/agent";
import type { ToolCall, ToolDefinition, ToolResult } from "@intx/types/runtime";
import { createRuntimeCapabilities } from "@intx/types/runtime-capabilities";
import type { MessageTransport } from "@intx/types/runtime";
import { createMailTools } from "@intx/tools-mail";
import { HUB_RPC_ENV_KEY, getHubRpc } from "@workbench/tool-credentials";
import { withToleranceEnvelope as tolerant } from "@workbench/tool-credentials/tolerance-envelope-dispatch";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function envRecord(env: unknown): Record<string, unknown> {
  return env as Record<string, unknown>;
}

// `tolerant` (`withToleranceEnvelope` from
// `@workbench/tool-credentials/tolerance-envelope-dispatch`) converts any
// thrown error or `isError: true` result into a normal (non-error)
// `ToolResult` whose content carries the shared `{ isError: true, error }`
// tolerance envelope — see Finding 2 follow-up: this was previously
// a byte-identical local copy in this file and in both prospect-engine
// bridge packages.

// ---------------------------------------------------------------------------
// artifact_read bridge (readLedger)
// ---------------------------------------------------------------------------

export const PROSPECT_ENGINE_READ_LEDGER_TOLERANT_DEFINITION: ToolDefinition = {
  name: "prospect_engine_read_ledger_tolerant",
  description:
    "Tolerant wrapper over artifact_read for the prospect-engine ledger read. Accepts findLedger's raw step output (content may be absent — cold start, no ledger yet). Any failure (network, hub error, missing artifact) returns { isError: true, error } instead of throwing, so parseLedger still degrades to an empty ledger rather than failing the run.",
  inputSchema: {
    type: "object",
    additionalProperties: true,
  },
};

/**
 * Minimal re-implementation of `defineHubBackedToolPackage`'s HTTP forward
 * (`packages/tool-credentials/src/factory.ts`) for a single named tool —
 * this workflow's own tolerant copy, deliberately duplicated rather than
 * shared.
 */
async function forwardHubTool(args: {
  env: Record<string, unknown>;
  toolName: string;
  toolArguments: unknown;
  signal: AbortSignal;
}): Promise<ToolResult> {
  const ctx = getHubRpc(args.env);
  const res = await fetch(`${ctx.baseURL}/api/internal/hub-tools/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ctx.token}`,
    },
    body: JSON.stringify({
      tenantId: ctx.tenantId,
      agentId: ctx.agentId,
      principalId: ctx.principalId,
      sessionId: ctx.sessionId,
      toolName: args.toolName,
      args: args.toolArguments,
    }),
    signal: args.signal,
  });
  if (!res.ok) {
    return {
      callId: "",
      isError: true,
      content: `hub tool ${args.toolName} failed: ${String(res.status)} ${await res.text()}`,
    };
  }
  const parsed = (await res.json()) as {
    result: string;
    isError: boolean;
    structuredResult?: Record<string, unknown>;
  };
  if (parsed.isError) {
    return { callId: "", isError: true, content: parsed.result };
  }
  return {
    callId: "",
    isError: false,
    content: parsed.structuredResult ?? parsed.result,
  };
}

/** Extract findLedger's artifactId from its raw merged step output (`content`
 * may be a JSON string, an already-parsed object, or absent on cold start). */
function extractLedgerArtifactId(
  args: Record<string, unknown>,
): string | undefined {
  if (typeof args.artifactId === "string" && args.artifactId.length > 0) {
    return args.artifactId;
  }
  let content: unknown = args.content;
  if (typeof content === "string") {
    try {
      content = JSON.parse(content);
    } catch {
      return undefined;
    }
  }
  if (isRecord(content) && typeof content.artifactId === "string") {
    return content.artifactId;
  }
  return undefined;
}

export const prospectEngineLedgerBridge: AnnotatedToolFactory = defineTool({
  id: "@workbench/tools-prospect-engine/ledger-bridge",
  requires: [HUB_RPC_ENV_KEY],
  factory: (env) => {
    const record = envRecord(env);
    return createToolRunner([
      {
        kind: "full",
        definition: PROSPECT_ENGINE_READ_LEDGER_TOLERANT_DEFINITION,
        handler: async (call: ToolCall, signal: AbortSignal) => {
          const args = (call.arguments ?? {}) as Record<string, unknown>;
          const artifactId = extractLedgerArtifactId(args);
          if (artifactId === undefined) {
            return {
              callId: call.id,
              isError: false,
              content: {
                skipped: true,
                reason: "no ledger artifact yet (cold start)",
              },
            };
          }
          return tolerant(call.id, () =>
            forwardHubTool({
              env: record,
              toolName: "artifact_read",
              toolArguments: { artifactId },
              signal,
            }),
          );
        },
      },
    ]);
  },
});

// ---------------------------------------------------------------------------
// mail_send bridge (mail)
// ---------------------------------------------------------------------------

export const PROSPECT_ENGINE_SEND_MAIL_TOLERANT_DEFINITION: ToolDefinition = {
  name: "prospect_engine_send_mail_tolerant",
  description:
    "Tolerant wrapper over mail_send for the nightly prospect-engine digest. Accepts the merged step fields verbatim (userAddress, title, text, refs) and remaps them to mail_send's to/subject/content/refs args. Any failure returns { isError: true, error } instead of throwing — mail is one of two delivery channels (Slack is the other), and the report + ledger have already been persisted by the time this runs.",
  inputSchema: {
    type: "object",
    properties: {
      userAddress: { type: "string" },
      title: { type: "string" },
      text: { type: "string" },
      refs: { type: "object" },
    },
    required: ["userAddress", "title", "text"],
  },
};

export const prospectEngineMailBridge: AnnotatedToolFactory = defineTool({
  id: "@workbench/tools-prospect-engine/mail-bridge",
  requires: ["transport", "address"],
  factory: (env) => {
    const record = envRecord(env);
    const transport = record.transport as MessageTransport | undefined;
    return createToolRunner([
      {
        kind: "full",
        definition: PROSPECT_ENGINE_SEND_MAIL_TOLERANT_DEFINITION,
        handler: async (call: ToolCall, signal: AbortSignal) =>
          tolerant(call.id, async () => {
            if (transport === undefined) {
              return {
                callId: call.id,
                isError: true,
                content: "no mail transport configured for this deployment",
              };
            }
            const args = (call.arguments ?? {}) as Record<string, unknown>;
            const mailTools = createMailTools({
              capabilities: createRuntimeCapabilities({
                "mail.transport": transport,
              }),
            });
            try {
              return await mailTools.run(
                {
                  id: call.id,
                  name: "mail_send",
                  arguments: {
                    to: args.userAddress,
                    subject: args.title,
                    content: args.text,
                    ...(args.refs !== undefined ? { refs: args.refs } : {}),
                  },
                },
                signal,
              );
            } finally {
              await mailTools.dispose();
            }
          }),
      },
    ]);
  },
});
