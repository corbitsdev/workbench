// Entry point for the `workbench` command: two curated verbs, no
// generic flags, no raw-API escape hatch, and nothing interactive —
// the same invocations serve local bootstrap and hosted provisioning.

import { resolve } from "node:path";
import { readSeedConfig, readSetupConfig } from "./config";
import { createDbSetupRunner } from "./db-setup";
import { isCliError } from "./errors";
import { createHubAPI } from "./hub";
import { runSeed } from "./seed";
import { runSetup } from "./setup";
import { createGitWorkflowPusher } from "./workflow-push";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

const USAGE = `usage: workbench <command>

commands:
  setup   initialize the database, provision the organization, and
          report what you still need to supply
  seed    deploy the default workflow set to the organization and
          confirm every deployment answers

Both commands read their configuration from the environment (see
.env.example at the repository root) and are safe to re-run.
`;

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(problem: string, fix: string): never {
  process.stderr.write(`error: ${problem}\n  fix: ${fix}\n`);
  process.exit(1);
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help") {
    process.stdout.write(USAGE);
    process.exit(command === undefined ? 1 : 0);
  }
  if (rest.length > 0) {
    fail(
      `unexpected argument${rest.length > 1 ? "s" : ""}: ${rest.join(" ")}`,
      `\`workbench ${command}\` takes no arguments; configuration comes from the environment`,
    );
  }

  switch (command) {
    case "setup": {
      const config = readSetupConfig(process.env);
      await runSetup({
        config,
        api: createHubAPI(config.hubUrl),
        runDbSetup: createDbSetupRunner(REPO_ROOT),
        log: out,
      });
      return;
    }
    case "seed": {
      const config = readSeedConfig(process.env);
      await runSeed({
        config,
        api: createHubAPI(config.hubUrl),
        pushWorkflow: createGitWorkflowPusher(),
        log: out,
      });
      return;
    }
    default:
      fail(
        `unknown command: ${command}`,
        "run `workbench help` for the list of commands",
      );
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  if (isCliError(error)) fail(error.message, error.fix);
  throw error;
}
