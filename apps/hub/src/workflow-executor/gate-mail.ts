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
  // Scheduler-sourced runs are only ever pre-resolved past the entry `intake`
  // gate: the scheduler auto-delivers the stored intake payload to it
  // (CL-3509, see scheduled-intake.ts), so intake never needs a "workflow
  // needs you" item. There is no unattended driver for gates AFTER intake
  // (the Myra gate-drive agent sketched for CL-3528 is not wired into
  // production — see scheduled-workflow-gate-agent.ts) — a mid-run gate on a
  // scheduled run is exactly as unattended-stuck as any other gate, so it
  // must reach the owner's inbox like an interactive run's gate does.
  const isScheduled = record?.triggerSource === "scheduler";

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
  // The entry `intake` gate on a scheduled run is auto-signaled — never mail
  // it. Every other open gate (including post-intake gates on a scheduled
  // run) is genuinely unattended and must be delivered. This filters on the
  // SAME `INTAKE_SIGNAL_NAME` constant the scheduler's stored-intake auto-
  // delivery keys on (scheduled-intake.ts) and `deriveWorkflowGateInfo`
  // (workflow-gate-info.ts) uses to recognize the entry gate by name — a
  // workflow def naming a second, unrelated gate "intake" would suppress its
  // mail here too. There is currently no structural way to distinguish "the
  // entry gate" from "a gate literally named intake"; that's an existing
  // constraint of the name-based convention, not new here.
  const gates = isScheduled
    ? allGates.filter((gate) => gate.signalName !== INTAKE_SIGNAL_NAME)
    : allGates;
  if (gates.length === 0) {
    if (
      isScheduled &&
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
