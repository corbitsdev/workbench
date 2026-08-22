// Snapshot/restore for an agent's on-disk identity directory across a
// state-preserving "hibernate" teardown (CL-6581, compensating for
// CL-6239's still-open upstream ask).
//
// WHY THIS EXISTS: the published `@intx/hub-agent` package's
// `handleAgentUndeploy` (`ws/hub-link.js`) unconditionally destroys
// `agentDir(dataDir, address)` -- which holds the agent's
// reconnect-challenge Ed25519 keypair under its `keys/` subdirectory --
// on EVERY `sendAgentUndeploy`, hibernate or not, and that call happens
// AFTER this sidecar's `undeploy` hook returns. Losing that keypair is the
// documented root cause of CL-6203/CL-6044: a woken agent mints a fresh
// identity, fails the hub's reconnect challenge, and the conversation goes
// silent. `agentDir` is `@intx/hub-agent`'s only stable public export for
// this path (its `keys/` subdirectory name is a documented internal
// implementation detail, not exported), so this module snapshots the whole
// directory before the destructive delete and restores it before the next
// deploy -- a workaround that depends on that call-ordering, not a fix.
// CL-6239 stays open for the real one: a non-destructive upstream undeploy.
import type { Dirent } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { agentDir } from "@intx/hub-agent";
import { reportError } from "@corbits/error-sink";

import { isErrnoNotFound } from "./conversation-state";

const VAULT_DIRNAME = "hibernated-agent-identity";
const MARKER_FILENAME = ".snapshotted-at";

/**
 * How long an untouched snapshot may sit in the vault before
 * `reapExpiredHibernationSnapshots` reclaims it. Generous relative to any
 * expected idle-sleep duration (hours to low days): an agent that is
 * legitimately woken always redeploys and restores its snapshot well
 * inside this window. An agent hibernated and then never redeployed
 * (channel deleted, member removed, workspace archived, ...) instead
 * leaves an orphaned snapshot on disk -- this bounds that orphan's
 * lifetime rather than letting it accumulate forever, per the same class
 * of leak that left 62 dead deployment records unreaped.
 */
export const HIBERNATION_SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function vaultRoot(dataDir: string): string {
  return path.join(dataDir, VAULT_DIRNAME);
}

function vaultEntryDir(dataDir: string, agentAddress: string): string {
  return path.join(
    vaultRoot(dataDir),
    path.basename(agentDir(dataDir, agentAddress)),
  );
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch (cause) {
    if (isErrnoNotFound(cause)) return false;
    throw cause;
  }
}

/**
 * Recursively chmods every file 0600 and every directory 0700, key
 * material's minimum-privilege mode -- matching the precedent in
 * `workflow-deployment-record.ts`'s `writeWorkflowDeploymentRecord`. Run
 * after a plain `fsp.cp`, which does not otherwise guarantee the copy's
 * permission bits regardless of the source's.
 */
async function hardenPermissionsRecursive(root: string): Promise<void> {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await hardenPermissionsRecursive(entryPath);
      await fsp.chmod(entryPath, 0o700);
    } else {
      await fsp.chmod(entryPath, 0o600);
    }
  }
}

export type SnapshotAgentIdentityResult = { snapshotted: boolean };

/**
 * Copy `agentDir(dataDir, agentAddress)` into this sidecar's own vault
 * directory, hardened to owner-only permissions, before the published
 * package's destructive undeploy delete reaches it. Must be called and
 * awaited from inside the `undeploy` hook, before it returns -- the
 * published `handleAgentUndeploy`'s delete runs only after that hook
 * settles, and that ordering is this technique's entire foundation.
 *
 * A missing source directory at this point means that ordering has
 * already broken (a future `@intx/hub-agent` release deletes before
 * calling this hook), so every wake from here on would silently mint a
 * fresh identity -- the exact CL-6203 bug class. That is reported loudly
 * through `reportError` rather than left to fail silent; the teardown
 * itself still proceeds either way.
 */
