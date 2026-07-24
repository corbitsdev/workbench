import { and, eq } from "drizzle-orm";
import { getLogger } from "@intx/log";
import { getAncestorChain } from "@intx/db";
import { GRANOLA_SPAWN_CALL_RUNS_DEFINITION } from "@workbench/tools-granola";
import {
  WORKFLOW_CATALOG_ACTIVE_STATUS,
  artifact,
  workflowRun,
} from "../db/schema";
import type { HubDb } from "../db";
import type { ContextToolEntry } from "../lib/tool-registry";
import {
  resolveDeployment,
  startWorkflowRun,
} from "../workflow-executor/run-exec";

const log = getLogger(["tools", "granola-spawn-runs"]);

/** The child workflow one run is started per unprocessed note. */
const CHILD_KIND = "process-granola-call";
/** Must match the child's persist step's sourceRefPrefix — the presence of a
 * final call-notes artifact is what marks a note as already processed. */
const PROCESSED_SOURCE_REF_PREFIX = "granola-call-note";

const DEFAULT_MAX_CALLS = 10;
const MAX_CALLS_CEILING = 25;

// Routine intake delivers maxCalls as text; a manual/JSON start can deliver
// a number. Both are legitimate; anything else non-empty fails loudly.
function parseMaxCalls(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_MAX_CALLS;
  }
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value.trim(), 10)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(
      `granola_spawn_call_runs: maxCalls must be a positive number, got ${JSON.stringify(value)}`,
    );
  }
  return Math.min(Math.floor(parsed), MAX_CALLS_CEILING);
}

function parseNoteIds(content: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (cause) {
    throw new Error(
      `granola_spawn_call_runs: content is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const notes = Array.isArray(parsed)
    ? parsed
    : parsed !== null &&
        typeof parsed === "object" &&
        Array.isArray((parsed as Record<string, unknown>).notes)
      ? ((parsed as Record<string, unknown>).notes as unknown[])
      : undefined;
  if (notes === undefined) {
    throw new Error(
      "granola_spawn_call_runs: content must be a notes array or { notes: [...] }",
    );
  }
  const ids: string[] = [];
  for (const note of notes) {
    if (note !== null && typeof note === "object") {
      const id = (note as Record<string, unknown>).id;
      if (typeof id === "string" && id.trim() !== "") {
        ids.push(id.trim());
      }
    }
  }
  return ids;
}

export const GRANOLA_SPAWN_HUB_TOOLS: Record<string, ContextToolEntry> = {
  granola_spawn_call_runs: {
    sideEffect: "write",
    definition: GRANOLA_SPAWN_CALL_RUNS_DEFINITION,
    createTools: (context) => [
      {
        kind: "string",
        definition: GRANOLA_SPAWN_CALL_RUNS_DEFINITION,
        handler: async (args) => {
          const content = args.content;
          if (typeof content !== "string" || content.trim() === "") {
            throw new Error(
              "granola_spawn_call_runs: content is required (the granola_list_notes JSON)",
            );
          }
          const maxCalls = parseMaxCalls(args.maxCalls);
          const {
            sessionService,
            cryptoProvider,
            deploymentDomain,
            provisionRunDeployment,
            resolveUserIdentity,
          } = context;
          if (
            !sessionService ||
            !cryptoProvider ||
            deploymentDomain === undefined ||
            !provisionRunDeployment ||
            !resolveUserIdentity
          ) {
            throw new Error(
              "granola_spawn_call_runs: hub workflow services missing from tool context",
            );
          }

          const chain = await getAncestorChain(context.db, context.tenantId);
          if (!(await resolveDeployment(context.db, chain, CHILD_KIND))) {
            throw new Error(
              `granola_spawn_call_runs: no published workflow of kind "${CHILD_KIND}" in this workbench's tenant chain`,
            );
          }

          const noteIds = parseNoteIds(content).slice(0, maxCalls);

          const spawned: { noteId: string; runId: string }[] = [];
          const skipped: string[] = [];
          const failed: { noteId: string; error: string; notFound: boolean }[] =
            [];
          // Serial on purpose: N is small (<= 25) and each start's heavy
          // provisioning runs in its own background task — this loop only
          // creates run rows and fires the starts.
          for (const noteId of noteIds) {
            const processed = await context.db.query.artifact.findFirst({
              where: and(
                eq(artifact.tenantId, context.tenantId),
                eq(
                  artifact.sourceRef,
                  `${PROCESSED_SOURCE_REF_PREFIX}-${noteId}`,
                ),
              ),
              columns: { id: true },
            });
            if (processed !== undefined) {
              skipped.push(noteId);
              continue;
            }
            try {
              const result = await startWorkflowRun(
                {
                  db: context.db,
                  sessionService,
                  cryptoProvider,
                  deploymentDomain,
                  provisionRunDeployment,
                  resolveUserIdentity,
                },
                {
                  kind: CHILD_KIND,
                  chain,
                  principalId: context.principalId,
                  input: { noteId },
                  originConversationId: null,
                },
              );
              if (!result.ok) {
                failed.push({
                  noteId,
                  error: result.error,
                  notFound: result.status === 404,
                });
                continue;
              }
              // Deliberately NOT awaiting result.backgroundTask: per-run
              // provisioning continues in the background so N spawns do not
              // serialize N provisions inside one parent step.
              spawned.push({ noteId, runId: result.state.runId });
            } catch (cause) {
              failed.push({
                noteId,
                error: cause instanceof Error ? cause.message : String(cause),
                notFound: false,
              });
            }
          }

          // Belt and braces: the up-front publish check should already have
          // caught an unpublished child kind, but if every spawn in the batch
          // still failed not_found (e.g. a race with un-publish mid-loop),
          // fail the step loudly rather than report a quietly-empty success.
          if (
            spawned.length === 0 &&
            failed.length > 0 &&
            failed.every((entry) => entry.notFound)
          ) {
            throw new Error(
              `granola_spawn_call_runs: every spawn failed — no published workflow of kind "${CHILD_KIND}" in this workbench's tenant chain`,
            );
          }

          if (failed.length > 0) {
            log.error("granola_spawn_call_runs: some spawns failed", {
              tenantId: context.tenantId,
              failed,
            });
          }
          return JSON.stringify({
            spawned,
            skippedAlreadyProcessed: skipped.length,
            failed: failed.map(({ noteId, error }) => ({ noteId, error })),
            considered: noteIds.length,
          });
        },
      },
    ],
  },
};
