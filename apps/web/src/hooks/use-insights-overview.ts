import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useActiveWorkbench } from "../lib/active-workbench-context";
import { getActivityOverview, type ActivityExportBucket } from "../lib/hub-api";
import { triggerActivityCsvDownload } from "../pages/insights/export-activity-csv";
import {
  resolveTenantPricedByModel,
  sumInferenceTokenClasses,
  tokenDataCaveat,
} from "../pages/insights/metrics";
import {
  filterPeople,
  mergeWorkflowKindRows,
  type ActorFilter,
} from "../pages/insights/overview-derivations";
import type { DateRange, Preset } from "../pages/insights/time-range";
import { resolveRange } from "../pages/insights/time-range";
import { useModelPricing } from "./use-model-pricing";

export function useInsightsOverview() {
  const [preset, setPreset] = useState<Preset>("30d");
  const [customRange, setCustomRange] = useState<DateRange>({});
  const [kindFilter, setKindFilter] = useState<string>("all");
  const [actorFilter, setActorFilter] = useState<ActorFilter>("all");
  const [exportBucket, setExportBucket] = useState<ActivityExportBucket>("day");
  const { activeTenantId, activeWorkbench, loading } = useActiveWorkbench();
  const pricingQuery = useModelPricing(activeTenantId ?? "");

  const dates = resolveRange(preset, customRange);

  // workflowRuns.activeExecutions from this query drives the KpiRow live
  // pulse (CL-4417). A shorter staleTime + a foreground-only poll keeps that
  // count near-real-time so a just-ended run stops pulsing within seconds
  // rather than riding out a stale cache (CL-4419); it pauses in background
  // tabs (refetchIntervalInBackground: false) to avoid hammering the hub.
  const overviewQuery = useQuery({
    queryKey: [
      "activity-overview",
      activeTenantId,
      dates.startDate ?? null,
      dates.endDate ?? null,
    ],
    queryFn: () => getActivityOverview(activeTenantId!, dates),
    enabled: !!activeTenantId,
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });

  const showSummaryLoading =
    loading || (!!activeTenantId && overviewQuery.isLoading);

  const overview = overviewQuery.data;
  const tokenCaveat = overview
    ? tokenDataCaveat(dates, overview.tokensRecordedFrom)
    : null;

  const kindRows = useMemo(
    () =>
      overview
        ? mergeWorkflowKindRows(
            overview.workflowRuns.byKind,
            overview.byWorkflowType,
          )
        : [],
    [overview],
  );
  const workflowKinds = useMemo(
    () =>
      [...new Set(kindRows.map((r) => r.kind))].sort((a, b) =>
        a.localeCompare(b),
      ),
    [kindRows],
  );
  const filteredKindRows =
    kindFilter === "all"
      ? kindRows
      : kindRows.filter((r) => r.kind === kindFilter);
  const filteredPeople = overview
    ? filterPeople(overview.byPerson, actorFilter)
    : [];

  const catalog = pricingQuery.data ?? null;
  const priced = useMemo(
    () => (overview ? resolveTenantPricedByModel(overview, catalog) : null),
    [overview, catalog],
  );
  const costTokens = overview
    ? sumInferenceTokenClasses(overview.inference.summary)
    : 0;
  const costUnavailable =
    !!overview &&
    overview.byModel.length > 0 &&
    priced === null &&
    (pricingQuery.isError || pricingQuery.isFetched);

  const canExport = (overview?.metricsSeries.length ?? 0) > 0;

  // Feeds a useMemo dep array in the page chrome; identity churn here defeats
  // that memo and re-publishes the app-header chrome on every render. The
  // range is resolved inside the callback (not taken as a per-render
  // resolveRange product) so relative presets stay current; the remaining
  // deps are state or primitives with stable identities.
  const exportCsv = useCallback(() => {
    if (!activeTenantId || !canExport) return;
    triggerActivityCsvDownload(
      activeTenantId,
      resolveRange(preset, customRange),
      exportBucket,
    );
  }, [activeTenantId, canExport, preset, customRange, exportBucket]);

  return {
    preset,
    setPreset,
    customRange,
    setCustomRange,
    kindFilter,
    setKindFilter,
    actorFilter,
    setActorFilter,
    exportBucket,
    setExportBucket,
    workbenchLoading: loading,
    activeTenantId,
    activeWorkbench,
    dates,
    overviewQuery,
    showSummaryLoading,
    overview,
    tokenCaveat,
    workflowKinds,
    filteredKindRows,
    filteredPeople,
    priced,
    catalog,
    costTokens,
    costUnavailable,
    pricingQuery,
    canExport,
    exportCsv,
  };
}
