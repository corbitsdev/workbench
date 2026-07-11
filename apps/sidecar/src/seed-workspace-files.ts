import fs from "node:fs";
import path from "node:path";
import { getLogger } from "@intx/log";
import type { SeedWorkspaceFile } from "@workbench/myra/seed";

const logger = getLogger(["sidecar", "seed-workspace-files"]);

export interface SeedResult {
  created: number;
  skipped: number;
}

/**
 * Write each declared seed file into the agent workspace, never overwriting an
 * existing file — this runs on every launch and an agent's accumulated memory
 * must survive relaunches. `wx` is atomic create-if-missing, so the guarantee
 * holds without a check-then-write race.
 */
export async function seedWorkspaceFiles(
  workDir: string,
  declaredFiles: SeedWorkspaceFile[],
): Promise<SeedResult> {
  let created = 0;
  let skipped = 0;
  const workDirRoot = path.resolve(workDir);
  for (const file of declaredFiles) {
    // Defence in depth: even though the marker parser only admits plain
    // basenames, resolve the absolute target and assert it stays inside the
    // workspace before any write, so a crafted entry can never escape workDir
    // (CL-1952). file.path must be a plain basename — reject separators / `..`.
    if (
      file.path.includes("/") ||
      file.path.includes("\\") ||
      file.path.includes("..")
    ) {
      throw new Error(`Seed file path "${file.path}" must be a plain basename`);
    }
    const target = path.resolve(workDir, file.path);
    if (!target.startsWith(workDirRoot + path.sep)) {
      throw new Error(
        `Seed file path "${file.path}" resolves outside the workspace`,
      );
    }
    try {
      await fs.promises.writeFile(target, file.content, { flag: "wx" });
      created += 1;
      logger.info("Seeded workspace file {path}", { path: file.path });
    } catch (err) {
      if (
        err instanceof Error &&
        (err as NodeJS.ErrnoException).code === "EEXIST"
      ) {
        skipped += 1;
        continue;
      }
      throw err;
    }
  }
  return { created, skipped };
}
