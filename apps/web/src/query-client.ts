// One QueryClient for the signed-in shell: shared cache for /api/me and
// tenant-scoped reads, so navigating between pages reuses data and a bench
// switch can drop the previous bench's tenant keys in a single call.

import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";

import { ApiQueryError, UnauthenticatedError } from "@/lib/api-query";
import { workbenchesQueryKey } from "@/chat/workbench-tenants";
import type { WorkbenchKind } from "@/chat/workbench-tenants";

// A 404 is a stable answer, not a transient failure, so retrying it three
// times only delays an honest quiet no-op.
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (error instanceof UnauthenticatedError) return false;
  if (error instanceof ApiQueryError && error.status === 404) return false;
  return failureCount < 3;
}

// Both shapes mean the same thing: the DB was reset, the user was
// deleted, or the cookie expired mid-session.
export function isAuthInvalidError(error: unknown): boolean {
  if (error instanceof UnauthenticatedError) return true;
  return error instanceof ApiQueryError && error.status === 401;
}

// Without this, a query that 401s renders its own local "sign in
// required" box while the rest of the shell keeps rendering — the broken
// half-state this exists to prevent. Caller must make `onAuthInvalid`
// idempotent.
export function createAppQueryClient(onAuthInvalid: () => void = () => undefined): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => {
        if (isAuthInvalidError(error)) onAuthInvalid();
      },
    }),
    mutationCache: new MutationCache({
      onError: (error) => {
        if (isAuthInvalidError(error)) onAuthInvalid();
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: shouldRetryQuery,
      },
    },
  });
}

/** Stable identity-scoped keys — survive a bench switch. */
export const meKeys = {
  profile: ["me", "profile"] as const,
  principals: ["me", "principals"] as const,
};

/** Tenant-scoped keys — removed wholesale when the user leaves a bench. */
export const tenantKeys = {
  all: (tenantId: string) => ["tenant", tenantId] as const,
  /** `GET /api/tenants/:id` — the only source of `parentId`, so this is the
   * key `bench-context.tsx` fans out per membership to tell a bench
   * (`parentId === null`) apart from a workbench (a named child tenant). */
  detail: (tenantId: string) => ["tenant", tenantId, "detail"] as const,
  pendingApprovals: (tenantId: string) => ["tenant", tenantId, "approvals"] as const,
  /** One agent-name read per run, shared by every approval that run raised
   * (see `pending-approvals.ts`). */
  runView: (tenantId: string, runId: string) => ["tenant", tenantId, "runs", runId] as const,
  routines: (tenantId: string) => ["tenant", tenantId, "routines"] as const,
  skills: (tenantId: string) => ["tenant", tenantId, "skills"] as const,
  routineRuns: (tenantId: string, routineId: string) =>
    ["tenant", tenantId, "routines", routineId, "runs"] as const,
  routineRunHistories: (tenantId: string) => ["tenant", tenantId, "routine-run-histories"] as const,
  definitions: (tenantId: string) => ["tenant", tenantId, "definitions"] as const,
  agentDirectory: (tenantId: string) => ["tenant", tenantId, "agents", "directory"] as const,
  // Kept apart from `agentDirectory` above, which is a different
  // surface's own key.
  visibleAgents: (tenantId: string) => ["tenant", tenantId, "agents", "visible"] as const,
  assets: (tenantId: string) => ["tenant", tenantId, "assets"] as const,
  artifacts: (tenantId: string) => ["tenant", tenantId, "artifacts"] as const,
  // Nested under `artifacts` (not a sibling key) so one
  // `invalidateQueries({ queryKey: tenantKeys.artifacts(tenantId) })` after
  // an upload covers both the list and the kind-nav counts.
  artifactCounts: (tenantId: string) => ["tenant", tenantId, "artifacts", "counts"] as const,
  credentials: (tenantId: string) => ["tenant", tenantId, "credentials"] as const,
  principals: (tenantId: string) => ["tenant", tenantId, "principals"] as const,
  roles: (tenantId: string) => ["tenant", tenantId, "roles"] as const,
  grants: (tenantId: string) => ["tenant", tenantId, "grants"] as const,
  // Keyed so col2's nav band and the settings stage share one cached
  // probe instead of each firing its own.
  settingsAccess: (tenantId: string, principalId: string) =>
    ["tenant", tenantId, "settings-access", principalId] as const,
  // Delegates to `@/chat`'s own key builder so every workbench-listing
  // surface keys against one shape, not a copy that could drift apart.
  workbenches: (tenantId: string, kind: WorkbenchKind) => workbenchesQueryKey(tenantId, kind),
  // The `feed=fires` route is gone; the key is kept so a future native
  // fires equivalent has somewhere to rewire.
  routineActivity: (tenantId: string) => ["tenant", tenantId, "routine-activity"] as const,
  /** A workbench's own timeline reads: `tenantId` is the owning
   * bench chat's workbench-tenancy addresses these routes at (see
   * docs/workbench-tenancy.md), `workbenchId` the workbench's own id. */
  workbenchMessages: (tenantId: string, workbenchId: string) =>
    ["tenant", tenantId, "chat", "workbenches", workbenchId, "messages"] as const,
  workbenchThreads: (tenantId: string, workbenchId: string) =>
    ["tenant", tenantId, "chat", "workbenches", workbenchId, "threads"] as const,
  workbenchTimelineRoutineRuns: (tenantId: string, workbenchId: string) =>
    ["tenant", tenantId, "workbench-timeline-routine-runs", workbenchId] as const,
};

// Both reads must refresh together or one goes stale while the other
// doesn't.
export function invalidateRoutineQueries(queryClient: QueryClient, tenantId: string): void {
  void queryClient.invalidateQueries({
    queryKey: tenantKeys.routines(tenantId),
  });
  void queryClient.invalidateQueries({
    queryKey: tenantKeys.routineRunHistories(tenantId),
  });
}

// Unknown paths fall back to a path-keyed entry so callers can't
// accidentally share cache entries.
export function pathToQueryKey(path: string): readonly unknown[] {
  if (path === "/api/me") return meKeys.profile;
  if (path === "/api/me/principals") return meKeys.principals;
  const approvals = /^\/api\/tenants\/([^/]+)\/approvals$/.exec(path);
  if (approvals?.[1] !== undefined) {
    return tenantKeys.pendingApprovals(approvals[1]);
  }
  const assets = /^\/api\/tenants\/([^/]+)\/assets$/.exec(path);
  if (assets?.[1] !== undefined) return tenantKeys.assets(assets[1]);
  const artifactCounts = /^\/api\/tenants\/([^/]+)\/artifacts\/counts$/.exec(path);
  if (artifactCounts?.[1] !== undefined) {
    return tenantKeys.artifactCounts(artifactCounts[1]);
  }
  const artifacts = /^\/api\/tenants\/([^/]+)\/artifacts(?:\?(.*))?$/.exec(path);
  if (artifacts?.[1] !== undefined) {
    return [...tenantKeys.artifacts(artifacts[1]), artifacts[2] ?? ""] as const;
  }
  return ["path", path];
}
