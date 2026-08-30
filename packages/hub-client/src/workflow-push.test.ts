// Proves `createGitWorkflowPusher` never fails the whole seed on a
// re-seed of an existing, seed-owned asset whose repo has diverged
// history (CL-6357): the owner's second seed run hit exactly this —
// `workflow asset last-30-days-research already exists (skipped)`
// followed by `! [remote rejected] HEAD -> main (non-fast-forward)`.
// The asset repo is seed-owned (this pusher is its only writer), so a
// re-seed force-repoints `main` to the canonical content rather than
// dying on divergent history it never asked to reconcile.
import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitWorkflowPusher } from "./workflow-push";

async function git(args: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(["git", "-c", "core.hooksPath=", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stdout}${stderr}`);
  }
  return stdout;
}

describe("createGitWorkflowPusher", () => {
  test("force-repoints a seed-owned asset whose main has diverged, rather than failing the whole seed", async () => {
    const work = await mkdtemp(join(tmpdir(), "workflow-push-test-"));
    try {
      const remoteDir = join(work, "remote.git");
      // A bare repo whose default branch ("trunk") is not "main" and
      // carries no commits — the same shape an existing asset repo
      // takes when its `main` was seeded by an earlier run through a
      // path that never made "main" the repo's HEAD branch. A fresh
      // clone's checkout then shares no ancestry with the remote's
      // `main`, which is exactly what turns a later plain push into a
      // non-fast-forward rejection.
      await git(["init", "--bare", "--initial-branch=trunk", remoteDir], work);

      const seeder = join(work, "seeder");
      await git(["init", seeder], work);
      await Bun.write(join(seeder, "workflow.js"), "export default {};\n");
      await git(["add", "workflow.js"], seeder);
      await git(
        [
          "-c",
          "user.email=seed@test",
          "-c",
          "user.name=seed",
          "commit",
          "-m",
          "seed v1",
        ],
        seeder,
      );
      await git(["push", remoteDir, "HEAD:refs/heads/main"], seeder);

      const pusher = createGitWorkflowPusher();
      const outcome = await pusher({
        remoteUrl: `file://${remoteDir}`,
        tokenSecret: "unused-for-file-transport",
        workflowJson: '{"v":2}',
        packageName: "@workbench-seed/test",
      });

      expect(outcome.outcome).toBe("pushed");
      expect(outcome.commitSha).toMatch(/^[0-9a-f]{40}$/);

      const verify = join(work, "verify");
      await git(["clone", "-b", "main", remoteDir, verify], work);
      // A workflow asset takes a source codebase, never the retired
      // `workflow.json` envelope: the entry module the pushed
      // `package.json` declares default-exports the definition.
      const entry = await readFile(join(verify, "workflow.js"), "utf-8");
      expect(entry).toBe('export default {"v":2};\n');
      const manifest = await readFile(join(verify, "package.json"), "utf-8");
      expect(JSON.parse(manifest)).toMatchObject({
        name: "@workbench-seed/test",
        interchange: { workflow: "./workflow.js" },
      });
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  test("reports unchanged, without pushing, when the seed-owned content already matches", async () => {
    const work = await mkdtemp(join(tmpdir(), "workflow-push-test-"));
    try {
      const remoteDir = join(work, "remote.git");
      await git(["init", "--bare", "--initial-branch=main", remoteDir], work);

      const pusher = createGitWorkflowPusher();
      const first = await pusher({
        remoteUrl: `file://${remoteDir}`,
        tokenSecret: "unused-for-file-transport",
        workflowJson: '{"v":1}',
        packageName: "@workbench-seed/test",
      });
      expect(first.outcome).toBe("pushed");

      const second = await pusher({
        remoteUrl: `file://${remoteDir}`,
        tokenSecret: "unused-for-file-transport",
        workflowJson: '{"v":1}',
        packageName: "@workbench-seed/test",
      });
      expect(second.outcome).toBe("unchanged");
      // An unchanged push still reports the pin the deploy sources from.
      expect(second.commitSha).toBe(first.commitSha);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  test("commits the seed tree even when the operator's inherited hooksPath would reject seed@workbench.localhost", async () => {
    const work = await mkdtemp(join(tmpdir(), "workflow-push-hooks-"));
    const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
    try {
      const hooksDir = join(work, "hooks");
      await mkdir(hooksDir);
      const hook = join(hooksDir, "commit-msg");
      await writeFile(
        hook,
        `#!/bin/sh
author="\${GIT_AUTHOR_EMAIL:-}"
if [ "\$author" = "seed@workbench.localhost" ]; then
  echo "commit blocked: author must be listed in allowed-emails" >&2
  exit 1
fi
`,
        "utf-8",
      );
      await chmod(hook, 0o755);
      const globalConfig = join(work, "gitconfig");
      await writeFile(globalConfig, `[core]\nhooksPath = ${hooksDir}\n`, "utf-8");
      process.env.GIT_CONFIG_GLOBAL = globalConfig;

      const remoteDir = join(work, "remote.git");
      await git(["init", "--bare", "--initial-branch=main", remoteDir], work);

      const pusher = createGitWorkflowPusher();
      const outcome = await pusher({
        remoteUrl: `file://${remoteDir}`,
        tokenSecret: "unused-for-file-transport",
        workflowJson: '{"v":1}',
        packageName: "@workbench-seed/test",
      });

      expect(outcome.outcome).toBe("pushed");
      expect(outcome.commitSha).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      if (previousGlobal === undefined) {
        delete process.env.GIT_CONFIG_GLOBAL;
      } else {
        process.env.GIT_CONFIG_GLOBAL = previousGlobal;
      }
      await rm(work, { recursive: true, force: true });
    }
  });
});
