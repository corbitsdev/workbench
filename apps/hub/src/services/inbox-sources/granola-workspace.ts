import { type } from "arktype";
import type { AgentTool } from "@intx/agent";
import { createGranolaTools } from "@workbench/tools-granola";
import type {
  InboxSourceRegistryEntry,
  InboxSourceTickResult,
  WorkspaceInboxSourceContext,
} from "../inbox-source-registry";
import { granolaCallArtifactsProcessed } from "../granola-call-artifacts";
import type { StartRunInput, StartRunResult } from "../workflow-run-starter";
import type { HubDb } from "../../db";
import { getConfig } from "../../config";

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

function rootTenantDomainBestEffort(): string {
  try {
    return getConfig().rootTenant.domain ?? "";
  } catch {
    // Unit tests may not boot full hub config; classify still runs with empty domain.
    return "";
  }
}

/**
 * Start (or skip) processing for one listed note. Checks the artifact table
 * for the note's three sourceRefs before starting a run (CL-4213) — a call
 * already fully processed is never re-run, and the check is a cost
 * optimization only: `write_artifact`'s sourceRef dedupe plus the
 * `artifact_tenant_source_ref_uniq` partial unique index make a race here
 * (two ticks both missing the check) harmless, not just unlikely.
 */
async function processListedNote(
  ctx: WorkspaceInboxSourceContext,
  deps: {
    db: HubDb;
    startRun: (args: StartRunInput) => Promise<StartRunResult>;
  },
  noteId: string,
): Promise<void> {
  const alreadyProcessed = await granolaCallArtifactsProcessed(
    deps.db,
    ctx.tenantId,
    noteId,
  );
  if (alreadyProcessed) {
    ctx.log.info(
      "granola workspace source: skipping already-processed {noteId}",
      { noteId },
    );
    return;
  }

  const domain = rootTenantDomainBestEffort();
  const result = await deps.startRun({
    kind: "granola-call",
    tenantId: ctx.tenantId,
    input: domain.length > 0 ? { noteId, tenantDomain: domain } : { noteId },
    source: "scheduler",
  });
  if (!result.ok) {
    ctx.log.warn("granola workspace source: start run failed {noteId}", {
      noteId,
      reason: result.reason,
      message: result.message,
    });
    return;
  }
  ctx.log.info("granola workspace source: started run {noteId} run={runId}", {
    noteId,
    runId: result.runId,
  });
}

async function handleWorkspaceTick(
  ctx: WorkspaceInboxSourceContext,
  deps: {
    db: HubDb;
    startRun: (args: StartRunInput) => Promise<StartRunResult>;
  },
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
      // Skip-if-processed check + direct run start (CL-4213) — no queue, no
      // lease, no claim protocol. The artifact sourceRef dedupe (skip check +
      // unique-index backstop) is the only idempotency mechanism needed.
      await processListedNote(ctx, deps, summaryNote.id);
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
    // back to the unchanged floor; the per-note artifact-existence check
    // above absorbs the re-fetched overlap.
    return { nextCursor: maxCreatedAt(processedNotes) ?? since };
  }
  return undefined;
}

/**
 * The Granola workspace inbox source (CL-3578, direct-start pipeline
 * CL-4213). Workspace-scoped: runs once per tenant per intake tick, gated by
 * the owner-level `inbox-source:granola` enablement (default OFF) and a
 * tenant-owned Granola credential. Lists notes created since the tick cutoff
 * and, for each note whose three typed artifacts don't already exist, starts
 * a `granola-call` workflow run directly via the run-start seam — no
 * transcript fetch, no LLM turn on the tick itself; the deployed workflow
 * does that work off-tick once started.
 *
 * There is no queue between "listed" and "started": each note either already
 * has all three artifacts (skip) or is started immediately. Idempotency is
 * carried entirely by artifact `sourceRef` (see granola-call-artifacts.ts) —
 * the database unique index is the correctness backstop, this check is only
 * the cost optimization that avoids re-paying for an LLM turn.
 *
 * WEBHOOKS: Granola's public API (public-api.granola.ai/v1) exposes no
 * webhook/push subscription — notes are only retrievable by polling
 * `/notes`. This source therefore polls on the intake cadence; no webhook
 * infrastructure is built (or possible) today.
 */
export function createGranolaWorkspaceInboxSource(deps: {
  db: HubDb;
  startRun: (args: StartRunInput) => Promise<StartRunResult>;
}): InboxSourceRegistryEntry {
  return {
    key: GRANOLA_WORKSPACE_SOURCE_KEY,
    scope: "workspace",
    handle: async (ctx) => {
      if (ctx.scope !== "workspace") return;
      return handleWorkspaceTick(ctx, deps);
    },
  };
}
