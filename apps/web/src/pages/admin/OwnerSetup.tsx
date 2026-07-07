import { useQuery } from "@tanstack/react-query";
import { getOwnerSetup } from "../../lib/hub-api";
import { adminTableCard } from "./admin-ui";

/**
 * Owner → Setup. Read-only view of the workbench's provisioned configuration:
 * tenant identity, hierarchy position, and the workflow kinds currently deployed
 * (runnable) in it. Owner-guarded server-side (the endpoint 403s non-owners).
 */
export function OwnerSetup() {
  const setup = useQuery({
    queryKey: ["owner", "setup"],
    queryFn: getOwnerSetup,
    staleTime: 5 * 60_000,
  });

  if (setup.isLoading) {
    return <p className="p-3 text-sm text-text-2">Loading…</p>;
  }
  if (setup.isError || !setup.data) {
    return (
      <p className="p-3 text-sm text-text-2">
        Could not load the workbench setup. Try again in a moment.
      </p>
    );
  }

  const {
    tenantName,
    tenantSlug,
    tenantId,
    parentTenantId,
    deployedWorkflowKinds,
  } = setup.data;

  return (
    <div className="space-y-5">
      <div className={adminTableCard}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 p-4 text-sm">
          <dt className="text-text-3">Workbench</dt>
          <dd className="text-text">{tenantName}</dd>
          <dt className="text-text-3">Slug</dt>
          <dd className="font-mono text-text">{tenantSlug}</dd>
          <dt className="text-text-3">Tenant id</dt>
          <dd className="font-mono text-text">{tenantId}</dd>
          <dt className="text-text-3">Parent tenant</dt>
          <dd className="font-mono text-text">
            {parentTenantId ?? "— (organization root)"}
          </dd>
        </dl>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-text">
          Deployed workflows
        </h2>
        {deployedWorkflowKinds.length === 0 ? (
          <p className="text-sm text-text-2">
            No workflows are deployed to this workbench yet.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {deployedWorkflowKinds.map((kind) => (
              <li
                key={kind}
                className="rounded-md border border-border px-2 py-1 font-mono text-xs text-text-2"
              >
                {kind}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-text-3">
          Enabling or disabling these per workbench is managed from the
          Workflows tab. Some settings inherit down the tenant tree.
        </p>
      </div>
    </div>
  );
}
