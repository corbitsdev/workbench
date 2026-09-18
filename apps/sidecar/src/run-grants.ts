// Shared by workflow-host-wiring.ts and workflow-substrate-factory.ts, both
// of which read runs/<runId>/grants.json. Kept dependency-narrow (fs/path,
// arktype, RepoStore) so importing this into the child binary doesn't drag
// in the hub-agent deploy-router surface the wiring module also depends on.

import { readFile } from "node:fs/promises";
import { join as pathJoin } from "node:path";

import { type } from "arktype";

import type { RepoStore } from "@intx/hub-sessions";
import { isErrnoNotFound } from "@intx/workflow-host";

/** Sibling to the run's events/ blobs, so grants live and are reclaimed with the rest of the run's state. */
export function runGrantsPath(runId: string): string {
  return `runs/${runId}/grants.json`;
}

/** Entries stay unknown; the child's authorize layer narrows each against its own grant-rule validator. */
export const RunGrantsFile = type({
  grants: "unknown[]",
}).onUndeclaredKey("ignore");

/**
 * Returns undefined (distinct from an empty array) when the file is
 * absent, so the caller can tell "no per-run grants file" from "empty
 * grants set". A malformed existing file throws rather than defaulting.
 */
export async function readRunGrants(args: {
  repoStore: RepoStore;
  anchorRunId: string;
  runId: string;
}): Promise<readonly unknown[] | undefined> {
  const dir = args.repoStore.getRepoDir({
    kind: "workflow-run",
    id: args.anchorRunId,
  });
  const filePath = pathJoin(dir, runGrantsPath(args.runId));
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (cause) {
    if (isErrnoNotFound(cause)) return undefined;
    throw cause;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(
      `workflow-run/${args.anchorRunId}:${runGrantsPath(args.runId)} is not valid JSON`,
      { cause },
    );
  }
  const validated = RunGrantsFile(parsed);
  if (validated instanceof type.errors) {
    throw new Error(
      `workflow-run/${args.anchorRunId}:${runGrantsPath(args.runId)} failed validation: ${validated.summary}`,
    );
  }
  return validated.grants;
}
