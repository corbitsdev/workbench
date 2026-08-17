// `bun run sim [scenario] [--mode noop|ollama]` — boots a scratch
// stack, plays the scenario, writes a markdown report to ./output, and
// exits nonzero on any red assertion.

import { mkdir } from "node:fs/promises";
import path from "node:path";

import { assertRun, computeMetrics } from "./metrics";
import { renderReport, reportIsGreen, type RunReport } from "./report";
import { executeScenario } from "./runner";
import { summarizeScenario, type Scenario } from "./scenario";
import { busyTeamWeek } from "./scenarios/busy-team-week";
import { TODO_SCENARIOS, todoScenario } from "./scenarios/todo";
import { bootSimStack, type SimMode } from "./target";

const SCENARIOS: Readonly<Record<string, Scenario>> = {
  "busy-team-week": busyTeamWeek,
};

const args = process.argv.slice(2);
const modeFlagIndex = args.indexOf("--mode");
const mode: SimMode =
  modeFlagIndex >= 0 && args[modeFlagIndex + 1] === "ollama"
    ? "ollama"
    : "noop";
const positional = args.filter(
  (arg, index) => arg !== "--mode" && index !== modeFlagIndex + 1,
);
const scenarioName = positional[0] ?? "busy-team-week";

if (mode === "ollama" && process.env["OLLAMA_BASE_URL"] === undefined) {
  console.error("--mode ollama requires OLLAMA_BASE_URL");
  process.exit(2);
}

const scenario = SCENARIOS[scenarioName];
if (scenario === undefined) {
  if (scenarioName in TODO_SCENARIOS) todoScenario(scenarioName);
  console.error(
    `unknown scenario "${scenarioName}"; available: ${Object.keys(SCENARIOS).join(", ")}; ` +
      `stubs: ${Object.keys(TODO_SCENARIOS).join(", ")}`,
  );
  process.exit(2);
}

const shape = summarizeScenario(scenario);
console.error(
  `sim: ${scenario.name} (${shape.messages} messages, ${shape.threadReplies} replies, ` +
    `${shape.routineFires} routine fires) mode=${mode}`,
);

const stack = await bootSimStack(scenario, mode);
let exitCode: number;
try {
  const run = await executeScenario(stack, scenario);
  const metrics = computeMetrics(run);
  const assertions = assertRun(metrics, {
    minMessages: 100,
    minThreadReplies: 20,
    minRoutineFires: 10,
  });
  const report: RunReport = {
    scenarioName: scenario.name,
    description: scenario.description,
    mode,
    startedAt: new Date().toISOString(),
    labels: shape.labels,
    metrics,
    assertions,
  };
  const outputDir = path.resolve(import.meta.dir, "..", "output");
  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${scenario.name}.md`);
  await Bun.write(outputPath, renderReport(report));
  console.error(renderReport(report));
  console.error(`report: ${outputPath}`);
  exitCode = reportIsGreen(report) ? 0 : 1;
} finally {
  await stack.close();
}
process.exit(exitCode);
