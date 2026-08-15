// The Routines page's one seam to `@corbits/routines`' HTTP routes (see
// packages/routines/src/routes.ts): fetch composition only. Wire schemas,
// path builders, and pure display helpers live in `@corbits/routines/client`
// — browser-safe and shared with any UI over this data, not tied to this
// app's fetch machinery (mirrors `insights-api.ts` / `@corbits/insights/client`
// and `agents-directory.ts` / `@corbits/agent-directory/client`).
// `@corbits/routines` itself is never imported directly — its public
// surface also exports Drizzle schema tables and a Postgres-backed store,
// none of which belong in a browser bundle. Definitions come from the
// platform's own `/api/tenants/:tenantId/workflows/definitions` listing
// (native to `@intx/hub-api`, not part of routines), the same catalog a
// routine's `definitionId` points into.
//
// The create-flow picker only surfaces automatable workflows (see
// `purpose-definitions.ts` + `@corbits/workflow-catalog`). Labels prefer
// the catalog display name over raw asset names.

import { type } from "arktype";
import type { ArkErrors } from "arktype";
import { useQuery } from "@tanstack/react-query";
import { workflowDisplayName } from "@corbits/workflow-catalog";
import type { APIQuery } from "@corbits/api-query";
import {
  ApiQueryError,
  UnauthenticatedError,
  toAPIQuery,
} from "@corbits/api-query";
import {
  Routine,
  RoutineDraft,
  RoutineRun,
  RoutinesResponse,
  RoutineRunsResponse,
  routineCreatedToast,
  routineDraftApprovePath,
  routineDraftDiscardPath,
  routineDraftsPath,
  routinePath,
  routineRunNowPath,
  routineRunStartedToast,
  routineRunsPath,
  routinesPath,
} from "@corbits/routines/client";
import type {
  CreateDraftInput,
  CreateRoutineInput,
  UpdateRoutineInput,
} from "@corbits/routines/client";
import { purposeDefinitions, withCatalogFields } from "./purpose-definitions";
import type { CatalogFields } from "./purpose-definitions";

export {
  DraftedStep,
  suggestRoutineNameFromPrompt,
  type CreateDraftInput,
  type CreateRoutineInput,
  type Routine,
  type RoutineDraft,
  type RoutineRun,
  type RoutineTriggerT as RoutineTrigger,
  type UpdateRoutineInput,
} from "@corbits/routines/client";

const WorkflowDefinitionRecord = type({
  id: "string",
  name: "string",
  status: "string",
  "description?": "string | null",
});
type WorkflowDefinitionRecord = typeof WorkflowDefinitionRecord.infer;

/** An automatable workflow definition, enriched with its catalog
 * demo-card fields (see `withCatalogFields`) — the shape the Routines
 * create picker renders a card from. */
export type WorkflowDefinitionSummary = WorkflowDefinitionRecord &
  CatalogFields;

const DefinitionsPage = type({
  data: WorkflowDefinitionRecord.array(),
  "nextCursor?": "string | null",
});

/** One page is enough for a seeded bench; walk cursors so a large catalog
 * never silently truncates automatable options. */
const PAGE_LIMIT = 100;

type Validator<T> = (data: unknown) => T | ArkErrors;

async function request<T>(
  path: string,
  schema: Validator<T>,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
  } catch (cause) {
    throw new ApiQueryError(
      cause instanceof Error ? cause.message : String(cause),
      undefined,
      path,
    );
  }
  if (response.status === 401) {
    throw new ApiQueryError("Not signed in.", 401, path);
  }
  if (!response.ok) {
    // Envelope-first: the hub's own `error.message` is already plain,
    // human copy — kept verbatim. Only the fallback (no envelope message)
    // is synthesized here, and it never repeats the request path.
    const detail = await response
      .json()
      .then(
        (body: { error?: { message?: string } }) => body.error?.message ?? "",
      )
      .catch(() => "");
    throw new ApiQueryError(
      detail === "" ? `The server answered ${response.status}.` : detail,
      response.status,
      path,
    );
  }
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = schema(body);
  if (parsed instanceof type.errors) {
    throw new ApiQueryError(
      `Unexpected response shape: ${parsed.summary}`,
      undefined,
      path,
    );
  }
  return parsed;
}

