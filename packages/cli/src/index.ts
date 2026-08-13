// Entry point for the `workbench` command: three curated verbs, no
// generic flags, no raw-API escape hatch, and nothing interactive —
// the same invocations serve local bootstrap and hosted provisioning.

import { resolve } from "node:path";
import {
  createGitWorkflowPusher,
  createHubAPI,
  isCliError,
} from "@workbench/hub-client";
import { readSeedConfig, readSetupConfig } from "./config";
import { createDbSetupRunner, createResetRunner } from "./db-setup";
import { runReset } from "./reset";
import { runSeed } from "./seed";
import { runSetup } from "./setup";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

const USAGE = `usage: workbench <command>

commands:
  setup   initialize the database, provision the bench, and
          report what you still need to supply
  seed    deploy the default workflow set to the bench and
          confirm every deployment answers
  reset   tear down local state (database schema and on-disk
          asset state) so the next \`bun run dev\` starts fresh;
          refuses against anything but a local DATABASE_URL

All three commands read their configuration from the environment (see
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
    case "reset": {
      await runReset({
        runReset: createResetRunner(REPO_ROOT),
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
