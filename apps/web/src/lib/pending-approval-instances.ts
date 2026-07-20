// Maps the tenant's pending native approvals onto the agent-instance ids that
// own them, so surfaces outside a chat thread (the sidebar chat list, the
// notification bell, the inbox) can show a "needs review" indicator without
// rendering the Approve/Reject card itself.
//
// Address → instance resolution reuses the single canonical resolver
// (`instanceIdFromAddress` in approval-display) that the ReviewGate card also
// uses, so an indicator and the card can never disagree about which thread owns
// an approval. We additionally require the resolved id to be a KNOWN instance —
// an indicator has to attach to a real chat row, so an id for an instance not in
// the loaded list is dropped rather than shown.

import type { NativeApproval } from "./approvals-api";
import type { AgentInstance } from "./hub-api";
import {
  buildApprovalDisplayLookups,
  instanceIdFromAddress,
} from "./approval-display";

/**
 * Derive the set of agent-instance ids that currently have a pending approval.
 * Only `pending` rows count; a resolved/approved/rejected row must not keep an
 * indicator lit. Approvals whose `agentAddress` resolves to no known instance
 * are dropped rather than guessed.
 */
export function pendingApprovalInstanceIds(
  approvals: NativeApproval[],
  instances: AgentInstance[],
): Set<string> {
  const lookups = buildApprovalDisplayLookups([], instances);
  const knownInstanceIds = new Set(instances.map((instance) => instance.id));
  const result = new Set<string>();
  for (const approval of approvals) {
    if (approval.status !== "pending") continue;
    const instanceId = instanceIdFromAddress(approval.agentAddress, lookups);
    if (instanceId !== null && knownInstanceIds.has(instanceId)) {
      result.add(instanceId);
    }
  }
  return result;
}
