import { type } from "arktype";
import type { AgentTool } from "@intx/agent";
import { createGranolaTools } from "@workbench/tools-granola";
import type {
  InboxSourceRegistryEntry,
  WorkspaceInboxSourceContext,
} from "../inbox-source-registry";
import {
  GranolaCallSchema,
  type GranolaCall,
  type GranolaCallPipeline,
} from "../granola-call-pipeline";

/**
 * The registry key for the Granola workspace poller. It doubles as the tenant
 * credential provider name the intake core resolves (`resolveTenantToolCredential`
 * is keyed on `entry.key`), so it MUST equal the Granola provider name
 * ("granola"). The owner-enablement gate keys on this same value
 * (`inbox-source:granola`), default OFF.
 */
export const GRANOLA_WORKSPACE_SOURCE_KEY = "granola";

// The Granola list/get tool responses, re-validated here at the tool boundary.
const NoteListResponse = type({
  notes: type({
    id: "string",
    "title?": "string | null",
    "created_at?": "string",
    "summary?": "string",
    "participants?": "string[]",
  }).array(),
});

const TranscriptItem = type({ "text?": "string" });
const FullNote = type({
  id: "string",
  "title?": "string | null",
  "created_at?": "string",
  "summary?": "string",
  "participants?": "string[]",
  "transcript?": TranscriptItem.array(),
});

type StringTool = Extract<AgentTool, { kind: "string" }>;

function findTool(tools: AgentTool[], name: string): StringTool {
  const tool = tools.find((t) => t.definition.name === name);
  if (!tool) throw new Error(`granola workspace source: missing tool ${name}`);
  if (tool.kind !== "string") {
    throw new Error(
      `granola workspace source: tool ${name} is not string-kind`,
    );
  }
  return tool;
}

async function callTool(
  tool: StringTool,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const result = await tool.handler(args, signal);
  return JSON.parse(result);
}

function transcriptText(
  transcript: { text?: string }[] | undefined,
): string | undefined {
  if (!transcript || transcript.length === 0) return undefined;
  const text = transcript
    .map((t) => t.text ?? "")
    .filter((t) => t !== "")
    .join("\n");
  return text === "" ? undefined : text;
}

function toGranolaCall(note: typeof FullNote.infer): GranolaCall {
  const call: GranolaCall = { id: note.id };
  if (note.title !== undefined) call.title = note.title;
  if (note.summary !== undefined) call.summary = note.summary;
  if (note.participants !== undefined) call.participants = note.participants;
  if (note.created_at !== undefined) call.createdAt = note.created_at;
  const text = transcriptText(note.transcript);
  if (text !== undefined) call.transcript = text;
  const parsed = GranolaCallSchema(call);
  if (parsed instanceof type.errors) {
    throw new Error(
      `granola workspace source: constructed call failed validation: ${parsed.summary}`,
    );
  }
  return parsed;
}

async function handleWorkspaceTick(
  ctx: WorkspaceInboxSourceContext,
  pipeline: GranolaCallPipeline,
): Promise<void> {
  const tools = createGranolaTools({
    apiKey: ctx.credential.apiKey,
    ...(ctx.credential.baseURL ? { baseUrl: ctx.credential.baseURL } : {}),
  });
  const listTool = findTool(tools, "granola_list_notes");
  const getTool = findTool(tools, "granola_get_note");

  // Bound the fetch by the later of the tick lookback and any host cursor.
  const since =
    ctx.lastPollAt && ctx.lastPollAt > ctx.cutoff ? ctx.lastPollAt : ctx.cutoff;
  const listRaw = await callTool(
    listTool,
    {
      limit: ctx.perSourceLimit,
      createdAfter: since.toISOString(),
    },
    ctx.signal,
  );
  const list = NoteListResponse(listRaw);
  if (list instanceof type.errors) {
    throw new Error(
      `granola workspace source: bad list response: ${list.summary}`,
    );
  }

  for (const summaryNote of list.notes) {
    if (ctx.signal.aborted) return;
    // Fetch the full note (transcript) before handing to the pipeline. The
    // pipeline is idempotent per call (an already-processed note short-circuits
    // on its persisted artifact), so re-listing the same note is cheap and safe.
    const fullRaw = await callTool(
      getTool,
      { noteId: summaryNote.id },
      ctx.signal,
    );
    const fullNote = FullNote(fullRaw);
    if (fullNote instanceof type.errors) {
      ctx.log.error("granola workspace source: bad note response; skipping", {
        noteId: summaryNote.id,
        error: new Error(fullNote.summary),
      });
      continue;
    }
    const call = toGranolaCall(fullNote);
    const result = await pipeline.processCall({
      tenantId: ctx.tenantId,
      note: call,
      signal: ctx.signal,
    });
    ctx.log.info("granola workspace source: processed {noteId} -> {status}", {
      noteId: call.id,
      status: result.status,
    });
  }
}

/**
 * The Granola workspace inbox source (CL-3578). Workspace-scoped: runs once per
 * tenant per intake tick, gated by the owner-level `inbox-source:granola`
 * enablement (default OFF) and a tenant-owned Granola credential. Lists notes
 * created since the tick cutoff, dedupes on the external note id (persistently
 * — the pipeline's per-call artifact IS the dedupe record, so it survives
 * restarts), and hands each genuinely-new call to the call pipeline.
 *
 * WEBHOOKS: Granola's public API (public-api.granola.ai/v1) exposes no
 * webhook/push subscription — notes are only retrievable by polling
 * `/notes`. This source therefore polls on the intake cadence; no webhook
 * infrastructure is built (or possible) today.
 */
export function createGranolaWorkspaceInboxSource(deps: {
  pipeline: GranolaCallPipeline;
}): InboxSourceRegistryEntry {
  return {
    key: GRANOLA_WORKSPACE_SOURCE_KEY,
    scope: "workspace",
    handle: async (ctx) => {
      if (ctx.scope !== "workspace") return;
      await handleWorkspaceTick(ctx, deps.pipeline);
    },
  };
}
