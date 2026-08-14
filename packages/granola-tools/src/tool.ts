// The `granola_list_recent_notes` tool bundle: an agent-facing wrapper
// around `./client.ts` that never throws. A missing credential or a
// failed call both come back as a completed `ToolResult` with
// `isError: true` — the calling agent's job (e.g. the morning-brief
// workflow) is to read that as "Granola is not available right now"
// and say so honestly, never to have the run itself fail because one
// source is unreachable.
//
// CL-6028 declared this package's "granola" credential handle in
// `package.json` (`interchange.credentials`); CL-6032 wires the runtime
// half. `env.credentials` is the harness's consumer-gated capability
// (`vendor/intx/harness/src/credential-capability.ts`,
// `createCredentialCapability`): the sidecar's step-invoker binding
// (`apps/sidecar/src/step-agent-tools.ts`) shapes one scoped to this
// package's consumer identity from the step's `CredentialWiring`
// (`ChildStepInvoker`'s 6th parameter, threaded through
// `apps/sidecar/src/workflow-substrate-factory/index.ts`'s `invokeStep`)
// and hands it to this bundle's factory. `credentials.resolve("granola")`
// throws when the handle has no bound credential (a workflow that never
// declared `credentialBindings` for this package) or the run's grants
// don't authorize this consumer to use it; both, like a network failure,
// degrade to the same honest "not connected" `ToolResult` rather than
// throwing out of the tool.
import { defineTool } from "@intx/agent";
import type { BaseEnv } from "@intx/agent";
import type { CredentialCapability } from "@intx/types";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

import { getGranolaNote, listRecentGranolaNotes } from "./client";

export const GRANOLA_LIST_RECENT_NOTES_TOOL = "granola_list_recent_notes";
export const GRANOLA_GET_NOTE_TOOL = "granola_get_note";

/** The handle this package declares in `interchange.credentials`. */
const GRANOLA_CREDENTIAL_HANDLE = "granola";

/** Env this bundle needs beyond `BaseEnv`: the mediated-credential capability. */
export interface GranolaEnv extends BaseEnv {
  readonly credentials?: CredentialCapability;
}

function notConnectedResult(callId: string): ToolResult {
  return {
    callId,
    content: "Granola is not connected for this user.",
    isError: true,
  };
}

/**
 * Resolve this bundle's mediated Granola credential, or `null` when it
 * is not connected -- an absent `env.credentials`, an unbound handle, or
 * a denied grant all collapse to the same "not connected" signal, never
 * a thrown error out of the tool.
 */
async function resolveGranolaCredential(
  env: GranolaEnv,
): Promise<{ fetchImpl: typeof fetch } | null> {
  if (env.credentials === undefined) return null;
  try {
    const mediated = await env.credentials.resolve(GRANOLA_CREDENTIAL_HANDLE);
    return { fetchImpl: mediated.fetch as unknown as typeof fetch };
  } catch {
    return null;
  }
}

async function runGranolaListRecentNotes(
  env: GranolaEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const credential = await resolveGranolaCredential(env);
  if (credential === null) {
    return notConnectedResult(call.id);
  }
  const since = call.arguments["since"];
  try {
    const notes = await listRecentGranolaNotes(
      { fetchImpl: credential.fetchImpl },
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
  const credential = await resolveGranolaCredential(env);
  if (credential === null) {
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
      { fetchImpl: credential.fetchImpl },
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
 * mediated credential. Pin this package's `granola` bundle on any agent
 * that needs a user's recent Granola call notes, or the full transcript
 * of one note by id.
 */
export const granolaTools = defineTool<GranolaEnv>({
  id: "@corbits/granola-tools/granola",
  requires: ["credentials"],
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
