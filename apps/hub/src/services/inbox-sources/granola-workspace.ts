import { type } from "arktype";
import type { AgentTool } from "@intx/agent";
import { createGranolaTools } from "@workbench/tools-granola";
import type {
  InboxSourceRegistryEntry,
  InboxSourceTickResult,
  WorkspaceInboxSourceContext,
} from "../inbox-source-registry";
import type { GranolaCallJobQueue } from "../granola-call-job-queue";

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
  // Pagination signals from @workbench/tools-granola's `granola_list_notes`
  // (see packages/tools-granola/src/index.ts `GranolaListResponse`): `hasMore`
  // is authoritative over the length-vs-limit heuristic below for deciding
  // whether the page may have truncated the window, and `cursor` (when
  // present) lets this source page forward within a single tick instead of
  // waiting a full tick per page.
  "hasMore?": "boolean",
  "cursor?": "string",
});

/** Bounds how many list pages this source will walk in a single tick before
 * falling back to the max-created-at cursor rule for the remainder — keeps a
 * single tick from running unbounded against a very large backlog. */
const MAX_PAGES_PER_TICK = 4;

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

/** The newest `created_at` among `notes`, or `undefined` when none carry one
 * — the forward-progress marker for a full/truncated page. */
function maxCreatedAt(
  notes: readonly { created_at?: string }[],
): Date | undefined {
  let max: Date | undefined;
  for (const note of notes) {
    if (note.created_at === undefined) continue;
    const parsed = new Date(note.created_at);
    if (Number.isNaN(parsed.getTime())) continue;
    if (max === undefined || parsed > max) max = parsed;
  }
  return max;
}

async function handleWorkspaceTick(
  ctx: WorkspaceInboxSourceContext,
  queue: GranolaCallJobQueue,
): Promise<InboxSourceTickResult | undefined> {
  const tools = createGranolaTools({
    apiKey: ctx.credential.apiKey,
    ...(ctx.credential.baseURL ? { baseUrl: ctx.credential.baseURL } : {}),
  });
  const listTool = findTool(tools, "granola_list_notes");

  // Bound the fetch by the later of the tick lookback and any host cursor.
  const since =
    ctx.lastPollAt && ctx.lastPollAt > ctx.cutoff ? ctx.lastPollAt : ctx.cutoff;

  const processedNotes: { created_at?: string }[] = [];
  let mayBeTruncated = false;
  let cursor: string | undefined;

  // Walk list pages within this tick (bounded by MAX_PAGES_PER_TICK) using the
  // list API's own `cursor` when it offers one — this drains a backlog within
  // a single tick rather than one page per tick. `createdAfter` stays pinned
  // to `since` throughout; the cursor param, not the timestamp, advances the
  // window page to page.
  for (let page = 0; page < MAX_PAGES_PER_TICK; page++) {
    const listRaw = await callTool(
      listTool,
      {
        limit: ctx.perSourceLimit,
        createdAfter: since.toISOString(),
        ...(cursor !== undefined ? { cursor } : {}),
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
      // Enqueue only — no transcript fetch, no LLM turn on the tick. The
      // job-queue's (tenant, note) unique constraint is the enqueue-dedupe
      // backstop; the job runner (off-tick) does the transcript fetch +
      // reasoning turn + artifact persistence (CL-3627).
      await queue.enqueue(ctx.tenantId, summaryNote.id);
      ctx.log.info("granola workspace source: enqueued {noteId}", {
        noteId: summaryNote.id,
      });
      processedNotes.push(summaryNote);
    }

    // A full, limit-capped page may hide notes still unseen behind the page
    // boundary. Prefer the list response's own `hasMore` signal when present;
    // otherwise fall back to the length-vs-limit heuristic.
    const pageMayBeTruncated =
      list.hasMore ?? list.notes.length >= ctx.perSourceLimit;
    if (!pageMayBeTruncated) {
      mayBeTruncated = false;
      break;
    }
    mayBeTruncated = true;
    if (list.cursor === undefined) break; // no page token to keep walking
    cursor = list.cursor;
  }

  if (mayBeTruncated) {
    // Advance to the newest PROCESSED note's created_at (CL-3577 review fix)
    // instead of pinning at `since` — guarantees forward progress through a
    // sustained backlog (>= perSourceLimit new notes every tick) rather than
    // re-issuing the identical query forever. Absent any created_at, fall
    // back to the unchanged floor and rely on the job queue's per-note
    // dedupe to absorb the re-fetched overlap.
    return { nextCursor: maxCreatedAt(processedNotes) ?? since };
  }
  return undefined;
}

/**
 * The Granola workspace inbox source (CL-3578, off-tick pipeline CL-3627).
 * Workspace-scoped: runs once per tenant per intake tick, gated by the
 * owner-level `inbox-source:granola` enablement (default OFF) and a
 * tenant-owned Granola credential. Lists notes created since the tick cutoff
 * and enqueues each genuinely-new call onto the job queue — no transcript
 * fetch, no LLM turn on the tick. A separate off-tick runner
 * (`granola-call-job-runner.ts`) drains the queue and hands each call to the
 * call pipeline.
 *
 * WEBHOOKS: Granola's public API (public-api.granola.ai/v1) exposes no
 * webhook/push subscription — notes are only retrievable by polling
 * `/notes`. This source therefore polls on the intake cadence; no webhook
 * infrastructure is built (or possible) today.
 */
export function createGranolaWorkspaceInboxSource(deps: {
  queue: GranolaCallJobQueue;
}): InboxSourceRegistryEntry {
  return {
    key: GRANOLA_WORKSPACE_SOURCE_KEY,
    scope: "workspace",
    handle: async (ctx) => {
      if (ctx.scope !== "workspace") return;
      return handleWorkspaceTick(ctx, deps.queue);
    },
  };
}
