// `bun run eval` (CL-6143): plays every case in `cases/` against a
// real Myra deployment once, using `targets/real-target.ts`'s boot
// sequence.
//
// Live vs. plumbing, gated by `EVAL_PROVIDER_API_KEY`:
//   - unset:  runs with a stub credential so a turn is still genuinely
//             sent, replied to, and its (empty) tool-call list still
//             genuinely read off the platform's own tables — but a
//             scorer expecting real interview behavior will correctly
//             fail against the canned credential-error reply the stub
//             produces, so this mode checks *plumbing* only (every
//             step produced a turn with reply text and a tool-call
//             array) rather than scorer pass/fail. This keeps CI green
//             with no key configured, while still proving the harness
//             itself works end to end against the real stack.
//   - set:    runs for real, prints the full scorer table, and
//             persists the run to `evals.run` for history.
//
// Needs DATABASE_URL (see .env.example); like every e2e-shaped suite
// in this repo, a missing DATABASE_URL skips with a warning locally
// and fails loudly when E2E_REQUIRED=1 (CI).
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  ALL_EVALS,
  applyEvalsMigrations,
  bootMyraTarget,
  createPostgresEvalRunStore,
  GITHUB_MCP_FAKE_RECORDING,
  renderResultsMarkdown,
  runMatrix,
  type EvalRunResult,
  type MyraTargetInfra,
  type MyraTargetMcpFake,
  type RunConfig,
} from "@corbits/evals";
import { resetSchema, setupDatabase } from "./db-setup.ts";
import {
  api,
  connectE2eDb,
  e2eDatabaseUrl,
  expectStatus,
  freePort,
  provisionSidecar,
  startHub,
  startSidecar,
} from "./e2e/harness.ts";

const infra: MyraTargetInfra = {
  api,
  connectE2eDb,
  e2eDatabaseUrl,
  expectStatus,
  freePort,
  provisionSidecar,
  resetSchema,
  setupDatabase,
  startHub,
  startSidecar,
};

function databaseUrl(): string | undefined {
  const url = process.env["DATABASE_URL"];
  if (url !== undefined && url !== "") return url;
  if (process.env["E2E_REQUIRED"] === "1") {
    throw new Error(
      "E2E_REQUIRED=1 but DATABASE_URL is not set; `bun run eval` would be " +
        "skipped. Set DATABASE_URL to a reachable Postgres.",
    );
  }
  return undefined;
}

/**
 * Plumbing-mode's own bar: every scripted step actually produced a
 * turn (non-empty reply text) with a recorded, well-formed tool-call
 * list — never that any scorer passed. Thrown findings name the eval
 * and step so a real plumbing break (e.g. the trace reader silently
 * returning nothing) fails loudly instead of passing by accident.
 */
function assertPlumbingOnly(results: readonly EvalRunResult[]): void {
  const problems: string[] = [];
  for (const result of results) {
    for (const step of result.steps) {
      if (step.turn.replyText.trim() === "") {
        problems.push(
          `${result.evalName} step ${String(step.stepIndex)}: empty reply text`,
        );
      }
      if (!Array.isArray(step.turn.toolCalls)) {
        problems.push(
          `${result.evalName} step ${String(step.stepIndex)}: toolCalls is not an array`,
        );
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`plumbing check failed:\n${problems.join("\n")}`);
  }
}

async function main(): Promise<void> {
  const url = databaseUrl();
  if (url === undefined) {
    process.stdout.write(
      "bun run eval: DATABASE_URL is not set; skipped. Set DATABASE_URL " +
        "(see .env.example) to run it; CI sets E2E_REQUIRED=1 so this skip " +
        "can never pass silently there.\n",
    );
    return;
  }

  const live =
    (process.env["EVAL_PROVIDER_API_KEY"] !== undefined &&
      process.env["EVAL_PROVIDER_API_KEY"] !== "") ||
    (process.env["EVAL_PROVIDER"] === "ollama" &&
      process.env["OLLAMA_BASE_URL"] !== undefined);

  const configs: readonly RunConfig[] = [
    { name: live ? "live" : "plumbing-only" },
  ];
  const configByName = new Map(configs.map((config) => [config.name, config]));

  // The recorded GitHub MCP fake (CL-6338) rides every run: connected
  // through the same `POST /mcp-servers` route real users use, so a
  // live run's connect/GitHub tool calls hit the fixture instead of
  // nothing; plumbing-only runs never call a tool, so it is inert there.
  const mcpFakes: readonly MyraTargetMcpFake[] = [
    { server: "github", recording: GITHUB_MCP_FAKE_RECORDING },
  ];

  const results = await runMatrix(ALL_EVALS, configs, async (configName) => {
    const config = configByName.get(configName);
    if (config === undefined) {
      throw new Error(`no RunConfig registered for "${configName}"`);
    }
    return bootMyraTarget(config, infra, mcpFakes);
  });

  if (!live) {
    assertPlumbingOnly(results);
    process.stdout.write(
      `bun run eval: plumbing-only run passed (${String(results.length)} eval run(s), ` +
        "no EVAL_PROVIDER_API_KEY set — scorer results not required to pass).\n",
    );
  }

  const evalNames = ALL_EVALS.map((evalDef) => evalDef.name);
  const configNames = configs.map((config) => config.name);
  const markdown = renderResultsMarkdown(evalNames, configNames, results);
  process.stdout.write(`${markdown}\n`);

  const reportPath = path.join(
    import.meta.dir,
    "..",
    "packages",
    "evals",
    "eval-report.md",
  );
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, markdown);

  if (live) {
    const { store, close } = createPostgresEvalRunStore(url);
    try {
      await applyEvalsMigrations(url);
      for (const result of results) {
        await store.save(result);
      }
    } finally {
      await close();
    }

    const failed = results.flatMap((result) =>
      result.steps.flatMap((step) =>
        step.scorerReports.filter(
          (report) => !report.pass && report.skipped !== true,
        ),
      ),
    );
    if (failed.length > 0) {
      console.error(
        `bun run eval: ${String(failed.length)} scorer(s) failed:\n` +
          failed
            .map((report) => `  - ${report.name}: ${report.reason}`)
            .join("\n"),
      );
      process.exitCode = 1;
    }
  }
}

await main();
