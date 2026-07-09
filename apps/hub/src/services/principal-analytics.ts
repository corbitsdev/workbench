import {
  getPrincipalCostSummary,
  getPrincipalToolBreakdown,
  type PrincipalCostSummary,
  type PrincipalToolRow,
} from "@workbench/analytics";

import type { HubDb } from "../db";
import { resolveTimelinePrincipalIds } from "./principal-activity";

export type PrincipalAnalytics = {
  tools: PrincipalToolRow[];
  cost: PrincipalCostSummary;
};

// The Tools + Cost facets of the Insights principal trace, aggregated from the
// DURABLE analytics_event fact table over the SAME principal attribution set the
// timeline uses (resolveTimelinePrincipalIds) — not the loaded timeline window
// (which under-counted tools) and not a static stub (which showed no cost).
// Cross-instance/agent-level aggregation is a separate concern; this stays on
// the principal set, correct for resume-in-place persistent agents.
export async function getPrincipalAnalytics(args: {
  db: HubDb;
  tenantId: string;
  principalId: string;
}): Promise<PrincipalAnalytics> {
  const principalIds = await resolveTimelinePrincipalIds(args);
  const [tools, cost] = await Promise.all([
    getPrincipalToolBreakdown({
      db: args.db,
      tenantId: args.tenantId,
      principalIds,
    }),
    getPrincipalCostSummary({
      db: args.db,
      tenantId: args.tenantId,
      principalIds,
    }),
  ]);
  return { tools, cost };
}
