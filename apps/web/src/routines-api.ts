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

import { type } from "arktype";
import type { ArkErrors } from "arktype";
import { useEffect, useState } from "react";
import type { APIQuery } from "./api";

export const RoutineTrigger = type({
  kind: "'interval'",
  unit: "'minutes' | 'hours'",
  every: "number.integer > 0",
})
  .or({
    kind: "'daily'",
    hour: "0 <= number.integer <= 23",
    minute: "0 <= number.integer <= 59",
  })
  .or({
    kind: "'weekly'",
    dayOfWeek: "0 <= number.integer <= 6",
    hour: "0 <= number.integer <= 23",
    minute: "0 <= number.integer <= 59",
  })
  .or({ kind: "'cron'", expression: "string" })
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
});
export type WorkflowDefinitionSummary = typeof WorkflowDefinitionSummary.infer;

const DefinitionsResponse = type({
  data: WorkflowDefinitionSummary.array(),
});

export type CreateRoutineInput = {
  readonly name: string;
  readonly definitionId: string;
  readonly trigger: RoutineTrigger;
  readonly scope: "personal" | "bench";
  readonly input?: Record<string, unknown>;
};

export type UpdateRoutineInput = {
  readonly name?: string;
  readonly trigger?: RoutineTrigger;
  readonly enabled?: boolean;
  readonly input?: Record<string, unknown>;
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

export function listWorkflowDefinitions(
  tenantId: string,
): Promise<readonly WorkflowDefinitionSummary[]> {
  return request(
    `/api/tenants/${tenantId}/workflows/definitions`,
    DefinitionsResponse,
  ).then((page) => page.data);
}

/**
 * The `useAPIQuery` state machine, for a fetch that needs a tenant id
 * (and thus cannot be a static path) — the extra seam
 * `@corbits/routines`' tenant-scoped routes need that `/api/me/...`
 * queries do not. `enabled` mirrors chat-page.tsx's own gate on a
 * resolved tenant: skip fetching until one exists.
 */
export function useTenantQuery<T>(
  key: readonly unknown[],
  enabled: boolean,
  fetcher: () => Promise<T>,
): APIQuery<T> {
  const [state, setState] = useState<APIQuery<T>>({ kind: "loading" });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setState({ kind: "loading" });
    void (async () => {
      try {
        const data = await fetcher();
        if (!cancelled) setState({ kind: "ready", data });
      } catch (cause) {
        if (cancelled) return;
        if (cause instanceof RoutinesApiError && cause.status === 401) {
          setState({ kind: "unauthenticated" });
          return;
        }
        setState({
          kind: "error",
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
    // `fetcher` is intentionally excluded: callers pass a fresh closure
    // every render, and `key` is the caller's own declared cache
    // identity for what that closure fetches — the same contract
    // `useAPIQuery` documents for its `schema` argument.
  }, [enabled, ...key]);

  return state;
}
