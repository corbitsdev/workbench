// One QueryClient for the signed-in shell: shared cache for /api/me and
// tenant-scoped reads, so navigating between pages reuses data and a bench
// switch can drop the previous bench's tenant keys in a single call.

import { QueryClient } from "@tanstack/react-query";

import { UnauthenticatedError } from "@corbits/api-query";
import { channelsQueryKey } from "@corbits/chat-ui";
import type { ChannelKind } from "@corbits/chat-ui";

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
  channelTenancyKinds: (tenantIds: readonly string[]) =>
    ["me", "channel-tenancy-kinds", [...tenantIds].sort()] as const,
};

/** Tenant-scoped keys — removed wholesale when the user leaves a bench. */
export const tenantKeys = {
  all: (tenantId: string) => ["tenant", tenantId] as const,
  needsYou: (tenantId: string) =>
    ["tenant", tenantId, "approvals", "needs-you"] as const,
  routines: (tenantId: string) => ["tenant", tenantId, "routines"] as const,
  skills: (tenantId: string) => ["tenant", tenantId, "skills"] as const,
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
  // Nested under `artifacts` (not a sibling key) so one
  // `invalidateQueries({ queryKey: tenantKeys.artifacts(tenantId) })` after
  // an upload covers both the list and the kind-nav counts.
  artifactCounts: (tenantId: string) =>
    ["tenant", tenantId, "artifacts", "counts"] as const,
  /** Settings section-nav gating (People/Roles/Grants/Credentials). Keyed
   * so col2's nav band and the settings stage — mounted in separate
   * subtrees — share one cached probe instead of each firing its own. */
  settingsAccess: (tenantId: string, principalId: string) =>
    ["tenant", tenantId, "settings-access", principalId] as const,
  /** Delegates to `@corbits/chat-ui`'s own key builder — that package owns
   * both the channels endpoint and `ChannelKind`, so this is the one array
   * shape every channel-listing surface (bench-activity, command palette,
   * the Routines picker, `ChatWorkspace`'s own sidebar) keys against,
   * rather than each side of the app/package boundary keeping its own copy
   * of the literal that could drift apart. */
  channels: (tenantId: string, kind: ChannelKind) =>
    channelsQueryKey(tenantId, kind),
  tasks: (tenantId: string) => ["tenant", tenantId, "tasks"] as const,
  taskLegs: (tenantId: string, taskId: string) =>
    ["tenant", tenantId, "tasks", taskId, "legs"] as const,
  taskByRun: (tenantId: string, runId: string) =>
    ["tenant", tenantId, "tasks", "by-run", runId] as const,
  topLevelRuns: (tenantId: string) =>
    ["tenant", tenantId, "top-level-runs"] as const,
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
  const artifactCounts = /^\/api\/tenants\/([^/]+)\/artifacts\/counts$/.exec(
    path,
  );
  if (artifactCounts?.[1] !== undefined) {
    return tenantKeys.artifactCounts(artifactCounts[1]);
  }
  const artifacts = /^\/api\/tenants\/([^/]+)\/artifacts(?:\?(.*))?$/.exec(
    path,
  );
  if (artifacts?.[1] !== undefined) {
    return [...tenantKeys.artifacts(artifacts[1]), artifacts[2] ?? ""] as const;
  }
  const taskLegs = /^\/api\/tenants\/([^/]+)\/tasks\/([^/]+)\/legs$/.exec(path);
  if (taskLegs?.[1] !== undefined && taskLegs[2] !== undefined) {
    return tenantKeys.taskLegs(taskLegs[1], taskLegs[2]);
  }
  const taskByRun = /^\/api\/tenants\/([^/]+)\/tasks\/by-run\/([^/]+)$/.exec(
    path,
  );
  if (taskByRun?.[1] !== undefined && taskByRun[2] !== undefined) {
    return tenantKeys.taskByRun(taskByRun[1], taskByRun[2]);
  }
  return ["path", path];
}
