/**
 * Resolve-or-create the workbench channel a Slack channel is bound to.
 *
 * v1 is deliberately the simplest honest shape: one workbench channel
 * per Slack channel, minted on first contact and titled after the
 * Slack channel's own name. `provisionChannel` is injected — it is the
 * host's real channel-creation path (the same one `POST /channels`
 * uses: `ChannelTenancyStore.createChannelTenant` +
 * `ChatPlatform.launchChannel` + `launchAndJoinAgent`, from
 * `@corbits/chat`), never reimplemented here.
 *
 * A race between two concurrent first messages in the same Slack
 * channel can provision two workbench channels before either binding
 * commits; `SlackChannelBindingStore.createBinding` is idempotent, so
 * only one binding wins — the loser's workbench channel is orphaned
 * (unbound, but harmless) rather than corrupting the binding record.
 * Closing that race is future work, not a v1 requirement.
 */
import type {
  CreateSlackChannelBindingInput,
  SlackChannelBinding,
  SlackChannelBindingStore,
} from "./store";

export type ProvisionChannel = (input: {
  readonly tenantId: string;
  readonly name: string;
  readonly creatorPrincipalId: string;
}) => Promise<{ readonly channelId: string }>;

export type ResolveOrCreateChannelBindingDeps = {
  readonly bindings: SlackChannelBindingStore;
  readonly provisionChannel: ProvisionChannel;
};

export type ResolveOrCreateChannelBindingInput = {
  readonly tenantId: string;
  readonly slackChannelId: string;
  readonly slackChannelName: string;
  readonly principalId: string;
};

export async function resolveOrCreateChannelBinding(
  deps: ResolveOrCreateChannelBindingDeps,
  input: ResolveOrCreateChannelBindingInput,
): Promise<SlackChannelBinding> {
  const existing = await deps.bindings.getBinding(
    input.tenantId,
    input.slackChannelId,
  );
  if (existing !== undefined) return existing;

  const provisioned = await deps.provisionChannel({
    tenantId: input.tenantId,
    name: input.slackChannelName,
    creatorPrincipalId: input.principalId,
  });

  const binding: CreateSlackChannelBindingInput = {
    tenantId: input.tenantId,
    slackChannelId: input.slackChannelId,
    channelId: provisioned.channelId,
  };
  return deps.bindings.createBinding(binding);
}

/**
 * Recovers the Slack channel id from a Chat SDK Slack thread id
 * (`${channelId}:${ts}`, e.g. `"C1:1721800000.000100"` — see
 * `corbits-tag/slack`'s wire layer). `TagEvent.threadId` carries no
 * separate channel-id field, so this is the one place `@corbits/slack-tag`
 * is coupled to that documented wire format. Returns `undefined` for a
 * thread id with no separator — a malformed or foreign id must never
 * be silently mistaken for a valid channel.
 */
export function slackChannelIdFromThreadId(
  threadId: string,
): string | undefined {
  const separatorIndex = threadId.indexOf(":");
  if (separatorIndex <= 0) return undefined;
  return threadId.slice(0, separatorIndex);
}
