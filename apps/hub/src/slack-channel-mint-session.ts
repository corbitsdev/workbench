import { generateId } from "@intx/hub-common";
import { reportError } from "@corbits/error-sink";
import type { WorkbenchTenancyStore } from "@corbits/chat";
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
    const cause = new Error(
      `no owner user id for tenant "${args.tenantId}" — cannot mint a Slack channel workbench`,
    );
    reportError(cause, {
      operation: "slack.provisionChannel",
      tenantId: args.tenantId,
    });
    throw cause;
  }
  const cookies = await args.sessionFor({
    userId: ownerUserId,
    tenantId: args.tenantId,
  });
  if (cookies === undefined) {
    const cause = new Error(
      `could not mint a session for bench owner "${ownerUserId}" to provision a Slack channel`,
    );
    reportError(cause, {
      operation: "slack.provisionChannel",
      tenantId: args.tenantId,
      extra: { ownerUserId },
    });
    throw cause;
  }
  return { ownerUserId, cookies };
}

export type MintSlackChannelWorkbenchDeps = {
  readonly tenantId: string;
  readonly getWorkbenchOwnerUserId: (
    tenantId: string,
  ) => Promise<string | undefined>;
  readonly sessionFor: SessionForUser;
  readonly chatTenancy: Pick<
    WorkbenchTenancyStore,
    "createWorkbenchTenant" | "addWorkbenchMember"
  >;
};

export type MintSlackChannelWorkbenchInput = {
  readonly name: string;
  readonly creatorRefId: string;
};

/**
 * Mints the child workbench as the bench owner, then adds the Slack
 * member via the existing membership path so they can use the channel.
 */
export async function mintSlackChannelWorkbench(
  deps: MintSlackChannelWorkbenchDeps,
  input: MintSlackChannelWorkbenchInput,
): Promise<{
  readonly channelId: string;
  readonly ownerUserId: string;
  readonly workbenchTenantId: string;
}> {
  const { ownerUserId, cookies } = await slackChannelMintSession({
    tenantId: deps.tenantId,
    getWorkbenchOwnerUserId: deps.getWorkbenchOwnerUserId,
    sessionFor: deps.sessionFor,
  });

  const channelId = generateId("workflowRun");
  const channelTenant = await deps.chatTenancy.createWorkbenchTenant({
    parentTenantId: deps.tenantId,
    workbenchId: channelId,
    name: input.name,
    creatorUserId: ownerUserId,
    cookies,
  });

  await deps.chatTenancy.addWorkbenchMember({
    workbenchId: channelId,
    refId: input.creatorRefId,
  });

  return {
    channelId,
    ownerUserId,
    workbenchTenantId: channelTenant.tenantId,
  };
}
