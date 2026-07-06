import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import {
  Badge,
  Breadcrumbs,
  Button,
  ConfirmButton,
  DataTable,
  type DataTableColumn,
} from "@workbench/ui";
import type { ResolvedGrant } from "@workbench/shared";
import {
  useDemoteFromAdmin,
  useElevateToAdmin,
  usePrincipalDetail,
  usePrincipalGrants,
} from "../../hooks/use-admin";
import { adminTableCard, backToListPath } from "./admin-ui";

function apiMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong.";
}

const grantColumns: DataTableColumn<ResolvedGrant>[] = [
  {
    key: "resource",
    header: "Resource",
    className: "font-mono text-xs",
    render: (g) => g.resource,
  },
  {
    key: "action",
    header: "Action",
    className: "font-mono text-xs",
    render: (g) => g.action,
  },
  { key: "effect", header: "Effect", render: (g) => g.effect },
  {
    key: "source",
    header: "Source",
    render: (g) => (g.roleName ? `role: ${g.roleName}` : "direct"),
  },
];

function renderLink(to: string, label: string) {
  return <Link to={to}>{label}</Link>;
}

export function PrincipalDetail() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const principalId = id ?? null;
  const principalQuery = usePrincipalDetail(principalId);
  const grantsQuery = usePrincipalGrants(principalId);
  const elevate = useElevateToAdmin();
  const demote = useDemoteFromAdmin();
  const [error, setError] = useState<string | null>(null);

  const principal = principalQuery.data ?? null;
  const roleChangePending = elevate.isPending || demote.isPending;
  const principalsTo = backToListPath(
    "/admin/principals",
    searchParams.get("back"),
  );

  return (
    <div>
      <Breadcrumbs
        renderLink={renderLink}
        items={[
          { label: "Admin", to: "/admin" },
          { label: "Principals", to: principalsTo },
          { label: principal?.displayName ?? principalId ?? "Principal" },
        ]}
      />

      {principalQuery.isLoading && (
        <p className="text-sm text-text-2">Loading principal…</p>
      )}
      {principalQuery.isError && (
        <p className="text-sm text-text-2">
          Could not load this principal. It may have been removed.
        </p>
      )}

      {principal && (
        <div>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-semibold text-text">
                  {principal.displayName}
                </h1>
                <Badge
                  tone={principal.kind === "user" ? "identity" : "neutral"}
                >
                  {principal.kind}
                </Badge>
                {principal.isAdmin && <Badge tone="accent">admin</Badge>}
              </div>
              <p className="mt-0.5 font-mono text-xs text-text-3">
                {principal.id}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Link to={`/insights/users/${principal.id}`}>
                <Button variant="secondary" size="sm">
                  Insights
                </Button>
              </Link>
              {principal.isAdmin ? (
                <ConfirmButton
                  size="sm"
                  variant="secondary"
                  confirmLabel="Confirm remove admin"
                  disabled={roleChangePending}
                  onConfirm={() => {
                    setError(null);
                    demote.mutate(
                      { principalId: principal.id },
                      { onError: (e) => setError(apiMessage(e)) },
                    );
                  }}
                >
                  Remove admin
                </ConfirmButton>
              ) : (
                <ConfirmButton
                  size="sm"
                  confirmLabel="Confirm make admin"
                  disabled={roleChangePending}
                  onConfirm={() => {
                    setError(null);
                    elevate.mutate(
                      { principalId: principal.id },
                      { onError: (e) => setError(apiMessage(e)) },
                    );
                  }}
                >
                  Make admin
                </ConfirmButton>
              )}
            </div>
          </div>

          {error && <p className="mt-3 text-sm text-red">{error}</p>}

          <div className="mt-5">
            <h2 className="text-xs font-medium uppercase tracking-wide text-text-3">
              Roles
            </h2>
            {grantsQuery.data && grantsQuery.data.roles.length === 0 && (
              <p className="mt-1 text-sm text-text-2">No roles assigned.</p>
            )}
            <div className="mt-1 flex flex-wrap gap-1.5">
              {(grantsQuery.data?.roles ?? []).map((r) => (
                <Badge key={r.id} tone={r.isSystem ? "accent" : "neutral"}>
                  {r.name}
                </Badge>
              ))}
            </div>
          </div>

          <div className="mt-5">
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-3">
              Resolved grants (direct + role-based)
            </h2>
            {grantsQuery.isLoading && (
              <p className="text-sm text-text-2">Loading grants…</p>
            )}
            {grantsQuery.isError && (
              <p className="text-sm text-text-2">Could not load grants.</p>
            )}
            {grantsQuery.data &&
              (grantsQuery.data.grants.length === 0 ? (
                <p className="text-sm text-text-2">No grants.</p>
              ) : (
                <div className={adminTableCard}>
                  <DataTable
                    columns={grantColumns}
                    rows={grantsQuery.data.grants}
                    getRowKey={(g) => g.id}
                    caption="Resolved grants"
                  />
                </div>
              ))}
            <p className="mt-2 text-xs text-text-3">
              Grants are read-only here. Admin capabilities come from the admin
              role — use Make/Remove admin above. Per-capability sharing is
              tracked in CL-2799.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
