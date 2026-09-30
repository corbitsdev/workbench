import { Skeleton } from "@corbits/react-ui";
import { useQueries } from "@tanstack/react-query";

import { apiQueryOptions } from "../api";
import { insightsRunApprovalsPath, RunApprovalsResponse, type InsightsRun } from "../insights-api";
import { countApprovals, type ApprovalCounts } from "../insights-stats";

import "./approvals-insights.css";

const ROWS = [
  ["once", "Allowed once", "var(--chart-ok)"],
  ["always", "Always allowed", "var(--info)"],
  ["denied", "Denied", "var(--chart-fail)"],
  ["waiting", "Waiting on you", "var(--action)"],
] as const;

type ApprovalTally =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly counts: ApprovalCounts };

function useApprovalTally(tenantId: string, runs: readonly InsightsRun[]): ApprovalTally {
  const results = useQueries({
    queries: runs.map((run) =>
      apiQueryOptions(insightsRunApprovalsPath(tenantId, run.id), RunApprovalsResponse),
    ),
  });
  if (results.some((r) => r.isLoading)) return { kind: "loading" };
  if (results.some((r) => r.isError)) return { kind: "error" };
  return {
    kind: "ready",
    counts: countApprovals(results.flatMap((r) => r.data?.approvals ?? [])),
  };
}

export function ApprovalsCard({
  tenantId,
  runs,
  capped,
}: {
  readonly tenantId: string;
  readonly runs: readonly InsightsRun[];
  readonly capped: boolean;
}) {
  const tally = useApprovalTally(tenantId, runs);
  return (
    <section className="bi-panel">
      <h3>Approvals</h3>
      <p className="bi-sub">
        How you answered when a worker asked to act.
        {capped ? ` Based on the ${runs.length} most recent runs.` : ""}
      </p>
      {tally.kind === "loading" ? (
        <Skeleton className="h-24 w-full" />
      ) : tally.kind === "error" ? (
        <p className="bi-sub">Couldn't load approvals.</p>
      ) : (
        <div className="appr">
          {ROWS.map(([key, label, color]) => {
            const max = Math.max(...Object.values(tally.counts), 1);
            return (
              <div key={key} className="appr-row">
                <span>{label}</span>
                <b>{tally.counts[key]}</b>
                <span className="bi-meter" aria-hidden="true">
                  <i style={{ width: `${(tally.counts[key] / max) * 100}%`, background: color }} />
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** One-line drawer version of the Approvals card. */
export function ApprovalsLine({
  tenantId,
  runs,
}: {
  readonly tenantId: string;
  readonly runs: readonly InsightsRun[];
}) {
  const tally = useApprovalTally(tenantId, runs);
  if (tally.kind === "loading") return <Skeleton className="h-5 w-full" />;
  if (tally.kind === "error") return <p className="insights-note">Couldn't load approvals.</p>;
  return (
    <div className="appr-line">
      {ROWS.map(([key, label, color]) => (
        <span key={key}>
          <i style={{ background: color }} />
          {label} {tally.counts[key]}
        </span>
      ))}
    </div>
  );
}
