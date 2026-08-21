import type { CampaignConfig } from "./config";
import type { CheckpointRecord, Knee } from "./metrics";

export interface Defect {
  severity: "S1" | "S2" | "S3";
  title: string;
  detail: string;
  atMessages: number;
}

export interface CampaignReport {
  name: string;
  startedAt: string;
  config: CampaignConfig;
  checkpoints: readonly CheckpointRecord[];
  defects: readonly Defect[];
  knees: readonly Knee[];
  selfImprovement: readonly { name: string; pass: boolean; detail: string }[];
  notes: readonly string[];
}

const SEVERITY_ORDER: readonly Defect["severity"][] = ["S1", "S2", "S3"];

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function renderCheckpointTable(
  checkpoints: readonly CheckpointRecord[],
): string[] {
  if (checkpoints.length === 0) {
    return ["_no checkpoints recorded_", ""];
  }
  const lines = [
    "| messages | wall clock | send p50 | send p95 | turn p50 | msg page | msg page (deep) | workbench list | hub RSS | db size |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const checkpoint of checkpoints) {
    lines.push(
      `| ${checkpoint.atMessages} | ${formatMs(checkpoint.wallClockMs)} | ` +
        `${formatMs(checkpoint.sendLatencyP50Ms)} | ${formatMs(checkpoint.sendLatencyP95Ms)} | ` +
        `${formatMs(checkpoint.turnLatencyP50Ms)} | ${formatMs(checkpoint.messagePageMs)} | ` +
        `${formatMs(checkpoint.messagePageDeepMs)} | ${formatMs(checkpoint.workbenchListMs)} | ` +
        `${formatBytes(checkpoint.hubRssBytes)} | ${formatBytes(checkpoint.dbSizeBytes)} |`,
    );
  }
  lines.push("");
  return lines;
}

function renderSelfImprovementTable(
  selfImprovement: CampaignReport["selfImprovement"],
): string[] {
  if (selfImprovement.length === 0) {
    return ["_no self-improvement checks recorded_", ""];
  }
  const lines = ["| check | result | detail |", "| --- | --- | --- |"];
  for (const check of selfImprovement) {
    lines.push(
      `| ${check.name} | ${check.pass ? "PASS" : "FAIL"} | ${check.detail} |`,
    );
  }
  lines.push("");
  return lines;
}

function renderDefectLog(defects: readonly Defect[]): string[] {
  if (defects.length === 0) {
    return ["_no defects recorded_", ""];
  }
  const lines: string[] = [];
  for (const severity of SEVERITY_ORDER) {
    const forSeverity = defects.filter(
      (defect) => defect.severity === severity,
    );
    if (forSeverity.length === 0) continue;
    lines.push(`### ${severity}`, "");
    for (const defect of forSeverity) {
      lines.push(
        `- **${defect.title}** (at ${defect.atMessages} messages): ${defect.detail}`,
      );
    }
    lines.push("");
  }
  return lines;
}

function renderKnees(knees: readonly Knee[]): string[] {
  if (knees.length === 0) {
    return ["_no metric crossed the knee threshold_", ""];
  }
  const lines = [
    "| metric | at messages | baseline | value | ratio |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const knee of knees) {
    lines.push(
      `| ${knee.metric} | ${knee.atMessages} | ${knee.baseline.toFixed(1)} | ` +
        `${knee.value.toFixed(1)} | ${knee.ratio.toFixed(1)}x |`,
    );
  }
  lines.push("");
  return lines;
}

export function reportVerdict(report: CampaignReport): string {
  if (report.knees.length === 0) {
    return (
      `${report.name} ran ${report.config.targetMessages} messages across ` +
      `${report.checkpoints.length} checkpoints with no metric crossing the ` +
      `degradation threshold — no first point of failure identified in this run.`
    );
  }
  const earliest = [...report.knees].sort(
    (a, b) => a.atMessages - b.atMessages,
  )[0];
  if (earliest === undefined) {
    return `${report.name}: no degradation detected.`;
  }
  return (
    `${report.name} first degrades at ${earliest.atMessages} messages, where ` +
    `${earliest.metric} reached ${earliest.ratio.toFixed(1)}x its baseline of ` +
    `${earliest.baseline.toFixed(1)} — that is the first point this run's data shows the stack losing headroom.`
  );
}

export function renderCampaignReport(report: CampaignReport): string {
  const lines = [
    `# Longevity report: ${report.name}`,
    "",
    `Started: ${report.startedAt}`,
    `Seed: ${report.config.seed} — target messages: ${report.config.targetMessages}`,
    "",
    "## Checkpoints",
    "",
    ...renderCheckpointTable(report.checkpoints),
    "## Self-improvement checks",
    "",
    ...renderSelfImprovementTable(report.selfImprovement),
    "## Defects",
    "",
    ...renderDefectLog(report.defects),
    "## Knees",
    "",
    ...renderKnees(report.knees),
    "## Verdict",
    "",
    reportVerdict(report),
    "",
  ];
  if (report.notes.length > 0) {
    lines.push("## Notes", "");
    for (const note of report.notes) lines.push(`- ${note}`);
    lines.push("");
  }
  return lines.join("\n");
}
