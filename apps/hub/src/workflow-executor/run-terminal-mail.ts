import { and, eq } from "drizzle-orm";
import { principal, tenant } from "@intx/db/schema";
import { getLogger } from "@intx/log";
import { deriveUserMailAddress } from "@workbench/hub-agent";
import { deepLinkPath } from "@workbench/shared";
import type { HubDb } from "../db";
import { memberAgentInstance } from "../db/schema";
import { scheduleScopeForRun } from "../lib/scheduled-triggers";
import { readMemberPreferences } from "../lib/member-preferences";
import { writeMailboxMessage } from "../lib/mailbox-write";
import type { MailboxEventBus } from "../lib/mailbox-events";
import { runTerminalMailMessageKey } from "../lib/principal-mailbox";
import { loadDeploymentMeta } from "./run-store";
import {
  failureNotificationKey,
  noteFailureNotification,
  noteSuccessNotification,
} from "./failure-notification-breaker";

const log = getLogger(["workflow-exec", "run-terminal-mail"]);

// A workflow run's error/step text is untrusted content (it can echo a fetched
// page, an LLM output, a third-party API error). The mailbox body is rendered
// through the app's markdown renderer, so raw error text could smuggle in active
// markup — e.g. a `[click](javascript:...)` link. We cap its length and render
// it as an inert fenced code block so it can never become live markdown.
const MAX_FAILURE_DETAIL_CHARS = 500;

function truncateDetail(text: string): string {
  if (text.length <= MAX_FAILURE_DETAIL_CHARS) return text;
  return `${text.slice(0, MAX_FAILURE_DETAIL_CHARS)}…`;
}

// Wrap arbitrary text in a fenced code block whose fence is longer than any
// backtick run inside it (CommonMark rule) so the content cannot break out of
// the fence and re-enter active markdown.
function fencedInert(text: string): string {
  const longestRun = (text.match(/`+/g) ?? []).reduce(
    (max, run) => Math.max(max, run.length),
    0,
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${text}\n${fence}`;
}

function failureDetail(
  failedSteps: readonly { stepId: string; message: string }[],
  error: string | undefined,
): string | undefined {
  if (failedSteps.length > 0) {
    return failedSteps.map((s) => `${s.stepId} (${s.message})`).join("; ");
  }
  return error;
}

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
  paused: boolean;
}): string {
  const lines = [
    `The "${args.label}" workflow run failed.`,
    "",
    `Run: ${args.runId}`,
    `Workflow: ${args.label}`,
  ];
  const detail = failureDetail(args.failedSteps, args.error);
  if (detail !== undefined) {
    const label = args.failedSteps.length > 0 ? "Failed step:" : "Reason:";
    lines.push("", label, fencedInert(truncateDetail(detail)));
  }
  lines.push("", `View the run: ${args.deepLinkPath}`);
  if (args.paused) {
    lines.push(
      "",
      "This workflow has failed repeatedly. Further failure notifications are paused until it next completes successfully.",
    );
  }
  return lines.join("\r\n");
}

/**
 * Deliver terminal-run mailbox mail for a run that just became terminal
 * (CL-3517, CL-4312).
 *
 * **Success is never generic.** A quiet/completed run does not write the
 * inbox. Success reaches the inbox only via result-specific mail (workflow
 * `mail_send`, granola fan-out, heartbeat notify, etc.). This path still
 * resets the failure-notification breaker on completion so a later failure
 * re-arms, but it never composes "Workflow run completed" rows.
 *
 * **Failure still mails** (plain language + deep link), gated per-member by
 * `notifyRunFailure` (default ON). Resolves the owner strictly (must be a
 * human `user` principal in the run's tenant, else logs at error and skips —
 * never guesses), and writes one deduplicated mailbox item keyed
 * `run:<runId>:failed`. Best-effort by contract: the caller fires this
 * fire-and-forget so a failure never blocks pack receipt or run execution.
 */
export async function deliverRunTerminalMail(
  deps: DeliverRunTerminalMailDeps,
  run: TerminalRunContext,
): Promise<void> {
  // A cancelled run folds to status `failed` with error `"cancelled"`
  // (foldRunEvents maps RunCancelled that way — there is no `cancelled` status).
  // Cancellation is user-initiated, so the owner already knows; sending a
  // "workflow run failed" notice for it would be both wrong and noise. Skip
  // entirely (CL-3517 review) — before touching the breaker, so a cancellation
  // neither counts as a failure nor resets one.
  if (run.status === "failed" && run.error === "cancelled") return;

  // Resolve owner + tenant BEFORE reading member preferences, matching
  // gate-mail's shape: a mail we can never address (no human owner / no tenant)
  // is dropped without spending a preference read.
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

  // Repeat-failure suppression is keyed on the workflow kind, and a SUCCESS for
  // that key resets it — even though we never mail generic completions
  // (CL-4312: success inbox = result mail only).
  const breakerKey = failureNotificationKey(
    run.tenantId,
    run.kind,
    run.principalId,
  );
  if (run.status === "completed") {
    noteSuccessNotification(breakerKey);
    return;
  }

  const prefs = await readMemberPreferences(
    deps.db,
    run.tenantId,
    run.principalId,
  );
  if (prefs.notifyRunFailure === false) return;

  const decision = noteFailureNotification(breakerKey);
  if (!decision.deliver) return;

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
  // Sourced from the same @workbench/shared `deepLinkPath` map gate-mail and
  // the web router key off, so a React route rename can't silently break this
  // mail's link — see the `workflow_trace` case in `deep-link.ts`.
  const runDeepLinkPath = deepLinkPath("workflow_trace", run.runId);

  await writeMailboxMessage(
    deps.db,
    {
      tenantId: run.tenantId,
      principalId: owner.id,
      address: recipientAddress,
      fromAddress: senderAddress,
      subject: `Workflow run failed: ${label}`,
      body: composeFailureBody({
        label,
        runId: run.runId,
        error: run.error,
        failedSteps: run.failedSteps,
        deepLinkPath: runDeepLinkPath,
        paused: decision.pausedNotice,
      }),
      messageKey: runTerminalMailMessageKey(run.runId, run.status),
    },
    deps.mailboxEventBus,
  );
}

/**
 * Subscribe fan-out for tenant-scoped (Everyone) schedule fires (CL-4114).
 * One run already finished under the schedule creator; deliver the same terminal
 * **failure** mail to every other Myra-provisioned member in the tenant, each
 * gated by their own `notifyRunFailure` pref (CL-4312: completed runs are
 * silent here — success is result-mail only). Creator is skipped — they already
 * received mail via `deliverRunTerminalMail`. Personal schedules and
 * non-schedule runs are no-ops.
 */
export async function fanOutTenantScheduleTerminalMail(
  deps: DeliverRunTerminalMailDeps,
  run: TerminalRunContext,
): Promise<void> {
  if (run.status === "failed" && run.error === "cancelled") return;

  const scope = await scheduleScopeForRun(deps.db, run.runId);
  if (scope !== "tenant") return;

  const members = await deps.db
    .select({ principalId: memberAgentInstance.memberPrincipalId })
    .from(memberAgentInstance)
    .where(
      and(
        eq(memberAgentInstance.tenantId, run.tenantId),
        eq(memberAgentInstance.templateKey, "myra"),
      ),
    );

  for (const member of members) {
    if (member.principalId === run.principalId) continue;
    await deliverRunTerminalMail(deps, {
      ...run,
      principalId: member.principalId,
    });
  }
}
