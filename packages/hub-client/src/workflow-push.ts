// Pushes a workflow definition into its asset repo over the hub's
// smart-HTTP git route, using the system git binary with a bearer
// token as the basic-auth password and a GIT_ASKPASS shim as the
// non-interactive fallback — the platform's established asset-push
// convention. Content-aware: an identical tree is a reported skip, not
// a duplicate commit, which is what makes re-running seed safe.
//
// The pushed tree is a source codebase, not the retired `workflow.json`
// envelope: a `package.json` declaring an `interchange.workflow` entry
// plus that entry module, which default-exports the definition. A
// workflow-kind asset accepts nothing else (see
// `vendor/intx/hub-sessions/src/workflow-kind.ts`), and a code-sourced
// deploy evaluates the entry rather than re-reading a serialized
// envelope. The definition these default workflows carry is inert data,
// so the entry is that data as a literal and the package declares no
// dependencies — the whole closure is these two files.

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "./errors";
import type { WorkflowPusher } from "./seed";

const ENTRY_PATH = "workflow.js";
/** The `interchange.workflow` entry a code-sourced deploy names. */
export const WORKFLOW_SOURCE_ENTRY = `./${ENTRY_PATH}`;
const PACKAGE_JSON_PATH = "package.json";

/** The two-file source tree a serialized definition renders into. */
export function renderWorkflowSourceTree(args: {
  packageName: string;
  workflowJson: string;
}): Record<string, string> {
  const packageJson = {
    name: args.packageName,
    version: "0.0.0",
    private: true,
    type: "module",
    interchange: { workflow: WORKFLOW_SOURCE_ENTRY },
  };
  return {
    [PACKAGE_JSON_PATH]: `${JSON.stringify(packageJson, null, 2)}\n`,
    [ENTRY_PATH]: `export default ${args.workflowJson};\n`,
  };
}

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

/**
 * The pushed commit is the definition's pin: a code-sourced deploy names
 * `package.format: "source"` plus this sha, so the pusher is the only
 * place that can report it.
 */
async function headSha(repoDir: string): Promise<string> {
  const result = await runGit(["rev-parse", "HEAD"], repoDir, {});
  if (result.code !== 0) {
    throw new CliError(
      `reading the pushed workflow commit failed: ${result.output}`,
      "confirm the hub is running (`bun run dev`) and re-run: workbench seed",
    );
  }
  return result.output.trim();
}

function withToken(remoteUrl: string, tokenSecret: string): string {
  const url = new URL(remoteUrl);
  url.username = "x-access-token";
  url.password = tokenSecret;
  return url.toString();
}

export function createGitWorkflowPusher(): WorkflowPusher {
  return async ({ remoteUrl, tokenSecret, workflowJson, packageName }) => {
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

      const tree = renderWorkflowSourceTree({
        packageName,
        workflowJson,
      });
      let unchanged = true;
      for (const [file, contents] of Object.entries(tree)) {
        const target = join(repoDir, file);
        let existing: string | null = null;
        try {
          existing = await readFile(target, "utf-8");
        } catch (_cause) {
          existing = null;
        }
        if (existing === contents) continue;
        unchanged = false;
        await writeFile(target, contents, "utf-8");
      }
      if (unchanged) {
        return { outcome: "unchanged", commitSha: await headSha(repoDir) };
      }

      const steps: { label: string; args: string[] }[] = [
        { label: "stage", args: ["add", ...Object.keys(tree)] },
        {
          label: "commit",
          args: ["commit", "-m", "Deploy the default workflow definition"],
        },
        {
          // Forced deliberately: this asset repo is seed-owned (this
          // pusher is its only writer), so `main` always carries
          // exactly the canonical tree this run computed. A plain push
          // 409s as "non-fast-forward" the moment the remote's `main`
          // shares no ancestry with this run's fresh clone — an
          // existing asset whose repo was seeded through a different
          // path, in particular — which would otherwise fail the entire
          // seed on a re-run rather than repointing the ref it owns.
          label: "push",
          args: [
            "-c",
            "credential.helper=",
            "push",
            "--force",
            authRemote,
            "HEAD:main",
          ],
        },
      ];
      for (const step of steps) {
        const result = await runGit(step.args, repoDir, gitEnv);
        if (result.code !== 0) {
          throw new CliError(
            `the workflow source ${step.label} failed: ${result.output}`,
            "confirm the hub is running (`bun run dev`) and re-run: workbench seed",
          );
        }
      }
      return { outcome: "pushed", commitSha: await headSha(repoDir) };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  };
}
