// Renders a matrix of `EvalRunResult`s (eval x config) into the
// markdown table `cli.ts` writes to disk. Pure string building — no
// filesystem, no clock — so it's directly unit-testable.
import type { EvalRunResult } from "./types.ts";

function cell(result: EvalRunResult | undefined): string {
  if (result === undefined) return "—";
  const reports = result.steps.flatMap((step) => step.scorerReports);
  if (reports.length === 0) return "no scorers";
  return reports
    .map((report) => {
      if (report.skipped === true) return `${report.name}: skip`;
      return `${report.name}: ${report.pass ? "PASS" : "FAIL"}`;
    })
    .join("<br>");
}

/**
 * One markdown table, rows = eval names, columns = config names. An
 * (eval, config) pair with no result renders as "—" rather than being
 * silently omitted from the table shape.
 */
export function renderResultsMarkdown(
  evalNames: readonly string[],
  configNames: readonly string[],
  results: readonly EvalRunResult[],
): string {
  const byKey = new Map<string, EvalRunResult>();
  for (const result of results) {
    byKey.set(`${result.evalName} ${result.configName}`, result);
  }
  const header = `| Eval | ${configNames.join(" | ")} |`;
  const divider = `| --- | ${configNames.map(() => "---").join(" | ")} |`;
  const rows = evalNames.map((evalName) => {
    const cells = configNames.map((configName) =>
      cell(byKey.get(`${evalName} ${configName}`)),
    );
    return `| ${evalName} | ${cells.join(" | ")} |`;
  });
  return [header, divider, ...rows].join("\n") + "\n";
}
