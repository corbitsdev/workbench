// The Routines page's one seam to `@corbits/routines`' HTTP routes (see
// packages/routines/src/routes.ts), mirroring `@corbits/chat-ui`'s
// `api.ts`: tenant-scoped request functions, each response validated at
// the boundary with an arktype schema owned here rather than importing
// `@corbits/routines` itself — that package's public surface also
// exports Drizzle schema tables and a Postgres-backed store, none of
// which belong in a browser bundle. Definitions come from the platform's
// own `/api/tenants/:tenantId/workflows/definitions` listing (native to
// `@intx/hub-api`, not part of routines), the same catalog a routine's
// `definitionId` points into.
//
// The create-flow picker only surfaces automatable workflows (see
// `purpose-definitions.ts` + `@corbits/workflow-catalog`). Labels prefer
// the catalog display name over raw asset names.

import { type } from "arktype";
import type { ArkErrors } from "arktype";
import { useQuery } from "@tanstack/react-query";
import { workflowDisplayName } from "@corbits/workflow-catalog";
import type { APIQuery } from "./api";
import { toAPIQuery } from "./api";
import { UnauthenticatedError } from "./query-client";
import { purposeDefinitions } from "./purpose-definitions";

export const RoutineTrigger = type({
  kind: "'interval'",
  unit: "'minutes' | 'hours'",
  every: "number.integer > 0",
})
  .or({
    kind: "'daily'",
    hour: "0 <= number.integer <= 23",
    minute: "0 <= number.integer <= 59",
    "timezone?": "string",
  })
  .or({
    kind: "'weekly'",
    dayOfWeek: "0 <= number.integer <= 6",
    hour: "0 <= number.integer <= 23",
    minute: "0 <= number.integer <= 59",
    "timezone?": "string",
  })
  .or({ kind: "'cron'", expression: "string", "timezone?": "string" })
  .or({ kind: "'webhook'", webhookTriggerId: "string" })
  .or("null");
export type RoutineTrigger = typeof RoutineTrigger.infer;

const Routine = type({
  id: "string",
  name: "string",
  definitionId: "string",
  trigger: RoutineTrigger,
  scope: "'personal' | 'bench'",
  input: "Record<string, unknown>",
  enabled: "boolean",
  deliveryChannelId: "string | null",
  createdAt: "string",
  updatedAt: "string",
});
export type Routine = typeof Routine.infer;

const RoutinesResponse = type({ items: Routine.array() });

const RoutineRun = type({
  runId: "string",
  triggeredBy: "string",
  createdAt: "string",
  "run?": "Record<string, unknown>",
});
export type RoutineRun = typeof RoutineRun.infer;

const RoutineRunsResponse = type({ items: RoutineRun.array() });

export const WorkflowDefinitionSummary = type({
  id: "string",
  name: "string",
  status: "string",
  "description?": "string | null",
});
export type WorkflowDefinitionSummary = typeof WorkflowDefinitionSummary.infer;

const DefinitionsPage = type({
  data: WorkflowDefinitionSummary.array(),
  "nextCursor?": "string | null",
});

/** One page is enough for a seeded bench; walk cursors so a large catalog
 * never silently truncates automatable options. */
const PAGE_LIMIT = 100;

export type CreateRoutineInput = {
  readonly name: string;
  readonly definitionId: string;
  readonly trigger: RoutineTrigger;
  readonly scope: "personal" | "bench";
  readonly deliveryChannelId: string;
  readonly input?: Record<string, unknown>;
  readonly runOnceNow?: boolean;
};

export type UpdateRoutineInput = {
  readonly name?: string;
  readonly trigger?: RoutineTrigger;
  readonly enabled?: boolean;
  readonly input?: Record<string, unknown>;
  readonly deliveryChannelId?: string;
};

export const DraftedStep = type({
  title: "string",
  "detail?": "string",
});
export type DraftedStep = typeof DraftedStep.infer;

export const RoutineDraft = type({
  id: "string",
  prompt: "string",
  status: "'draft' | 'reviewed' | 'approved' | 'discarded'",
  proposedSteps: DraftedStep.array(),
  proposedTrigger: RoutineTrigger,
  proposedName: "string | null",
  definitionId: "string | null",
  deliveryChannelId: "string",
  scope: "'personal' | 'bench'",
  autonomy: "Record<string, unknown> | null",
  approvedRoutineId: "string | null",
  createdAt: "string",
  updatedAt: "string",
});
export type RoutineDraft = typeof RoutineDraft.infer;

