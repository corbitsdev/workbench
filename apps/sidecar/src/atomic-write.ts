// For a sole restore source that must survive a process kill or power
// loss without ever exposing a torn record — stronger than the cache's
// rebuildable temp+rename or fsyncWriteFile's non-atomic in-place write.

import { open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { getLogger } from "@intx/log";
import { hasCode, hexEncode } from "@intx/types";

const logger = getLogger(["interchange", "sidecar", "atomic-write"]);

export interface AtomicWriteOptions {
  /** Permission mode applied when the temp file is created. */
  mode: number;
}

/**
 * fsync before rename extends atomicity past process death to power loss
 * (without it, ext4 delayed allocation can surface a zero-length file).
 * Directory fsync failure (FAT/exFAT, some network mounts) only degrades
 * durability, so it's logged, not thrown.
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
    // Best-effort cleanup: must not mask the original cause on a second failure.
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
    logger.warn`parent-dir fsync failed for ${path}; durability is degraded but the file is renamed and fsynced — ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Fsyncs the parent dir after unlink so the removal survives a power loss —
 * without it a resurrected file would re-stale a cache whose entry this is
 * the restore source for. Idempotent: ENOENT on unlink is success.
 */
export async function removeFileAtomicDurable(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if (!(hasCode(err) && err.code === "ENOENT")) throw err;
  }

  try {
    const dirHandle = await open(dirname(path), "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch (err) {
    logger.warn`parent-dir fsync failed for ${path}; durability is degraded but the file is unlinked — ${err instanceof Error ? err.message : String(err)}`;
  }
}
