// The `granola_list_recent_notes` tool bundle: an agent-facing wrapper
// around `./client.ts` that never throws. A missing credential or a
// failed call both come back as a completed `ToolResult` with
// `isError: true` — the calling agent's job (e.g. the morning-brief
// workflow) is to read that as "Granola is not available right now"
// and say so honestly, never to have the run itself fail because one
// source is unreachable.
//
// CL-6028: this package declares its "granola" credential handle in
// `package.json` (`interchange.credentials`) and a consuming workflow
// definition binds it via `credentialBindings`, so `buildCredentialDelivery`
// (`vendor/intx/db/src/credential-resolution.ts`) resolves a tenant-owned
// credential for the handle at launch — proven directly in
// `test/credential-delivery.drizzle.test.ts`. This module still reads
// `granolaApiKey` off a plain env field rather than the harness's
// credentials capability (`vendor/intx/harness/src/credential-capability.ts`)
// because that capability is never wired into a running tool's env in this
// codebase: `BaseEnv` (`vendor/intx/agent/src/env.ts`) carries no
// `credentials` field, `createCredentialCapability` has zero callers anywhere
// under `vendor/intx`, and the one place a `CredentialWiring` reaches a step
// invoker (`ChildStepInvoker`'s 6th parameter, `vendor/intx/workflow-host/src/
// child/run-child.ts:287-293`) is a parameter the production sidecar binding
// (`apps/sidecar/src/workflow-substrate-factory/index.ts`'s `invokeStep`,
// typed with only 5 params) never accepts, so it is dropped before reaching
// `createWorkflowStepInvoker`/`attachStepTools`
// (`apps/sidecar/src/step-agent-tools.ts`) — neither of which mentions
// "credential" at all. Until that seam is built, `granolaApiKey` stays the
// honest surface: nothing populates it today, so this tool correctly reports
// "not connected" rather than silently never receiving a bound credential.
import { defineTool } from "@intx/agent";
import type { BaseEnv } from "@intx/agent";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

import { getGranolaNote, listRecentGranolaNotes } from "./client";

export const GRANOLA_LIST_RECENT_NOTES_TOOL = "granola_list_recent_notes";
export const GRANOLA_GET_NOTE_TOOL = "granola_get_note";

/** Env this bundle needs beyond `BaseEnv`: the caller's Granola credential. */
export interface GranolaEnv extends BaseEnv {
  /** Absent or empty means "not connected" — never a thrown error. */
  readonly granolaApiKey?: string;
}

function notConnectedResult(callId: string): ToolResult {
  return {
    callId,
    content: "Granola is not connected for this user.",
    isError: true,
  };
}

async function runGranolaListRecentNotes(
  env: GranolaEnv,
  call: ToolCall,
): Promise<ToolResult> {
  if (env.granolaApiKey === undefined || env.granolaApiKey === "") {
    return notConnectedResult(call.id);
  }
  const since = call.arguments["since"];
  try {
    const notes = await listRecentGranolaNotes(
      { apiKey: env.granolaApiKey },
      typeof since === "string" ? { since } : {},
    );
    return { callId: call.id, content: JSON.stringify({ notes }) };
  } catch (err) {
    return {
      callId: call.id,
      content: err instanceof Error ? err.message : String(err),
      isError: true,
    };
  }
}

async function runGranolaGetNote(
  env: GranolaEnv,
  call: ToolCall,
): Promise<ToolResult> {
  if (env.granolaApiKey === undefined || env.granolaApiKey === "") {
    return notConnectedResult(call.id);
  }
  const noteId = call.arguments["noteId"];
  if (typeof noteId !== "string" || noteId === "") {
    return {
      callId: call.id,
      content: `${GRANOLA_GET_NOTE_TOOL} requires a non-empty noteId argument`,
      isError: true,
    };
  }
  try {
    const note = await getGranolaNote(
      { apiKey: env.granolaApiKey },
      { noteId },
    );
    return { callId: call.id, content: JSON.stringify({ note }) };
  } catch (err) {
    return {
      callId: call.id,
      content: err instanceof Error ? err.message : String(err),
      isError: true,
    };
  }
}

/**
 * The `@corbits/granola-tools` bundle factory: two tools sharing one
 * env key (`granolaApiKey`). Pin this package's `granola` bundle on
 * any agent that needs a user's recent Granola call notes, or the full
 * transcript of one note by id.
 */
export const granolaTools = defineTool<GranolaEnv>({
  id: "@corbits/granola-tools/granola",
  requires: ["granolaApiKey"],
  definitions: [
    { name: GRANOLA_LIST_RECENT_NOTES_TOOL },
    { name: GRANOLA_GET_NOTE_TOOL },
  ],
  factory: (env) => ({
    definitions: [
      {
        name: GRANOLA_LIST_RECENT_NOTES_TOOL,
        description:
          "Lists the caller's recent Granola call notes (title, summary, " +
          "created-at), newest first. Returns an error result naming " +
          '"not connected" when no Granola credential is configured — ' +
          "never fabricate notes when this happens.",
        inputSchema: {
          type: "object",
          properties: {
            since: {
              type: "string",
              description:
                "ISO 8601 timestamp; only notes created after this are returned",
            },
          },
        },
      },
      {
        name: GRANOLA_GET_NOTE_TOOL,
        description:
          "Fetches one Granola call note by id, including its transcript. " +
          'Returns an error result naming "not connected" when no Granola ' +
          "credential is configured — never fabricate a transcript when " +
          "this happens.",
        inputSchema: {
          type: "object",
          properties: {
            noteId: {
              type: "string",
              description: "The Granola note id to fetch.",
            },
          },
          required: ["noteId"],
        },
      },
    ],
    run: (call, _signal) => {
      switch (call.name) {
        case GRANOLA_GET_NOTE_TOOL:
          return runGranolaGetNote(env, call);
        default:
          return runGranolaListRecentNotes(env, call);
      }
    },
  }),
});
