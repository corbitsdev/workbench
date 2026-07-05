import { useState } from "react";
import { Link } from "react-router";
import {
  Badge,
  Button,
  ConfirmButton,
  DataTable,
  type DataTableColumn,
} from "@workbench/ui";
import type { PrincipalSummary, ResolvedGrant } from "@workbench/shared";
import {
  useAdminPrincipals,
  useDemoteFromAdmin,
  useElevateToAdmin,
  usePrincipalGrants,
} from "../../hooks/use-admin";
import { adminTableCard } from "./admin-ui";

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

function PrincipalDetail({ principal }: { principal: PrincipalSummary }) {
  const grantsQuery = usePrincipalGrants(principal.id);
  const elevate = useElevateToAdmin();
  const demote = useDemoteFromAdmin();
  const [error, setError] = useState<string | null>(null);

  const roleChangePending = elevate.isPending || demote.isPending;

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-text">
              {principal.displayName}
            </h2>
            <Badge tone={principal.kind === "user" ? "identity" : "neutral"}>
              {principal.kind}
            </Badge>
            {principal.isAdmin && <Badge tone="accent">admin</Badge>}
          </div>
          <p className="mt-0.5 font-mono text-xs text-text-3">{principal.id}</p>
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
        <h3 className="text-xs font-medium uppercase tracking-wide text-text-3">
          Roles
        </h3>
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
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-3">
          Resolved grants (direct + role-based)
        </h3>
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
          Grants are read-only here. Admin capabilities come from the admin role
          — use Make/Remove admin above. Per-capability sharing is tracked in
          CL-2799.
        </p>
      </div>
    </div>
  );
}

export function AdminPrincipals() {
  const principalsQuery = useAdminPrincipals(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const columns: DataTableColumn<PrincipalSummary>[] = [
    {
      key: "principal",
      header: "Principal",
      render: (p) => (
        <span className="font-medium text-text">
          {p.displayName}
          {p.isAdmin && (
            <span className="ml-1.5 text-xs text-orange">admin</span>
          )}
        </span>
      ),
    },
    { key: "kind", header: "Kind", render: (p) => p.kind },
    {
      key: "roles",
      header: "Roles",
      render: (p) =>
        p.roles.length > 0 ? p.roles.map((r) => r.name).join(", ") : "—",
    },
  ];

  if (principalsQuery.isLoading) {
    return <p className="text-sm text-text-2">Loading principals…</p>;
  }
  if (principalsQuery.isError) {
    return (
      <p className="text-sm text-text-2">
        Could not load principals. Try again in a moment.
      </p>
    );
  }
  const principals = principalsQuery.data ?? [];
  if (principals.length === 0) {
    return <p className="text-sm text-text-2">No principals in this tenant.</p>;
  }
  const selected = principals.find((p) => p.id === selectedId) ?? null;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <div className={adminTableCard}>
        <DataTable
          columns={columns}
          rows={principals}
          getRowKey={(p) => p.id}
          onRowClick={(p) => setSelectedId(p.id)}
          caption="Principals"
        />
      </div>

      {selected ? (
        <PrincipalDetail principal={selected} />
      ) : (
        <div className="flex items-center justify-center rounded-lg border border-dashed border-border p-10 text-sm text-text-3">
          Select a principal to view its roles and grants.
        </div>
      )}
    </div>
  );
}
