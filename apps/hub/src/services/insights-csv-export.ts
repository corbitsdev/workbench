import type { PricedUsage } from "@workbench/pricing";

import type { ActivityOverview } from "./activity-overview";
import type { MetricsBucket } from "./metrics-series";

function escapeField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function formatCost(cost: PricedUsage | null): string {
  if (cost === null) return "";
  return String(cost.cost.total);
}

function row(fields: (string | number)[]): string {
  return fields.map((f) => escapeField(String(f))).join(",");
}

export function insightsExportFilename(args: {
  bucket: MetricsBucket;
  range: { startDate?: string; endDate?: string };
}): string {
  const start = args.range.startDate ?? "all";
  const end = args.range.endDate ?? new Date().toISOString().slice(0, 10);
  return `insights-${args.bucket}-${start}_${end}.csv`;
}

/**
 * Multi-section tenant export: bucketed metrics series plus person, model, and
 * workflow-type breakdowns (CL-2838). Pricing comes from the hub overview call.
 */
export function buildInsightsExportCsv(overview: ActivityOverview): string {
  const lines: string[] = [];
  lines.push(
    row([
      "export_version",
      "1",
      "tenant_id",
      overview.tenantId,
      "metrics_bucket",
      overview.metricsBucket,
      "start_date",
      overview.range.startDate ?? "",
      "end_date",
      overview.range.endDate ?? "",
    ]),
  );
  lines.push("");

  lines.push("[metrics_series]");
  lines.push(
    row([
      "bucket_start",
      "agents_deployed",
      "agents_active",
      "tokens_spent",
      "artifacts_created",
    ]),
  );
  for (const point of overview.metricsSeries) {
    lines.push(
      row([
        point.bucketStart,
        point.agentsDeployed,
        point.agentsActive,
        point.tokensSpent,
        point.artifactsCreated,
      ]),
    );
  }
  lines.push("");

  lines.push("[by_person]");
  lines.push(
    row([
      "principal_id",
      "name",
      "turn_count",
      "tool_call_count",
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "thinking_tokens",
      "cost_usd",
    ]),
  );
  for (const p of overview.byPerson) {
    lines.push(
      row([
        p.principalId,
        p.name ?? "",
        p.turnCount,
        p.toolCallCount,
        p.inputTokens,
        p.outputTokens,
        p.cacheReadTokens,
        p.cacheWriteTokens,
        p.thinkingTokens,
        formatCost(p.cost),
      ]),
    );
  }
  lines.push("");

  lines.push("[by_model]");
  lines.push(
    row([
      "model",
      "turn_count",
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "thinking_tokens",
    ]),
  );
  for (const m of overview.byModel) {
    lines.push(
      row([
        m.model,
        m.turnCount,
        m.inputTokens,
        m.outputTokens,
        m.cacheReadTokens,
        m.cacheWriteTokens,
        m.thinkingTokens,
      ]),
    );
  }
  lines.push("");

  lines.push("[by_workflow_type]");
  lines.push(
    row([
      "kind",
      "turn_count",
      "tool_call_count",
      "input_tokens",
      "output_tokens",
      "cost_usd",
    ]),
  );
  for (const w of overview.byWorkflowType) {
    lines.push(
      row([
        w.kind,
        w.turnCount,
        w.toolCallCount,
        w.inputTokens,
        w.outputTokens,
        formatCost(w.cost),
      ]),
    );
  }

  return `${lines.join("\n")}\n`;
}