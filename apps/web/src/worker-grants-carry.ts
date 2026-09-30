// A redeploy mints a new run, and runtime tool grants live on the run's
// principal, so non-default effects are snapshotted before the redeploy and
// re-applied once the new run's principal exists.

import { type } from "arktype";
import { reportError } from "@corbits/error-sink";
import type { GrantEffect } from "@intx/types";

import { createGrant, revokeGrant, type Grant } from "./settings/tenancy-api";

const TOOL_PREFIX = "tool:";

const Snapshot = type({
  fromPrincipalId: "string",
  effects: type({ resource: "string", effect: "'allow' | 'deny'" }).array(),
});
export type GrantSnapshot = typeof Snapshot.infer;

const storageKey = (tenantId: string, assetName: string) =>
  `workbench:worker-grants:${tenantId}:${assetName}`;

export function readGrantSnapshot(tenantId: string, assetName: string): GrantSnapshot | null {
  try {
    const raw = localStorage.getItem(storageKey(tenantId, assetName));
    if (raw === null) return null;
    const parsed = Snapshot(JSON.parse(raw));
    return parsed instanceof type.errors ? null : parsed;
  } catch (cause) {
    reportError(cause, { operation: "worker_grants_snapshot_read", tenantId });
    return null;
  }
}

function writeGrantSnapshot(tenantId: string, assetName: string, snapshot: GrantSnapshot | null) {
  try {
    if (snapshot === null) localStorage.removeItem(storageKey(tenantId, assetName));
    else localStorage.setItem(storageKey(tenantId, assetName), JSON.stringify(snapshot));
  } catch (cause) {
    reportError(cause, { operation: "worker_grants_snapshot_write", tenantId });
  }
}

/** Stock grants default to "ask"; only allow/deny differ from the default. */
export function saveGrantSnapshot(
  tenantId: string,
  assetName: string,
  principalId: string,
  tools: readonly Grant[],
) {
  const effects = tools.flatMap((grant) =>
    grant.resource.startsWith(TOOL_PREFIX) && (grant.effect === "allow" || grant.effect === "deny")
      ? [{ resource: grant.resource, effect: grant.effect }]
      : [],
  );
  if (effects.length === 0) return;
  writeGrantSnapshot(tenantId, assetName, { fromPrincipalId: principalId, effects });
}

/** Re-applies the snapshot onto a new run principal (create-then-revoke),
 * then clears it. Returns true when grants were applied. */
export async function applyGrantSnapshot(
  tenantId: string,
  assetName: string,
  principalId: string,
  tools: readonly Grant[],
): Promise<boolean> {
  const snapshot = readGrantSnapshot(tenantId, assetName);
  if (snapshot === null || snapshot.fromPrincipalId === principalId) return false;
  for (const { resource, effect } of snapshot.effects) {
    const current = tools.find((grant) => grant.resource === resource);
    if (current === undefined || current.effect === effect) continue;
    await createGrant(tenantId, {
      principalId,
      resource,
      action: "invoke",
      effect: effect satisfies GrantEffect,
      origin: "creator",
    });
    await revokeGrant(tenantId, current.id);
  }
  writeGrantSnapshot(tenantId, assetName, null);
  return true;
}
