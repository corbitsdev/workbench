import type { AgentTool, BaseEnv } from "@intx/agent";
import type { ToolDefinition, ToolResult } from "@intx/types/runtime";
import {
  defineCredentialedToolPackage,
  defineHubBackedToolPackage,
} from "@workbench/tool-credentials/factory";
import { ARTIFACT_READ_DEFINITION } from "@workbench/tools-artifact";
import { GRANOLA_HUB_TOOLS } from "@workbench/tools-granola";

// Workflow-owned tolerant wrappers (CL-4464): `artifact_read` and
// `granola_get_note` are genuinely fatal elsewhere (multi-source-collateral's
// fetch steps, process-granola-call) — only THIS workflow tolerates a failed
// fetch, because sourceless generation is a supported mode here
// (`GammaIntakePayloadSchema` makes `artifactId`/`noteId`/`text` all
// optional). Rather than the sidecar-wide `nonFatal` tag (no equivalent on
// native `action`), each wrapper calls the real tool in-process — via the
// SAME public factory builder the real tool package uses
// (`defineHubBackedToolPackage` / `defineCredentialedToolPackage`), so the
// call goes over the identical hub-RPC / credentialed rail — and catches the
// failure into a completed, non-error envelope. `skipStepIfAbsent`'s old job
// (no artifactId/noteId at all — a text-only or cross-source intake) is
// folded in here too: the wrapper returns `{ skipped: true }` without
// calling the tool when the id is missing, so a plain `action` (no argMap)
// can host it.

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

function toErrorMessage(result: ToolResult): string {
  const content = result.content;
  if (typeof content === "string") return content;
  if (typeof content === "object" && content !== null) {
    const record = content as Record<string, unknown>;
    if (typeof record.error === "string") return record.error;
  }
  return JSON.stringify(content);
}

export const PRESENTATION_FETCH_ARTIFACT_DEFINITION: ToolDefinition = {
  name: "gamma_presentation_creator_fetch_artifact",
  description:
    "Internal gamma-presentation-creator workflow helper. Loads the chosen artifact by id when one was picked, tolerating a failed or missing artifact (sourceless generation is supported) instead of failing the run.",
  inputSchema: {
    type: "object",
    properties: {
      artifactId: {
        type: "string",
        description: "The artifact id carried on the intake gate, if any.",
      },
    },
  },
};

export const PRESENTATION_FETCH_NOTE_DEFINITION: ToolDefinition = {
  name: "gamma_presentation_creator_fetch_note",
  description:
    "Internal gamma-presentation-creator workflow helper. Loads the chosen Granola note by id when one was picked, tolerating a failed or missing note (sourceless generation is supported) instead of failing the run.",
  inputSchema: {
    type: "object",
    properties: {
      noteId: {
        type: "string",
        description: "The Granola note id carried on the intake gate, if any.",
      },
    },
  },
};

const artifactReadInner = defineHubBackedToolPackage({
  id: "@workbench/tools-gamma-presentation-creator/artifact-read-inner",
  definitions: [ARTIFACT_READ_DEFINITION],
});

const granolaGetNoteInner = defineCredentialedToolPackage({
  id: "@workbench/tools-gamma-presentation-creator/granola-get-note-inner",
  provider: "granola",
  entries: { granola_get_note: GRANOLA_HUB_TOOLS.granola_get_note },
});

function createFetchArtifactTool(env: BaseEnv): AgentTool {
  const inner = artifactReadInner(env);
  return {
    kind: "full",
    definition: PRESENTATION_FETCH_ARTIFACT_DEFINITION,
    handler: async (call, signal) => {
      const args = coerceArgsObject(call.arguments);
      const artifactId = args.artifactId;
      if (typeof artifactId !== "string" || artifactId.trim().length === 0) {
        return { callId: call.id, content: { skipped: true } };
      }
      const result = await inner.run(
        { id: call.id, name: "artifact_read", arguments: { artifactId } },
        signal,
      );
      if (result.isError === true) {
        return {
          callId: call.id,
          content: { isError: true, error: toErrorMessage(result) },
        };
      }
      return { callId: call.id, content: result.content };
    },
  };
}

function createFetchNoteTool(env: BaseEnv): AgentTool {
  // `granolaGetNoteInner(env)` is constructed PER CALL, inside the handler —
  // not eagerly at factory-build time. `defineCredentialedToolPackage`'s
  // factory throws `ToolCredentialMissingError` the instant it is invoked
  // with no `granola` credential in env, and that throw must land inside
  // OUR catch (an unconfigured Granola tenant is exactly a case this
  // wrapper tolerates), not bubble up through `createFetchNoteTool` itself
  // — a throw there would fail this wrapper's OWN factory construction,
  // which the sidecar's `buildStepTools` treats as "package skipped for a
  // missing credential" and would make the `action` dispatch a hard
  // `StepToolCredentialMissingError` instead of a completed envelope.
  return {
    kind: "full",
    definition: PRESENTATION_FETCH_NOTE_DEFINITION,
    handler: async (call, signal) => {
      const args = coerceArgsObject(call.arguments);
      const noteId = args.noteId;
      if (typeof noteId !== "string" || noteId.trim().length === 0) {
        return { callId: call.id, content: { skipped: true } };
      }
      try {
        const inner = granolaGetNoteInner(env);
        const result = await inner.run(
          { id: call.id, name: "granola_get_note", arguments: { noteId } },
          signal,
        );
        if (result.isError === true) {
          return {
            callId: call.id,
            content: { isError: true, error: toErrorMessage(result) },
          };
        }
        return { callId: call.id, content: result.content };
      } catch (cause) {
        return {
          callId: call.id,
          content: {
            isError: true,
            error: cause instanceof Error ? cause.message : String(cause),
          },
        };
      }
    },
  };
}

export function createGammaPresentationCreatorFetchTools(
  env: BaseEnv,
): AgentTool[] {
  return [createFetchArtifactTool(env), createFetchNoteTool(env)];
}

/** Env keys these wrapper tools need injected — the same keys the wrapped
 * packages themselves declare (`HUB_RPC_ENV_KEY` for the hub-backed
 * artifact rail, the granola tool-credential key for the credentialed
 * rail). Re-exported so `interchange-tools.ts`'s `defineTool({ requires })`
 * stays a single source of truth with this file. */
export const FETCH_TOOLS_REQUIRES = [
  ...artifactReadInner.requires,
  ...granolaGetNoteInner.requires,
];
