// The `granola_list_recent_notes` tool bundle: an agent-facing wrapper
// around `./client.ts` that never throws. A missing credential or a
// failed call both come back as a completed `ToolResult` with
// `isError: true` — the calling agent's job (e.g. the morning-brief
// workflow) is to read that as "Granola is not available right now"
// and say so honestly, never to have the run itself fail because one
// source is unreachable.
import { defineTool } from "@intx/agent";
import type { BaseEnv } from "@intx/agent";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

import { listRecentGranolaNotes } from "./client";

export const GRANOLA_LIST_RECENT_NOTES_TOOL = "granola_list_recent_notes";

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

/**
 * The `@corbits/granola-tools` bundle factory: one tool, one env key.
 * Pin this package's `granola` bundle on any agent that needs recent
 * Granola call notes.
 */
export const granolaTools = defineTool<GranolaEnv>({
  id: "@corbits/granola-tools/granola",
  requires: ["granolaApiKey"],
  definitions: [{ name: GRANOLA_LIST_RECENT_NOTES_TOOL }],
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
    ],
    run: (call, _signal) => runGranolaListRecentNotes(env, call),
  }),
});