export async function snapshotAgentIdentity(
  dataDir: string,
  agentAddress: string,
): Promise<SnapshotAgentIdentityResult> {
  const source = agentDir(dataDir, agentAddress);
  const dest = vaultEntryDir(dataDir, agentAddress);

  if (!(await pathExists(source))) {
    reportError(
      new Error(
        "hibernate snapshot found no agent identity directory to preserve; " +
          "@intx/hub-agent's undeploy call ordering may have changed, which " +
          "would make every subsequent wake for this address mint a fresh " +
          "identity and fail the hub's reconnect challenge",
      ),
      {
        operation: "hibernated-agent-identity-vault.snapshot",
        agentId: agentAddress,
      },
    );
    return { snapshotted: false };
  }

  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.mkdir(vaultRoot(dataDir), { recursive: true, mode: 0o700 });
  await fsp.cp(source, dest, { recursive: true });
  await hardenPermissionsRecursive(dest);
  await fsp.chmod(dest, 0o700);
  await fsp.writeFile(
    path.join(dest, MARKER_FILENAME),
    new Date().toISOString(),
    {
      mode: 0o600,
    },
  );
  return { snapshotted: true };
}

export type RestoreAgentIdentityResult = { restored: boolean };

/**
 * Restore a previously vaulted identity directory back to
 * `agentDir(dataDir, agentAddress)`, if one exists, and remove it from the
 * vault. A no-op returning `{ restored: false }` for an address that was
 * never snapshotted (an ordinary fresh deploy) -- the caller's own
 * `loadOrGenerateKey` call then mints a fresh identity exactly as it
 * would with no vault involved. Must run BEFORE that `loadOrGenerateKey`
 * call so it observes the restored files rather than minting a fresh key
 * over an empty directory.
 */
export async function restoreAgentIdentity(
  dataDir: string,
  agentAddress: string,
): Promise<RestoreAgentIdentityResult> {
  const source = vaultEntryDir(dataDir, agentAddress);
  if (!(await pathExists(source))) {
    return { restored: false };
  }

  const dest = agentDir(dataDir, agentAddress);
  await fsp.rm(path.join(source, MARKER_FILENAME), { force: true });
  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.cp(source, dest, { recursive: true });
  await fsp.rm(source, { recursive: true, force: true });
  return { restored: true };
}

export type ReapExpiredHibernationSnapshotsResult = {
  /** Opaque sanitized-address directory names reaped, for observability -- never the raw address. */
  reapedEntries: string[];
};

/**
 * Sweep the vault for entries older than `retentionMs`
 * (`HIBERNATION_SNAPSHOT_RETENTION_MS` by default) and delete them. An
 * entry with no marker (an interrupted snapshot write) is treated as
 * immediately expired rather than kept forever with no way to age it.
 * Intended to run once at boot, independent of and before/after the
 * unrelated deployment-record boot-restore scan -- this function does not
 * touch that scan or its concurrency.
 */
export async function reapExpiredHibernationSnapshots(
  dataDir: string,
  opts: { retentionMs?: number; nowMs?: number } = {},
): Promise<ReapExpiredHibernationSnapshotsResult> {
  const retentionMs = opts.retentionMs ?? HIBERNATION_SNAPSHOT_RETENTION_MS;
  const nowMs = opts.nowMs ?? Date.now();
  const root = vaultRoot(dataDir);

  let entries: Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (cause) {
    if (isErrnoNotFound(cause)) return { reapedEntries: [] };
    throw cause;
  }

  const reapedEntries: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const entryPath = path.join(root, entry.name);
    const markerPath = path.join(entryPath, MARKER_FILENAME);

    let snapshottedAtIso: string | undefined;
    try {
      snapshottedAtIso = await fsp.readFile(markerPath, "utf8");
    } catch (cause) {
      if (!isErrnoNotFound(cause)) throw cause;
    }

    const snapshottedAtMs =
      snapshottedAtIso === undefined ? NaN : Date.parse(snapshottedAtIso);
    const expired = Number.isNaN(snapshottedAtMs)
      ? true
      : nowMs - snapshottedAtMs >= retentionMs;

    if (expired) {
      await fsp.rm(entryPath, { recursive: true, force: true });
      reapedEntries.push(entry.name);
    }
  }
  return { reapedEntries };
}
