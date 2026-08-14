// Per-run grants read primitives, ported from upstream Interchange's
// sidecar (apps/sidecar/src/run-grants.ts at the vendored pin). The
// hub's `run.grants` frame writes `runs/<runId>/grants.json` into a
// deployment's `workflow-run` repo; this module reads it back.

import { readFile } from "node:fs/promises";
import { join as pathJoin } from "node:path";

import { type } from "arktype";

import type { RepoStore } from "@intx/hub-sessions";
import { isErrnoNotFound } from "@intx/workflow-host";

/**
 * Path inside a deployment's `workflow-run` repo that carries a single
 * run's grants. It sits under the run's own `runs/<runId>/` subtree --
 * sibling to that run's `events/` blobs -- so a run's grants live and
 * are reclaimed with the rest of the run's state.
 */
export function runGrantsPath(runId: string): string {
  return `runs/${runId}/grants.json`;
}

/**
 * Envelope the per-run grants file carries: the canonical `{ grants: [] }`
 * shape the grants writer produces. The inner entries stay `unknown` --
 * the child's authorize layer narrows each against its own grant-rule
 * validator.
 */
export const RunGrantsFile = type({
  grants: "unknown[]",
}).onUndeclaredKey("ignore");

/**
 * Read a single run's grants from `runs/<runId>/grants.json` inside the
 * deployment's `workflow-run` repo, via the working tree (`getRepoDir`).
 *
 * Returns `undefined` -- distinct from an empty grants array -- when the
 * file is absent, so the caller can distinguish "this run got no per-run
 * grants file" from "this run's grants are the empty set". A file that
 * exists but is malformed THROWS: its presence implies a grants frame
 * was delivered, so a structural failure is a boundary bug, not a
 * default.
 */
export async function readRunGrants(args: {
  repoStore: RepoStore;
  deploymentId: string;
  runId: string;
}): Promise<readonly unknown[] | undefined> {
  const dir = args.repoStore.getRepoDir({
    kind: "workflow-run",
    id: args.deploymentId,
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
      `workflow-run/${args.deploymentId}:${runGrantsPath(args.runId)} is not valid JSON`,
      { cause },
    );
  }
  const validated = RunGrantsFile(parsed);
  if (validated instanceof type.errors) {
    throw new Error(
      `workflow-run/${args.deploymentId}:${runGrantsPath(args.runId)} failed validation: ${validated.summary}`,
    );
  }
  return validated.grants;
}
