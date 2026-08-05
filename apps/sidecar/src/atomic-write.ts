// Atomic, durable file replacement for the host's non-rebuildable
// on-disk records. The bytes land in a fresh per-write temp file that is
// fsynced and then renamed over the target; because rename is atomic
// within a directory, a reader only ever observes the prior complete
// file or the new complete file, never a torn one. The fsync before the
// rename extends that guarantee past process death to power loss.

import { open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { getLogger } from "@intx/log";
import { hexEncode } from "@intx/types";

const log = getLogger(["sidecar", "atomic-write"]);

export interface AtomicWriteOptions {
  /** Permission mode applied when the temp file is created. */
  mode: number;
}

/**
 * Replace `path` with `contents` atomically and durably. The parent
 * directory is fsynced after the rename so the new link is itself
 * durable; a filesystem that rejects directory fsync only degrades
 * durability -- the file is already renamed and fsynced -- so that
 * failure is logged, not thrown.
 */
export async function writeFileAtomicDurable(
  path: string,
  contents: string,
  options: AtomicWriteOptions,
): Promise<void> {
  const tmp = `${path}.tmp.${String(process.pid)}.${hexEncode(crypto.getRandomValues(new Uint8Array(8)))}`;
  try {
    const handle = await open(tmp, "w", options.mode);
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (cause) {
    // Best-effort temp cleanup: the temp may never have been created,
    // and a second failure here must not mask the original cause.
    await unlink(tmp).catch(() => undefined);
    throw cause;
  }

  try {
    const dirHandle = await open(dirname(path), "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch (err) {
    log.warn`parent-dir fsync failed for ${path}; durability is degraded but the file is renamed and fsynced -- ${err instanceof Error ? err.message : String(err)}`;
  }
}
