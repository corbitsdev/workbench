// Pushes a workflow definition into its asset repo over the hub's
// smart-HTTP git route, using the system git binary with a bearer
// token as the basic-auth password and a GIT_ASKPASS shim as the
// non-interactive fallback — the platform's established asset-push
// convention. Content-aware: an identical workflow.json is a reported
// skip, not a duplicate commit, which is what makes re-running seed
// safe.

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "./errors";
import type { PushOutcome, WorkflowPusher } from "./seed";

const WORKFLOW_JSON = "workflow.json";

function requireGit(): void {
  if (Bun.which("git") === null) {
    throw new CliError(
      "git is not installed or not on PATH; the workflow push uses the system git binary",
      "install git (macOS: `xcode-select --install`), then re-run: workbench seed",
    );
  }
}

async function runGit(
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<{ code: number; output: string }> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, output: `${stdout}${stderr}`.trim() };
}

function withToken(remoteUrl: string, tokenSecret: string): string {
  const url = new URL(remoteUrl);
  url.username = "x-access-token";
  url.password = tokenSecret;
  return url.toString();
}

export function createGitWorkflowPusher(): WorkflowPusher {
  return async ({ remoteUrl, tokenSecret, workflowJson }) => {
    requireGit();
    const work = await mkdtemp(join(tmpdir(), "workbench-seed-"));
    try {
      const askpass = join(work, "askpass.sh");
      await writeFile(
        askpass,
        `#!/bin/sh\nprintf '%s\\n' '${tokenSecret.replace(/'/g, "'\\''")}'\n`,
        "utf-8",
      );
      await chmod(askpass, 0o755);
      const gitEnv = {
        GIT_ASKPASS: askpass,
        GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: "Workbench Seed",
        GIT_AUTHOR_EMAIL: "seed@workbench.localhost",
        GIT_COMMITTER_NAME: "Workbench Seed",
        GIT_COMMITTER_EMAIL: "seed@workbench.localhost",
      };
      const authRemote = withToken(remoteUrl, tokenSecret);
      const repoDir = join(work, "repo");

      const clone = await runGit(
        ["-c", "credential.helper=", "clone", authRemote, repoDir],
        work,
        gitEnv,
      );
      if (clone.code !== 0) {
        throw new CliError(
          `cloning the workflow asset repo failed: ${clone.output}`,
          "confirm the hub is running (`bun run dev`) and re-run: workbench seed",
        );
      }

      const target = join(repoDir, WORKFLOW_JSON);
      let existing: string | null = null;
      try {
        existing = await readFile(target, "utf-8");
      } catch (_cause) {
        existing = null;
      }
      if (existing === workflowJson) return "unchanged" satisfies PushOutcome;

      await writeFile(target, workflowJson, "utf-8");
      const steps: { label: string; args: string[] }[] = [
        { label: "stage", args: ["add", WORKFLOW_JSON] },
        {
          label: "commit",
          args: ["commit", "-m", "Deploy the default workflow definition"],
        },
        {
          label: "push",
          args: ["-c", "credential.helper=", "push", authRemote, "HEAD:main"],
        },
      ];
      for (const step of steps) {
        const result = await runGit(step.args, repoDir, gitEnv);
        if (result.code !== 0) {
          throw new CliError(
            `the workflow.json ${step.label} failed: ${result.output}`,
            "confirm the hub is running (`bun run dev`) and re-run: workbench seed",
          );
        }
      }
      return "pushed" satisfies PushOutcome;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  };
}
