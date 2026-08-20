// Proves `createGitWorkflowPusher` never fails the whole seed on a
// re-seed of an existing, seed-owned asset whose repo has diverged
// history (CL-6357): the owner's second seed run hit exactly this —
// `workflow asset last-30-days-research already exists (skipped)`
// followed by `! [remote rejected] HEAD -> main (non-fast-forward)`.
// The asset repo is seed-owned (this pusher is its only writer), so a
// re-seed force-repoints `main` to the canonical content rather than
// dying on divergent history it never asked to reconcile.
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitWorkflowPusher } from "./workflow-push";

async function git(args: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
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

      expect(outcome).toBe("pushed");

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
      expect(first).toBe("pushed");

      const second = await pusher({
        remoteUrl: `file://${remoteDir}`,
        tokenSecret: "unused-for-file-transport",
        workflowJson: '{"v":1}',
        packageName: "@workbench-seed/test",
      });
      expect(second).toBe("unchanged");
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});
