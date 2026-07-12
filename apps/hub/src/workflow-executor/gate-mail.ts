import { eq } from "drizzle-orm";
import { principal, tenant } from "@intx/db/schema";
import { getLogger } from "@intx/log";
import type { RepoStore } from "@intx/hub-sessions";
import { deriveUserMailAddress } from "@workbench/hub-agent";
import type { HubDb } from "../db";
import { gateMailMessageKey } from "../lib/principal-mailbox";
import { writeMailboxMessage } from "../lib/mailbox-write";
import type { MailboxEventBus } from "../lib/mailbox-events";
import { describePendingGates } from "./pending-gate-info";
import { loadDeploymentMeta } from "./run-store";

const log = getLogger(["workflow-exec", "gate-mail"]);

// The web run-detail route the deep link targets (apps/web/src/router.tsx:
// `/insights/trace/:runId`). A path, not a URL — the inbox renders it relative
// to the app origin.
const RUN_TRACE_PATH_PREFIX = "/insights/trace";

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

function composeGateBody(args: {
  label: string;
  runId: string;
  signalName: string;
  choices: string | undefined;
  deepLinkPath: string;
}): string {
  const lines = [
    `The "${args.label}" workflow run is waiting for your input.`,
    "",
    `Run: ${args.runId}`,
    `Workflow: ${args.label}`,
    `Gate: ${args.signalName}`,
  ];
  if (args.choices !== undefined) {
    lines.push(`Expected response: ${args.choices}`);
  }
  lines.push("", `Respond here: ${args.deepLinkPath}`);
  return lines.join("\r\n");
}

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

  const gates = await describePendingGates(
    { repoStore: deps.repoStore, deploymentDomain: deps.deploymentDomain },
    { runId: run.runId, kind: run.kind, deploymentId: run.deploymentId },
  );
  if (gates.length === 0) {
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
  const deepLinkPath = `${RUN_TRACE_PATH_PREFIX}/${run.runId}`;

  for (const gate of gates) {
    await writeMailboxMessage(
      deps.db,
      {
        tenantId: run.tenantId,
        principalId: owner.id,
        address: recipientAddress,
        fromAddress: senderAddress,
        subject: `A workflow needs you: ${label}`,
        body: composeGateBody({
          label,
          runId: run.runId,
          signalName: gate.signalName,
          choices: gate.payloadSchema,
          deepLinkPath,
        }),
        messageKey: gateMailMessageKey(run.runId, gate.signalName),
      },
      deps.mailboxEventBus,
    );
  }
}
