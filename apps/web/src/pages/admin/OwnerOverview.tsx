import { useQuery } from "@tanstack/react-query";
import { getOwnerContext } from "../../lib/hub-api";
import { adminTableCard } from "./admin-ui";

/**
 * Owner-area landing. Confirms owner access (the endpoint is owner-guarded) and
 * names the workbench the owner is governing. The feature tabs (workflows,
 * models, credentials, setup, templates) hang off `OwnerLayout` alongside this.
 */
export function OwnerOverview() {
  const ctx = useQuery({
    queryKey: ["owner", "context"],
    queryFn: getOwnerContext,
    staleTime: 5 * 60_000,
  });

  if (ctx.isLoading) {
    return <p className="p-3 text-sm text-text-2">Loading…</p>;
  }
  if (ctx.isError || !ctx.data) {
    return (
      <p className="p-3 text-sm text-text-2">
        Could not load owner context. Try again in a moment.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-2">
        You are managing the underlying setup, enabled features, models, and
        credentials for this organization. Use the tabs above to manage each
        area.
      </p>
      <div className={adminTableCard}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 p-4 text-sm">
          <dt className="text-text-3">Organization tenant</dt>
          <dd className="font-mono text-text">{ctx.data.tenantId}</dd>
          <dt className="text-text-3">Your owner principal</dt>
          <dd className="font-mono text-text">{ctx.data.ownerPrincipalId}</dd>
        </dl>
      </div>
      <p className="text-xs text-text-3">
        This overview covers the organization tenant and its sub-tenants. The
        tabs act on the <span className="text-text-2">active workbench</span>{" "}
        (switch it in the sidebar); some settings inherit down the tenant tree,
        so a grant or credential set higher up applies to tenants beneath it.
      </p>
    </div>
  );
}
