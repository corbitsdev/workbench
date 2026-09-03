// Whether this tenant has Granola connected — the routine trigger popover
// (see `shell/routine-panel.tsx`) reads this so an unconnected bench never
// offers "Granola call notes" as if it were a working trigger (CL-6759).
// Same honesty rule as Slack via `deployment-capabilities-api.ts`, but
// tenant-scoped: Granola's credential resolves through the ancestor chain
// (`GET /credentials/resolve/Granola`), not a deployment env gate.
import { type } from "arktype";
import { useQuery } from "@tanstack/react-query";

import { tenantKeys } from "./query-client";

const ResolvedCredential = type({
  status: "'active' | 'expired' | 'revoked' | 'error'",
});

/** True when Granola is connected (or needs attention) for `tenantId`. A
 * missing, revoked, or unreadable credential is not offerable. */
export async function fetchGranolaPluginConnected(
  tenantId: string,
): Promise<boolean> {
  const response = await fetch(
    `/api/tenants/${tenantId}/credentials/resolve/${encodeURIComponent("Granola")}`,
    { headers: { accept: "application/json" } },
  ).catch(() => null);
  if (response === null || response.status === 404) return false;
  if (!response.ok) return false;
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = ResolvedCredential(body);
  if (parsed instanceof type.errors) return false;
  // Revoked reads as not connected — same rule as
  // `@corbits/connections/plugins`' resolveOne.
  return (
    parsed.status === "active" ||
    parsed.status === "expired" ||
    parsed.status === "error"
  );
}

/** Absent (still fetching) never claims Granola is connected — the trigger
 * popover's own "hide when not available" default. */
export function useGranolaPluginConnected(tenantId: string | null): boolean {
  const { data } = useQuery({
    queryKey:
      tenantId === null
        ? (["granola-plugin-connected", "none"] as const)
        : ([...tenantKeys.all(tenantId), "granola-plugin-connected"] as const),
    queryFn: () => fetchGranolaPluginConnected(tenantId as string),
    enabled: tenantId !== null,
  });
  return data ?? false;
}
