import type { SessionForUser } from "@workbench/onboarding";

/**
 * Slack auto-provisioned identities are members. POST /api/tenants is
 * guarded by tenancyCreation (default: owners), so channel mint must
 * run as the bench owner — same pattern as agent-DM mint.
 */
export async function slackChannelMintSession(args: {
  tenantId: string;
  getWorkbenchOwnerUserId: (tenantId: string) => Promise<string | undefined>;
  sessionFor: SessionForUser;
}): Promise<{ ownerUserId: string; cookies: string[] }> {
  const ownerUserId = await args.getWorkbenchOwnerUserId(args.tenantId);
  if (ownerUserId === undefined) {
    throw new Error(
      `no owner user id for tenant "${args.tenantId}" — cannot mint a Slack channel workbench`,
    );
  }
  const cookies = await args.sessionFor({
    userId: ownerUserId,
    tenantId: args.tenantId,
  });
  if (cookies === undefined) {
    throw new Error(
      `could not mint a session for bench owner "${ownerUserId}" to provision a Slack channel`,
    );
  }
  return { ownerUserId, cookies };
}
