import { eq } from "drizzle-orm";
import { principal, tenant } from "@intx/db/schema";
import { getLogger } from "@intx/log";
import { deriveUserMailAddress } from "@workbench/hub-agent";
import type { HubDb } from "../db";
import { readMemberPreferences } from "../lib/member-preferences";
import { writeMailboxMessage } from "../lib/mailbox-write";
import type { MailboxEventBus } from "../lib/mailbox-events";
import { runTerminalMailMessageKey } from "../lib/principal-mailbox";
import { loadDeploymentMeta } from "./run-store";

const log = getLogger(["workflow-exec", "run-terminal-mail"]);

// Mirrors gate-mail.ts's RUN_TRACE_PATH_PREFIX: the web run-detail route the
// deep link targets (apps/web/src/router.tsx: `/insights/trace/:runId`). A
// path, not a URL — the inbox renders it relative to the app origin.
const RUN_TRACE_PATH_PREFIX = "/insights/trace";

export type RunTerminalStatus = "completed" | "failed";

// The identity + outcome of a run that just transitioned non-terminal ->
// terminal, handed in by the projection bridge (CL-3517). `deploymentId` may be
// null for a run whose per-run deployment record was never captured (e.g. a
// pre-CL-2582 orphan) — the label then falls back to `kind`, same as gate-mail.
export type TerminalRunContext = {
  runId: string;
  kind: string;
  tenantId: string;
  principalId: string;
  deploymentId: string | null;
  status: RunTerminalStatus;
  error?: string;
  failedSteps: readonly { stepId: string; message: string }[];
};

export type DeliverRunTerminalMailDeps = {
  db: HubDb;
  deploymentDomain: string;
  mailboxEventBus?: MailboxEventBus;
};

function composeFailureBody(args: {
  label: string;
  runId: string;
  error: string | undefined;
  failedSteps: readonly { stepId: string; message: string }[];
  deepLinkPath: string;
}): string {
  const lines = [
    `The "${args.label}" workflow run failed.`,
    "",
    `Run: ${args.runId}`,
    `Workflow: ${args.label}`,
  ];
  if (args.failedSteps.length > 0) {
    lines.push(
      `Failed step: ${args.failedSteps.map((s) => `${s.stepId} (${s.message})`).join("; ")}`,
    );
  } else if (args.error !== undefined) {
    lines.push(`Reason: ${args.error}`);
  }
  lines.push("", `View the run: ${args.deepLinkPath}`);
  return lines.join("\r\n");
}

function composeCompletionBody(args: {
  label: string;
  runId: string;
  deepLinkPath: string;
}): string {
  const lines = [
    `The "${args.label}" workflow run completed.`,
    "",
    `Run: ${args.runId}`,
    `Workflow: ${args.label}`,
    "",
    `View the run: ${args.deepLinkPath}`,
  ];
  return lines.join("\r\n");
}

/**
 * Deliver a "your workflow run finished" mailbox item to the run creator when
 * a run reaches a terminal status (CL-3517). Gated per-member by the
 * `notifyRunFailure` (default ON) / `notifyRunCompletion` (default OFF)
 * preferences, resolved for the run's `principalId`. Resolves the owner
 * strictly (must be a human `user` principal in the run's tenant, else logs at
 * error and skips — never guesses), and writes one deduplicated mailbox item
 * keyed `run:<runId>:<status>`. Best-effort by contract: the caller fires this
 * fire-and-forget so a failure never blocks pack receipt or run execution.
 */
export async function deliverRunTerminalMail(
  deps: DeliverRunTerminalMailDeps,
  run: TerminalRunContext,
): Promise<void> {
  const prefs = await readMemberPreferences(
    deps.db,
    run.tenantId,
    run.principalId,
  );
  const notifyEnabled =
    run.status === "failed"
      ? prefs.notifyRunFailure !== false
      : prefs.notifyRunCompletion === true;
  if (!notifyEnabled) return;

  const owner = await deps.db.query.principal.findFirst({
    where: eq(principal.id, run.principalId),
  });
  if (!owner || owner.kind !== "user") {
    log.error(
      "No human owner resolvable for terminal run {runId}; skipping run mail",
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
      "No tenant row for terminal run {runId} tenant {tenantId}; skipping run mail",
      { runId: run.runId, tenantId: run.tenantId },
    );
    return;
  }

  const meta =
    run.deploymentId !== null
      ? await loadDeploymentMeta(deps.db, run.deploymentId)
      : null;
  const label = meta?.label ?? run.kind;
  const recipientAddress = deriveUserMailAddress({
    userRefId: owner.refId,
    domain: tenantRow.domain,
  });
  const senderAddress = `hub@${deps.deploymentDomain}`;
  const deepLinkPath = `${RUN_TRACE_PATH_PREFIX}/${run.runId}`;

  const subject =
    run.status === "failed"
      ? `Workflow run failed: ${label}`
      : `Workflow run completed: ${label}`;
  const body =
    run.status === "failed"
      ? composeFailureBody({
          label,
          runId: run.runId,
          error: run.error,
          failedSteps: run.failedSteps,
          deepLinkPath,
        })
      : composeCompletionBody({ label, runId: run.runId, deepLinkPath });

  await writeMailboxMessage(
    deps.db,
    {
      tenantId: run.tenantId,
      principalId: owner.id,
      address: recipientAddress,
      fromAddress: senderAddress,
      subject,
      body,
      messageKey: runTerminalMailMessageKey(run.runId, run.status),
    },
    deps.mailboxEventBus,
  );
}
