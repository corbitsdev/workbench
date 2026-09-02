// The Routines page's one seam to `@corbits/routines`' HTTP routes (see
// packages/routines/src/routes.ts): fetch composition only. Wire schemas,
// path builders, and pure display helpers live in `@corbits/routines/client`
// — browser-safe and shared with any UI over this data, not tied to this
// app's fetch machinery (mirrors `insights-api.ts` / `@corbits/insights/client`
// and `agents-directory.ts` / `@corbits/agent-directory/client`).
// `@corbits/routines` itself is never imported directly — its public
// surface also exports Drizzle schema tables and a Postgres-backed store,
// none of which belong in a browser bundle. Targets a routine may
// reference come from `GET /api/tenants/:tenantId/workflows/targets`
// (`@corbits/routines`' targets.ts): deployed, frozen, authorized for the
// signed-in principal, already filtered to what the product offers, with
// display names attached — the browser never re-derives that list from
// the platform's raw definitions listing.

import { type } from "arktype";
import type { ArkErrors } from "arktype";
import { useQuery } from "@tanstack/react-query";
import type { APIQuery } from "@corbits/api-query";
import {
  ApiQueryError,
  UnauthenticatedError,
  toAPIQuery,
} from "@corbits/api-query";
import {
  Routine,
  RoutineRun,
  RoutinesResponse,
  RoutineRunsResponse,
  RoutineTargetsResponse,
  routineCreatedToast,
  routinePath,
  routineRunNowPath,
  routineRunStartedToast,
  routineRunsPath,
  routinesPath,
  routineTargetsPath,
} from "@corbits/routines/client";
import type {
  CreateRoutineInput,
  RoutineTarget,
  UpdateRoutineInput,
} from "@corbits/routines/client";

export {
  type CreateRoutineInput,
  type Routine,
  type RoutineRun,
  type RoutineTarget,
  type RoutineTargetKind,
  type RoutineTriggerT as RoutineTrigger,
  type UpdateRoutineInput,
} from "@corbits/routines/client";

/** One page is enough for a seeded bench; `listAllRoutineTargets` walks
 * cursors so a large tenant never silently truncates options. */
const TARGETS_PAGE_LIMIT = 100;

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
    // Envelope-first: the hub's own `error.userMessage` is already plain,
    // human copy — kept verbatim. Only the fallback (no envelope message)
    // is synthesized here, and it never repeats the request path.
    const detail = await response
      .json()
      .then(
        (body: { error?: { userMessage?: string } }) =>
          body.error?.userMessage ?? "",
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

/** One page of definitions the signed-in principal may target from a
 * routine, ordered by name; pass the previous page's `nextCursor` to
 * continue. */
export function listRoutineTargets(
  tenantId: string,
  cursor?: string,
): Promise<RoutineTargetsResponse> {
  return request(
    routineTargetsPath(tenantId, {
      limit: TARGETS_PAGE_LIMIT,
      ...(cursor !== undefined ? { cursor } : {}),
    }),
    RoutineTargetsResponse,
  );
}

/** Every routine target in the tenant, cursor-walked. */
export async function listAllRoutineTargets(
  tenantId: string,
): Promise<readonly RoutineTarget[]> {
  const collected: RoutineTarget[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await listRoutineTargets(tenantId, cursor);
    collected.push(...page.items);
    if (page.nextCursor === null) return collected;
    cursor = page.nextCursor;
  }
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
