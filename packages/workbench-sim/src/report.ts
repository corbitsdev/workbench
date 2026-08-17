// Markdown report for one scenario run: metrics, assertions, and the
// virtual-time labels the scenario passed through. Pure string work.

import type { AssertionResult, RunMetrics } from "./metrics";

export interface RunReport {
  scenarioName: string;
  description: string;
  mode: "noop" | "ollama";
  startedAt: string;
  labels: readonly string[];
  metrics: RunMetrics;
  assertions: readonly AssertionResult[];
}

export function reportIsGreen(report: RunReport): boolean {
  return report.assertions.every((assertion) => assertion.pass);
}

export function renderReport(report: RunReport): string {
  const verdict = reportIsGreen(report) ? "GREEN" : "RED";
  const lines = [
    `# Sim run: ${report.scenarioName} — ${verdict}`,
    "",
    report.description,
    "",
    `- Mode: ${report.mode}`,
    `- Started: ${report.startedAt}`,
    `- Wall clock: ${(report.metrics.wallClockMs / 1000).toFixed(1)}s`,
    `- Virtual time covered: ${report.labels.join(" -> ") || "(none)"}`,
    "",
    "## Metrics",
    "",
    `| metric | value |`,
    `| --- | --- |`,
    `| messages sent | ${report.metrics.messageCount} |`,
    `| thread replies | ${report.metrics.threadReplyCount} |`,
    `| routine fires accepted | ${report.metrics.routineFiresAccepted}/${report.metrics.routineFireCount} |`,
    `| send->persist p50 | ${report.metrics.latencyP50Ms}ms |`,
    `| send->persist p95 | ${report.metrics.latencyP95Ms}ms |`,
    `| dropped sends | ${report.metrics.dropCount} |`,
    `| db row growth | ${report.metrics.dbRowGrowth} |`,
    "",
    "## Assertions",
    "",
  ];
  for (const assertion of report.assertions) {
    lines.push(
      `- ${assertion.pass ? "PASS" : "FAIL"} ${assertion.name}: ${assertion.detail}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
