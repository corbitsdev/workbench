// Maps the tenant's pending native approvals onto the agent-instance ids that
// own them, so surfaces outside a chat thread (the sidebar chat list, the
// notification bell) can show a "needs review" indicator without rendering the
// Approve/Reject card itself.
//
// An approval carries an `agentAddress` (the suspended agent's mailbox), not an
// instance id. We resolve it against the tenant's agent instances by their full
// mailbox address, falling back to the `ins_<id>` local form some addresses
// carry (matching approval-display's mailbox handling).

import type { NativeApproval } from "./approvals-api";
import type { AgentInstance } from "./hub-api";
import { splitMailAddress } from "./approval-display";

function instanceIdFromInsLocal(local: string): string | null {
  const base = local.split("+")[0] ?? local;
  if (!base.startsWith("ins_")) return null;
  return base;
}

function buildAddressToInstanceId(instances: AgentInstance[]): {
  byAddress: Map<string, string>;
  instanceIds: Set<string>;
} {
  const byAddress = new Map<string, string>();
  const instanceIds = new Set<string>();
  for (const instance of instances) {
    byAddress.set(instance.address.toLowerCase(), instance.id);
    instanceIds.add(instance.id);
  }
  return { byAddress, instanceIds };
}

function resolveInstanceId(
  agentAddress: string,
  byAddress: Map<string, string>,
  instanceIds: Set<string>,
): string | null {
  const trimmed = agentAddress.trim();
  if (trimmed === "") return null;

  const direct = byAddress.get(trimmed.toLowerCase());
  if (direct !== undefined) return direct;

  const parts = splitMailAddress(trimmed);
  const local = parts?.local ?? trimmed;
  const insId = instanceIdFromInsLocal(local);
  if (insId !== null && instanceIds.has(insId)) return insId;

  return null;
}

/**
 * Derive the set of agent-instance ids that currently have a pending approval.
 * Only `pending` rows count; a resolved/approved/rejected row must not keep an
 * indicator lit. Approvals whose `agentAddress` maps to no known instance are
 * dropped rather than guessed.
 */
export function pendingApprovalInstanceIds(
  approvals: NativeApproval[],
  instances: AgentInstance[],
): Set<string> {
  const { byAddress, instanceIds } = buildAddressToInstanceId(instances);
  const result = new Set<string>();
  for (const approval of approvals) {
    if (approval.status !== "pending") continue;
    const instanceId = resolveInstanceId(
      approval.agentAddress,
      byAddress,
      instanceIds,
    );
    if (instanceId !== null) result.add(instanceId);
  }
  return result;
}
