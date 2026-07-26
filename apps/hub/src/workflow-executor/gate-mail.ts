import { eq } from "drizzle-orm";
import { principal, tenant } from "@intx/db/schema";
import { getLogger } from "@intx/log";
import type { RepoStore } from "@workbench/hub-sessions";
import { deriveUserMailAddress } from "@workbench/hub-agent";
import {
  deepLink,
  composeGateMailBody,
  composeGateMailSubject,
} from "@workbench/shared";
import type { HubDb } from "../db";
import { getConfig } from "../config";
import { gateMailMessageKey } from "../lib/principal-mailbox";
import { writeMailboxMessage } from "../lib/mailbox-write";
import type { MailboxEventBus } from "../lib/mailbox-events";
import { INTAKE_SIGNAL_NAME } from "../lib/scheduled-intake";
import { describePendingGates } from "./pending-gate-info";
import { loadDeploymentMeta, loadRunRecord } from "./run-store";

const log = getLogger(["workflow-exec", "gate-mail"]);

// The identity of an awaiting run the projection bridge hands us on the
// running -> awaiting transition. `deploymentId` is always present (an awaiting
// run owns its per-run deployment).
export type AwaitingRunContext = {
  runId: string;
  kind: string;
  tenantId: string;
  principalId: string;
  deploymentId: string;
};

export type DeliverPendingGateMailDeps = {
  db: HubDb;
  repoStore: RepoStore;
  deploymentDomain: string;
  mailboxEventBus?: MailboxEventBus;
};

/**
 * Deliver a "a workflow needs you" mailbox item to the run owner when a run
 * parks on an awaitSignal gate. Resolves the owner strictly (must be a human
 * `user` principal in the run's tenant, else logs at error and skips — never
 * guesses), enumerates every currently-open gate, and writes one deduplicated
 * mailbox item per gate (keyed `gate:<runId>:<signalName>`). Best-effort by
 * contract: the caller fires this fire-and-forget so a failure never blocks
 * pack receipt or run execution.
 */
export async function deliverPendingGateMail(
  deps: DeliverPendingGateMailDeps,
  run: AwaitingRunContext,
): Promise<void> {
  const record = await loadRunRecord(deps.db, run.runId);
  // A run whose stored/submitted intake was accepted for auto-delivery
  // (CL-3509 scheduler; CL-4548 manual start — see scheduled-intake.ts) still
  // carries the durable `pendingSignal` row until the log proves receipt
  // (run-store.ts `clearPendingSignal`). While that row names the `intake`
  // signal, the entry gate is ALREADY resolving without a human, so it must
  // never get a "workflow needs you" item — keying on the queued signal
  // itself (not on `triggerSource`) means this suppresses correctly for
  // EITHER start door, and only for as long as the delivery is actually in
  // flight: a run whose intake was never supplied (empty/invalid payload, any
  // door) never gets a pendingSignal row here and is mailed normally. There is
  // no unattended driver for gates AFTER intake (the Myra gate-drive agent
  // sketched for CL-3528 is not wired into production — see
  // scheduled-workflow-gate-agent.ts) — a mid-run gate on a run with no
  // pending intake signal is exactly as unattended-stuck as any other gate, so
  // it must reach the owner's inbox like any other gate does.
  const hasQueuedIntakeSignal =
    record?.pendingSignal?.signalName === INTAKE_SIGNAL_NAME;

  const owner = await deps.db.query.principal.findFirst({
    where: eq(principal.id, run.principalId),
  });
  if (!owner || owner.kind !== "user") {
    log.error(
      "No human owner resolvable for awaiting run {runId}; skipping gate mail",
      {
        runId: run.runId,
        principalId: run.principalId,
        ownerKind: owner?.kind,
      },
    );
    return;
  }

  const tenantRow = await deps.db.query.tenant.findFirst({
    where: eq(tenant.id, run.tenantId),
  });
  if (!tenantRow) {
    log.error(
      "No tenant row for awaiting run {runId} tenant {tenantId}; skipping gate mail",
      { runId: run.runId, tenantId: run.tenantId },
    );
    return;
  }

  const allGates = await describePendingGates(
    { repoStore: deps.repoStore, deploymentDomain: deps.deploymentDomain },
    { runId: run.runId, kind: run.kind, deploymentId: run.deploymentId },
  );
  // The entry `intake` gate is auto-signaled while its delivery is in flight
  // (either start door) — never mail it. Every other open gate (including
  // post-intake gates) is genuinely unattended and must be delivered. This
  // filters on the SAME `INTAKE_SIGNAL_NAME` constant the auto-delivery keys
  // on (scheduled-intake.ts) and `deriveWorkflowGateInfo`
  // (workflow-gate-info.ts) uses to recognize the entry gate by name — a
  // workflow def naming a second, unrelated gate "intake" would suppress its
  // mail here too. There is currently no structural way to distinguish "the
  // entry gate" from "a gate literally named intake"; that's an existing
  // constraint of the name-based convention, not new here.
  const gates = hasQueuedIntakeSignal
    ? allGates.filter((gate) => gate.signalName !== INTAKE_SIGNAL_NAME)
    : allGates;
  if (gates.length === 0) {
    if (
      hasQueuedIntakeSignal &&
      allGates.some((g) => g.signalName === INTAKE_SIGNAL_NAME)
    ) {
      // Expected: the only open gate is the auto-signaled entry intake gate.
      return;
    }
    log.warn("Awaiting run {runId} has no readable open gate; no gate mail", {
      runId: run.runId,
    });
    return;
  }

  const meta = await loadDeploymentMeta(deps.db, run.deploymentId);
  const label = meta?.label ?? run.kind;
  const recipientAddress = deriveUserMailAddress({
    userRefId: owner.refId,
    domain: tenantRow.domain,
  });
  const senderAddress = `hub@${deps.deploymentDomain}`;
  const baseUrl = getConfig().cors.origins[0] ?? getConfig().auth.baseUrl;
  const deepLinkPath = deepLink("workflow_run", run.runId, baseUrl);

  for (const gate of gates) {
    await writeMailboxMessage(
      deps.db,
      {
        tenantId: run.tenantId,
        principalId: owner.id,
        address: recipientAddress,
        fromAddress: senderAddress,
        subject: composeGateMailSubject(label),
        body: composeGateMailBody({
          label,
          runId: run.runId,
          signalName: gate.signalName,
          choices: gate.payloadSchema,
          deepLinkPath,
        }),
        messageKey: gateMailMessageKey(run.runId, gate.signalName),
        refs: [
          { kind: "workflow_run", ref: run.runId, label: `Open ${label}` },
        ],
      },
      deps.mailboxEventBus,
    );
  }
}
