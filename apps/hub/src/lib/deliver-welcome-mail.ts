import { eq } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import { getLogger } from "@intx/log";
import { deriveUserMailAddress } from "@workbench/hub-agent";
import { welcomeMailBody, welcomeMailSubject } from "@workbench/shared";
import {
  mergeMemberPreferences,
  readMemberPreferences,
} from "./member-preferences";
import { writeMailboxMessage } from "./mailbox-write";
import type { HubDb } from "../db";
import type { MailboxEventBus } from "./mailbox-events";

const log = getLogger(["hub", "deliver-welcome-mail"]);

const { principal, tenant, user, agentInstance } = intxSchema;

export const WELCOME_SENT_PREFERENCE_KEY = "onboarding.welcomeSentAt";

export type DeliverWelcomeMailArgs = {
  db: HubDb;
  tenantId: string;
  memberPrincipalId: string;
  /** The member's active Myra instance — the welcome mail's sender. */
  myraInstanceId: string;
  mailboxEventBus?: MailboxEventBus;
};

/**
 * Deliver the one-time welcome mail to a member's own inbox on first
 * provisioning (CL-3448), sent from their own Myra instance via the same
 * durable `principal_mailbox` write path as task mail (`writeMailboxMessage`).
 *
 * Idempotent on the `onboarding.welcomeSentAt` preference: a member who
 * already carries the stamp is skipped without a mailbox write. The stamp is
 * only set after `writeMailboxMessage` returns a row, so a crash between the
 * mail write and the stamp write is safe to retry — `writeMailboxMessage`'s
 * own `messageKey` (`welcome:<memberPrincipalId>`) dedupes on a resend.
 *
 * Errors are logged loudly (never swallowed silently) but not rethrown —
 * mail delivery must never turn a successful provisioning/login into a
 * caller-visible failure, matching `deliverTaskMail`'s contract.
 */
export async function deliverWelcomeMail(
  args: DeliverWelcomeMailArgs,
): Promise<void> {
  try {
    const prefs = await readMemberPreferences(
      args.db,
      args.tenantId,
      args.memberPrincipalId,
    );
    if (prefs[WELCOME_SENT_PREFERENCE_KEY]) return;

    const tenantRow = await args.db.query.tenant.findFirst({
      where: eq(tenant.id, args.tenantId),
    });
    if (!tenantRow) {
      log.error("No tenant row for {tenantId}; skipping welcome mail", {
        tenantId: args.tenantId,
      });
      return;
    }

    const memberPrincipal = await args.db.query.principal.findFirst({
      where: eq(principal.id, args.memberPrincipalId),
    });
    if (!memberPrincipal || memberPrincipal.tenantId !== args.tenantId) {
      log.error(
        "Skipping welcome mail: member {memberPrincipalId} not found in {tenantId}",
        { memberPrincipalId: args.memberPrincipalId, tenantId: args.tenantId },
      );
      return;
    }

    const myraInstance = await args.db.query.agentInstance.findFirst({
      where: eq(agentInstance.id, args.myraInstanceId),
    });
    if (!myraInstance) {
      log.error(
        "Skipping welcome mail: no agent instance row for {myraInstanceId}",
        { myraInstanceId: args.myraInstanceId },
      );
      return;
    }

    const memberUserRow = await args.db.query.user.findFirst({
      where: eq(user.id, memberPrincipal.refId),
    });
    const memberName = memberUserRow?.name ?? "there";

    const result = await writeMailboxMessage(
      args.db,
      {
        tenantId: args.tenantId,
        principalId: args.memberPrincipalId,
        address: deriveUserMailAddress({
          userRefId: memberPrincipal.refId,
          domain: tenantRow.domain,
        }),
        fromAddress: myraInstance.address,
        subject: welcomeMailSubject(),
        body: welcomeMailBody({ memberName }),
        messageKey: `welcome:${args.memberPrincipalId}`,
      },
      args.mailboxEventBus,
    );
    if (!result) return;

    await mergeMemberPreferences(
      args.db,
      args.tenantId,
      args.memberPrincipalId,
      {
        [WELCOME_SENT_PREFERENCE_KEY]: new Date().toISOString(),
      },
    );
  } catch (err) {
    log.error("Welcome mail delivery failed", {
      tenantId: args.tenantId,
      memberPrincipalId: args.memberPrincipalId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
  }
}