export function listRoutines(tenantId: string): Promise<readonly Routine[]> {
  return request(routinesPath(tenantId), RoutinesResponse).then(
    (page) => page.items,
  );
}

export function getRoutine(tenantId: string, id: string): Promise<Routine> {
  return request(routinePath(tenantId, id), Routine);
}

export function createRoutine(
  tenantId: string,
  input: CreateRoutineInput,
): Promise<Routine> {
  return request(routinesPath(tenantId), Routine, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateRoutine(
  tenantId: string,
  id: string,
  patch: UpdateRoutineInput,
): Promise<Routine> {
  return request(routinePath(tenantId, id), Routine, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteRoutine(tenantId: string, id: string): Promise<void> {
  return request(routinePath(tenantId, id), type("unknown"), {
    method: "DELETE",
  }).then(() => undefined);
}

export function runRoutineNow(
  tenantId: string,
  id: string,
): Promise<{ runId: string }> {
  return request(routineRunNowPath(tenantId, id), type({ runId: "string" }), {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function listRoutineRuns(
  tenantId: string,
  id: string,
): Promise<readonly RoutineRun[]> {
  return request(routineRunsPath(tenantId, id), RoutineRunsResponse).then(
    (page) => page.items,
  );
}

export function createRoutineDraft(
  tenantId: string,
  input: CreateDraftInput,
): Promise<RoutineDraft> {
  return request(routineDraftsPath(tenantId), RoutineDraft, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function listRoutineDrafts(
  tenantId: string,
): Promise<readonly RoutineDraft[]> {
  return request(
    routineDraftsPath(tenantId),
    type({ items: RoutineDraft.array() }),
  ).then((page) => page.items);
}

export function approveRoutineDraft(
  tenantId: string,
  id: string,
  definitionId?: string,
): Promise<{ draft: RoutineDraft; routine: Routine }> {
  return request(
    routineDraftApprovePath(tenantId, id),
    type({ draft: RoutineDraft, routine: Routine }),
    {
      method: "POST",
      body: JSON.stringify(definitionId !== undefined ? { definitionId } : {}),
    },
  );
}

export function discardRoutineDraft(
  tenantId: string,
  id: string,
): Promise<RoutineDraft> {
  return request(routineDraftDiscardPath(tenantId, id), RoutineDraft, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

/**
 * All automatable workflow definitions for the Routines create picker.
 * Walks pagination, filters via the catalog allowlist, and attaches a
 * friendly label for Menu items (never a raw id).
 */
export async function listWorkflowDefinitions(
  tenantId: string,
): Promise<readonly WorkflowDefinitionSummary[]> {
  const collected: WorkflowDefinitionRecord[] = [];
  let cursor: string | null = null;
  for (;;) {
    const query = new URLSearchParams({ limit: String(PAGE_LIMIT) });
    if (cursor !== null) query.set("cursor", cursor);
    const page = await request(
      `/api/tenants/${tenantId}/workflows/definitions?${query}`,
      DefinitionsPage,
    );
    collected.push(...page.data);
    if (page.nextCursor === undefined || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return withCatalogFields(purposeDefinitions(collected)).map((definition) => ({
    ...definition,
    name: workflowDisplayName(definition.name, definition.description),
  }));
}

/**
 * Tenant-scoped query via TanStack Query. Keys must be stable arrays that
 * already include the tenant id under the `["tenant", tenantId, ...]`
 * convention so a bench switch can `removeQueries` the whole prefix.
 * When `enabled` is false the previous result is not kept on screen — TQ
 * drops the active fetch and the adapter reports loading until re-enabled.
 */
export function useTenantQuery<T>(
  key: readonly unknown[],
  enabled: boolean,
  fetcher: () => Promise<T>,
): APIQuery<T> {
  const result = useQuery({
    queryKey: key,
    enabled,
    queryFn: async () => {
      try {
        return await fetcher();
      } catch (cause) {
        if (cause instanceof ApiQueryError && cause.status === 401) {
          throw new UnauthenticatedError();
        }
        throw cause;
      }
    },
  });
  return toAPIQuery(result);
}

export { routineCreatedToast, routineRunStartedToast };
