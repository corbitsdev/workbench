import { createToolRunner, type AgentTool } from "@intx/agent";
import type { ToolDefinition, ToolResult } from "@intx/types/runtime";
import {
  getToolCredential,
  toolCredentialEnvKey,
  ToolCredentialMissingError,
} from "@workbench/tool-credentials";
import { createGranolaTools } from "@workbench/tools-granola";
import { createLinearToolByName } from "@workbench/tools-linear";
import { createAttioTools } from "@workbench/tools-attio";
import { createVercelTools } from "@workbench/tools-vercel";
import {
  formatHeartbeatBriefDocument,
  formatHeartbeatBriefTitle,
  morningBriefNotifyMail,
  toleranceFailureContent,
  WIRED_BRIEF_SOURCES,
} from "./heartbeat-shared";

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

export const HEARTBEAT_FORMAT_BRIEF_NOTIFY_DEFINITION: ToolDefinition = {
  name: "heartbeat_format_brief_notify",
  description:
    "Internal heartbeat workflow helper. Builds the morning-brief notify mail's exact mail_send argument shape ({ to, subject, content, refs }) from the firing user's address, the composed brief document, and the persisted artifact id, so the notify step reads this tool's output verbatim.",
  inputSchema: {
    type: "object",
    properties: {
      userAddress: {
        type: "string",
        description: "The firing user's usr_ mail address.",
      },
      title: {
        type: "string",
        description: "The brief's display title (mail subject).",
      },
      body: {
        type: "string",
        description: "The brief's body (mail content).",
      },
      artifactId: {
        type: "string",
        description: "Persisted morning-brief artifact id from write_artifact.",
      },
      runId: {
        type: "string",
        description:
          "Workflow run id from the hub trigger payload (same as mail messageId).",
      },
      workflowLabel: {
        type: "string",
        description:
          "Display label for the workflow_run ref (defaults to Company Heartbeat).",
      },
    },
    required: ["userAddress", "title", "body", "artifactId", "runId"],
  },
};

export const HEARTBEAT_FORMAT_BRIEF_DOCUMENT_DEFINITION: ToolDefinition = {
  name: "heartbeat_format_brief_document",
  description:
    "Internal heartbeat workflow helper. Pairs the title step's title with the brief agent's reply into the { title, body } shape write_artifact and the notify-mail step expect, so neither downstream step reshapes the agent's reply field.",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description:
          "The brief's display title from heartbeat_format_brief_title.",
      },
      reply: {
        type: "string",
        description: "The brief agent's synthesized reply text.",
      },
    },
    required: ["title", "reply"],
  },
};

export const HEARTBEAT_FORMAT_BRIEF_TITLE_DEFINITION: ToolDefinition = {
  name: "heartbeat_format_brief_title",
  description:
    'Internal heartbeat workflow helper. Formats the morning brief\'s display name as "<User>\'s Morning Brief - DD/MM/YY" (falls back to "Your Morning Brief - DD/MM/YY" when no display name is known), for use as both the notify mail subject and the persisted artifact title.',
  inputSchema: {
    type: "object",
    properties: {
      userDisplayName: {
        type: "string",
        description: "The firing user's display name, if known.",
      },
    },
  },
};

function createHeartbeatFormatBriefNotifyTool(): AgentTool {
  return {
    kind: "full",
    definition: HEARTBEAT_FORMAT_BRIEF_NOTIFY_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const userAddress = args.userAddress;
      const title = args.title;
      const body = args.body;
      const artifactId = args.artifactId;
      const runId = args.runId;
      const workflowLabel =
        typeof args.workflowLabel === "string" ? args.workflowLabel : undefined;
      for (const [name, value] of [
        ["userAddress", userAddress],
        ["title", title],
        ["body", body],
        ["artifactId", artifactId],
        ["runId", runId],
      ] as const) {
        if (typeof value !== "string" || value.trim().length === 0) {
          return {
            callId: call.id,
            isError: true,
            content: `${name} is required`,
          };
        }
      }
      try {
        const content = morningBriefNotifyMail({
          userAddress: userAddress as string,
          title: title as string,
          body: body as string,
          artifactId: artifactId as string,
          runId: runId as string,
          ...(workflowLabel !== undefined ? { workflowLabel } : {}),
        });
        return { callId: call.id, content };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { callId: call.id, isError: true, content: message };
      }
    },
  };
}

function createHeartbeatFormatBriefDocumentTool(): AgentTool {
  return {
    kind: "full",
    definition: HEARTBEAT_FORMAT_BRIEF_DOCUMENT_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const title = args.title;
      const reply = args.reply;
      if (typeof title !== "string" || title.trim().length === 0) {
        return { callId: call.id, isError: true, content: "title is required" };
      }
      if (typeof reply !== "string" || reply.trim().length === 0) {
        return { callId: call.id, isError: true, content: "reply is required" };
      }
      try {
        const content = formatHeartbeatBriefDocument(title, reply);
        return { callId: call.id, content };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { callId: call.id, isError: true, content: message };
      }
    },
  };
}

function createHeartbeatFormatBriefTitleTool(): AgentTool {
  return {
    kind: "full",
    definition: HEARTBEAT_FORMAT_BRIEF_TITLE_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const userDisplayName =
        typeof args.userDisplayName === "string"
          ? args.userDisplayName
          : undefined;
      const title = formatHeartbeatBriefTitle(userDisplayName, Date.now());
      return { callId: call.id, content: { title } };
    },
  };
}

/** Workflow-owned tools private to heartbeat, needing no credential. */
export function createHeartbeatTools(): AgentTool[] {
  return [
    createHeartbeatFormatBriefTitleTool(),
    createHeartbeatFormatBriefDocumentTool(),
    createHeartbeatFormatBriefNotifyTool(),
  ];
}

// ---------------------------------------------------------------------------
// Best-effort, in-process intake wrapper.
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
// exactly the per-source shape `mergeHeartbeatBriefSources` (`./heartbeat-
// shared`) already expects to find per source once it unwraps the step's
// (now always-successful) envelope.
//
// It resolves the named source's own tool credential in-process — the
// source packages' `create*Tools(config)` functions are plain,
// dependency-light functions exported from each package's "." entrypoint,
// the same sanctioned pattern `defineCredentialedToolPackage`
// (`packages/tool-credentials/src/factory.ts`) uses — and dispatches through
// `createToolRunner` so a thrown source-tool error is caught into a result
// this wrapper can then re-flatten into `content`, never re-throwing it.
//
// Constructed LAZILY inside the handler (never at factory-construction time):
// eager construction of a credentialed inner tool package at factory level
// would drop the whole wrapper (and hard-fail the step) whenever any one
// source credential is missing.
// ---------------------------------------------------------------------------

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
      `heartbeat tools: WIRED_BRIEF_SOURCES has no SOURCE_TOOL_BUILDERS entry for: ${missing.join(", ")}. Add a builder in workflows/heartbeat/src/tools.ts.`,
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
