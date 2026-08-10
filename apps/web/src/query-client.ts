// One QueryClient for the signed-in shell: shared cache for /api/me and
// tenant-scoped reads, so navigating between pages reuses data and a bench
// switch can drop the previous bench's tenant keys in a single call.

import { QueryClient } from "@tanstack/react-query";

/** Thrown from queryFns on HTTP 401 so the client can stop retrying and the
 * APIQuery adapter can map to `kind: "unauthenticated"`. */
export class UnauthenticatedError extends Error {
  constructor(message = "unauthenticated") {
    super(message);
    this.name = "UnauthenticatedError";
  }
}

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: (failureCount, error) => {
          if (error instanceof UnauthenticatedError) return false;
          return failureCount < 3;
        },
      },
    },
  });
}

/** Stable identity-scoped keys — survive a bench switch. */
export const meKeys = {
  profile: ["me", "profile"] as const,
  principals: ["me", "principals"] as const,
  runs: ["me", "runs"] as const,
};

/** Tenant-scoped keys — removed wholesale when the user leaves a bench. */
export const tenantKeys = {
  all: (tenantId: string) => ["tenant", tenantId] as const,
  needsYou: (tenantId: string) =>
    ["tenant", tenantId, "approvals", "needs-you"] as const,
  routines: (tenantId: string) => ["tenant", tenantId, "routines"] as const,
  routineRuns: (tenantId: string, routineId: string) =>
    ["tenant", tenantId, "routines", routineId, "runs"] as const,
  routineRunHistories: (tenantId: string) =>
    ["tenant", tenantId, "routine-run-histories"] as const,
  definitions: (tenantId: string) =>
    ["tenant", tenantId, "definitions"] as const,
  agentDirectory: (tenantId: string) =>
    ["tenant", tenantId, "agents", "directory"] as const,
  assets: (tenantId: string) => ["tenant", tenantId, "assets"] as const,
  artifacts: (tenantId: string) => ["tenant", tenantId, "artifacts"] as const,
};

/**
 * Map a hub GET path onto a stable query key. Unknown paths fall back to a
 * path-keyed entry so callers cannot accidentally share cache entries.
 */
export function pathToQueryKey(path: string): readonly unknown[] {
  if (path === "/api/me") return meKeys.profile;
  if (path === "/api/me/principals") return meKeys.principals;
  if (path === "/api/me/workflows/runs") return meKeys.runs;
  const needsYou = /^\/api\/tenants\/([^/]+)\/approvals\/needs-you$/.exec(path);
  if (needsYou?.[1] !== undefined) return tenantKeys.needsYou(needsYou[1]);
  const assets = /^\/api\/tenants\/([^/]+)\/assets$/.exec(path);
  if (assets?.[1] !== undefined) return tenantKeys.assets(assets[1]);
  const artifacts = /^\/api\/tenants\/([^/]+)\/artifacts(?:\?(.*))?$/.exec(path);
  if (artifacts?.[1] !== undefined) {
    return [...tenantKeys.artifacts(artifacts[1]), artifacts[2] ?? ""] as const;
  }
  return ["path", path];
}