export type CreateDraftInput = {
  readonly prompt: string;
  readonly deliveryChannelId: string;
  readonly scope: "personal" | "bench";
};

export class RoutinesApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

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
    throw new RoutinesApiError(
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (response.status === 401) {
    throw new RoutinesApiError(`Not signed in for ${path}.`, 401);
  }
  if (!response.ok) {
    const detail = await response
      .json()
      .then(
        (body: { error?: { message?: string } }) => body.error?.message ?? "",
      )
      .catch(() => "");
    throw new RoutinesApiError(
      `The hub answered ${response.status} for ${path}.${detail === "" ? "" : ` ${detail}`}`,
      response.status,
    );
  }
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = schema(body);
  if (parsed instanceof type.errors) {
    throw new RoutinesApiError(
      `Unexpected response shape from ${path}: ${parsed.summary}`,
    );
  }
  return parsed;
}

export function listRoutines(tenantId: string): Promise<readonly Routine[]> {
  return request(`/api/tenants/${tenantId}/routines`, RoutinesResponse).then(
    (page) => page.items,
  );
}

export function getRoutine(tenantId: string, id: string): Promise<Routine> {
  return request(`/api/tenants/${tenantId}/routines/${id}`, Routine);
}

export function createRoutine(
  tenantId: string,
  input: CreateRoutineInput,
): Promise<Routine> {
  return request(`/api/tenants/${tenantId}/routines`, Routine, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateRoutine(
  tenantId: string,
  id: string,
  patch: UpdateRoutineInput,
): Promise<Routine> {
  return request(`/api/tenants/${tenantId}/routines/${id}`, Routine, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteRoutine(tenantId: string, id: string): Promise<void> {
  return request(`/api/tenants/${tenantId}/routines/${id}`, type("unknown"), {
    method: "DELETE",
  }).then(() => undefined);
}

export function runRoutineNow(
  tenantId: string,
  id: string,
): Promise<{ runId: string }> {
  return request(
    `/api/tenants/${tenantId}/routines/${id}/run`,
    type({ runId: "string" }),
    { method: "POST", body: JSON.stringify({}) },
  );
}

export function listRoutineRuns(
  tenantId: string,
  id: string,
): Promise<readonly RoutineRun[]> {
  return request(
    `/api/tenants/${tenantId}/routines/${id}/runs`,
    RoutineRunsResponse,
  ).then((page) => page.items);
}

export function createRoutineDraft(
  tenantId: string,
  input: CreateDraftInput,
): Promise<RoutineDraft> {
  return request(`/api/tenants/${tenantId}/routine-drafts`, RoutineDraft, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function listRoutineDrafts(
  tenantId: string,
): Promise<readonly RoutineDraft[]> {
  return request(
    `/api/tenants/${tenantId}/routine-drafts`,
    type({ items: RoutineDraft.array() }),
  ).then((page) => page.items);
}

export function approveRoutineDraft(
  tenantId: string,
  id: string,
): Promise<{ draft: RoutineDraft; routine: Routine }> {
  return request(
    `/api/tenants/${tenantId}/routine-drafts/${id}/approve`,
    type({ draft: RoutineDraft, routine: Routine }),
    { method: "POST", body: JSON.stringify({}) },
  );
}

export function discardRoutineDraft(
  tenantId: string,
  id: string,
): Promise<RoutineDraft> {
  return request(
    `/api/tenants/${tenantId}/routine-drafts/${id}/discard`,
    RoutineDraft,
    { method: "POST", body: JSON.stringify({}) },
  );
}

/**
 * All automatable workflow definitions for the Routines create picker.
 * Walks pagination, filters via the catalog allowlist, and attaches a
 * friendly label for Menu items (never a raw id).
 */
export async function listWorkflowDefinitions(
  tenantId: string,
): Promise<readonly WorkflowDefinitionSummary[]> {
  const collected: WorkflowDefinitionSummary[] = [];
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
  return purposeDefinitions(collected).map((definition) => ({
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
        if (cause instanceof RoutinesApiError && cause.status === 401) {
          throw new UnauthenticatedError();
        }
        throw cause;
      }
    },
  });
  return toAPIQuery(result);
}

export function routineCreatedToast(name: string): string {
  return `Routine created · ${name}`;
}

export function routineRunStartedToast(name: string): string {
  return `Run started · ${name}`;
}
