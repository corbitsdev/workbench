// Shared read/write under `runs/<runId>/blobs/` for the effect ledger.
// Writes go through `writeTreePreservingPrefix` (kind-handler append-only +
// git commit); reads hit the working-tree materialization the substrate
// leaves at the same path — the established production pattern for the
// workflow-run adapters, not a durability gap. The substrate materializes
// the tree on every successful write, so a post-commit lookup always sees
// the bytes.
//
// Note: this prefix holds both content-addressed spill blobs (filename =
// sha256 of bytes, written by `@intx/workflow-host`'s blob substrate) and
// identity-keyed effect-ledger entries (filename = sha256 of the effect
// key). Do not treat the whole directory as pure content-addressed storage.

import fs from "node:fs/promises";
import path from "node:path";

import type {
  Principal,
  RepoId,
  RepoStore as SubstrateRepoStore,
} from "@intx/hub-sessions/substrate";

const RUNS_PREFIX = "runs";
const BLOBS_DIR = "blobs";

export type RunBlobStoreOpts = {
  substrate: SubstrateRepoStore;
  repoId: RepoId;
  principal: Principal;
  runId: string;
  ref: string;
};

export function blobsPrefixFor(runId: string): string {
  return `${RUNS_PREFIX}/${runId}/${BLOBS_DIR}/`;
}

export async function writeRunBlob(
  opts: RunBlobStoreOpts,
  key: string,
  bytes: Uint8Array,
  message: string,
): Promise<void> {
  const prefix = blobsPrefixFor(opts.runId);
  try {
    await opts.substrate.writeTreePreservingPrefix(
      opts.principal,
      opts.repoId,
      opts.ref,
      {
        preservePrefix: prefix,
        merge: async (existing) => {
          const files: Record<string, string | Uint8Array> = {};
          for (const [k, v] of existing) files[k] = v;
          files[`${prefix}${key}`] = bytes;
          return files;
        },
        message,
      },
    );
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    if (msg.startsWith("path_violation: ")) {
      throw new Error(msg.slice("path_violation: ".length), { cause });
    }
    throw cause;
  }
}

export async function readRunBlob(
  opts: Pick<RunBlobStoreOpts, "substrate" | "repoId" | "runId">,
  key: string,
): Promise<Uint8Array> {
  const dir = opts.substrate.getRepoDir(opts.repoId);
  const blobPath = path.join(dir, RUNS_PREFIX, opts.runId, BLOBS_DIR, key);
  return await fs.readFile(blobPath);
}

export function isErrnoNotFound(cause: unknown): boolean {
  if (cause === null || typeof cause !== "object") return false;
  return (cause as { code?: unknown }).code === "ENOENT";
}
