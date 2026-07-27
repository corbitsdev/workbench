import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Button } from "@workbench/ui";
import {
  discardOwnerWorkUnit,
  getOwnerAgedLeasedWorkUnits,
  getOwnerDeadWorkUnits,
  getOwnerWorkUnitHealth,
  retryOwnerWorkUnit,
  type OwnerWorkUnitRow,
} from "../../lib/hub-api";
import { adminTableCard } from "./admin-ui";

/**
 * Owner → Work units (WQ.6). Ops surface for dead-lettered and aged-leased
 * durable work units. Product tasks are never listed or leased here.
 */
export function OwnerWorkUnits() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscardId, setConfirmDiscardId] = useState<string | null>(null);

  const health = useQuery({
    queryKey: ["owner", "work-units", "health"],
    queryFn: getOwnerWorkUnitHealth,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  const dead = useQuery({
    queryKey: ["owner", "work-units", "dead"],
    queryFn: getOwnerDeadWorkUnits,
    staleTime: 15_000,
  });

  const aged = useQuery({
    queryKey: ["owner", "work-units", "aged"],
    queryFn: getOwnerAgedLeasedWorkUnits,
    staleTime: 15_000,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["owner", "work-units"] });
  };

  const retry = useMutation({
    mutationFn: (id: string) => retryOwnerWorkUnit(id),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: () => setError("Could not retry the work unit. Try again."),
  });

  const discard = useMutation({
    mutationFn: (id: string) => discardOwnerWorkUnit(id),
    onSuccess: () => {
      setError(null);
      setConfirmDiscardId(null);
      invalidate();
    },
    onError: () => setError("Could not discard the work unit. Try again."),
  });

  if (health.isLoading || dead.isLoading) {
    return <p className="p-3 text-sm text-text-2">Loading…</p>;
  }

  if (health.isError || dead.isError) {
    return (
      <p className="p-3 text-sm text-text-2">
        Could not load work-unit queue. Confirm the hub has the work-unit queue
        wired and try again.
      </p>
    );
  }

  const h = health.data;
  const deadItems = dead.data ?? [];
  const agedItems = aged.data ?? [];

  return (
    <div className="space-y-6">
      <p className="text-sm text-text-2">
        Durable work units (ingestion, knowledge capture, agent turns) — not
        product tasks. Retry requeues a dead unit; discard leaves it dead.
      </p>
      {error && (
        <p className="text-sm text-red-500" role="status">
          {error}
        </p>
      )}

      {h && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Dead"
            value={String(h.deadCount)}
            tone={h.deadCount > 0 ? "warn" : "ok"}
          />
          <Stat
            label="Aged leased"
            value={String(h.agedLeasedCount)}
            tone={h.agedLeasedCount > 0 ? "warn" : "ok"}
          />
          <Stat label="Pending" value={String(h.byStatus["pending"] ?? 0)} />
          <Stat
            label="Oldest pending"
            value={
              h.oldestPendingAgeMs == null
                ? "—"
                : `${Math.round(h.oldestPendingAgeMs / 1000)}s`
            }
          />
        </div>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-text">Dead letter</h2>
        {deadItems.length === 0 ? (
          <p className="text-sm text-text-2">No dead work units.</p>
        ) : (
          <WorkUnitList
            items={deadItems}
            actions={(u) => (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={retry.isPending}
                  onClick={() => retry.mutate(u.id)}
                >
                  Retry
                </Button>
                {confirmDiscardId === u.id ? (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={discard.isPending}
                      onClick={() => discard.mutate(u.id)}
                    >
                      Confirm discard
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={discard.isPending}
                      onClick={() => setConfirmDiscardId(null)}
                    >
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={discard.isPending}
                    onClick={() => setConfirmDiscardId(u.id)}
                  >
                    Discard
                  </Button>
                )}
              </div>
            )}
          />
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-text">Aged leases</h2>
        <p className="text-xs text-text-2">
          Still leased past grace — possible stuck worker. Units reclaim
          automatically when the lease expires.
        </p>
        {agedItems.length === 0 ? (
          <p className="text-sm text-text-2">No aged leases.</p>
        ) : (
          <WorkUnitList items={agedItems} />
        )}
      </section>
    </div>
  );
}

function Stat(props: { label: string; value: string; tone?: "ok" | "warn" }) {
  return (
    <div className="rounded-md border border-border bg-surface p-3">
      <div className="text-xs uppercase tracking-wide text-text-2">
        {props.label}
      </div>
      <div
        className={
          props.tone === "warn"
            ? "mt-1 text-lg font-semibold text-amber-600"
            : "mt-1 text-lg font-semibold text-text"
        }
      >
        {props.value}
      </div>
    </div>
  );
}

function WorkUnitList(props: {
  items: OwnerWorkUnitRow[];
  actions?: (u: OwnerWorkUnitRow) => ReactNode;
}) {
  return (
    <div className={adminTableCard}>
      <ul className="divide-y divide-border">
        {props.items.map((u) => (
          <li
            key={u.id}
            className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:justify-between"
          >
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium text-text">{u.kind}</span>
                <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-text-2">
                  {u.status}
                </span>
                <span className="text-xs text-text-2">
                  attempts {u.attempts}
                  {u.maxAttempts != null ? `/${u.maxAttempts}` : ""}
                </span>
              </div>
              <div className="truncate font-mono text-xs text-text-2">
                {u.idempotencyKey}
              </div>
              {u.lastError && (
                <div className="line-clamp-2 text-xs text-red-500">
                  {u.lastError}
                </div>
              )}
              {u.leaseOwner && (
                <div className="text-xs text-text-2">
                  lease: {u.leaseOwner}
                  {u.leaseUntil ? ` until ${u.leaseUntil}` : ""}
                </div>
              )}
            </div>
            {props.actions?.(u)}
          </li>
        ))}
      </ul>
    </div>
  );
}
