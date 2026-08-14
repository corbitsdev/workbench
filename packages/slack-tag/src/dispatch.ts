/**
 * `mountWorkbenchSlack` — workbench's Slack mount composition.
 *
 * Wires `corbits-tag/slack`'s `mountSlackTag` together with this
 * package's principal resolver (`./principal-resolver.ts`) and channel
 * binding (`./channel-binding.ts`) into one dispatch flow:
 *
 *   1. A Slack mention or thread message arrives; `corbits-tag/slack`
 *      verifies the request signature and normalizes it to a `TagEvent`.
 *   2. The author resolves to an Interchange principal (auto-provisioned
 *      on first contact — see `./principal-resolver.ts`).
 *   3. The Slack channel resolves-or-creates its bound workbench channel
 *      (`./channel-binding.ts`) — the channel host and its agent are
 *      launched by `deps.provisionChannel`, injected from the host's own
 *      `@corbits/chat` composition, never reimplemented here.
 *   4. The message is posted into that channel through `deps.sendMessage`
 *      — the SAME path a human's message from the web UI takes
 *      (`sendChannelMessage` in `packages/chat/src/channel-service.ts`).
 *      The channel's existing agent host generates the reply; this
 *      package never deploys or drives inference itself.
 *   5. The reply is relayed back to Slack via `thread.post` once it
 *      lands on the channel's event stream (`./reply-wait.ts`), or the
 *      thinking-indicator placeholder is left in place to be retracted
 *      by `corbits-tag/slack` if no reply lands within the wait window.
 *
 * Security posture, unchanged from `corbits-tag/slack`: this route mounts
 * OUTSIDE the host's session auth — Slack is not a principal. Signature
 * verification (`SLACK_SIGNING_SECRET`) is the only thing authenticated
 * before this dispatch runs; everything past that is this package's
 * policy, starting with principal resolution.
 */
import type { Hono } from "hono";
import {
  mountSlackTag,
  type MountedSlackTag,
  type TagEvent,
  type TagThread,
} from "corbits-tag/slack";
import {
  UNRESOLVED_MESSAGE,
  type AuthorLookup,
  type PrincipalResolver,
} from "corbits-tag/interchange";
import type { StateAdapter } from "chat";
import { getLogger } from "@intx/log";

import { parseSlackCredentials } from "./config";
import {
  resolveOrCreateChannelBinding,
  slackChannelIdFromThreadId,
  type ProvisionChannel,
} from "./channel-binding";
import type { SlackChannelBindingStore } from "./store";
import { waitForReply, type SubscribeToChannel } from "./reply-wait";
import {
  createSlackChannelNameResolver,
  type ResolveSlackChannelName,
} from "./slack-channel-name";

const log = getLogger(["slack-tag", "dispatch"]);

const DEFAULT_BOT_NAME = "workbench";
const DEFAULT_REPLY_WAIT_MS = 60_000;

/**
 * Belt-and-suspenders against a DM ever reaching dispatch: the manifest no
 * longer requests `im:history`/`mpim:history` or subscribes to
 * `message.im`/`message.mpim` (channel trust is the whole authz model here,
 * and a DM has no bench owner who chose to install the app there), but a
 * misconfigured Slack app or a stale event from Slack must not be trusted
 * to honor that. Slack channel ids are typed by their leading letter — `D`
 * is always a direct message.
 */
const DM_DECLINED_MESSAGE =
  "I only work in channels the bench owner has added me to — DMs aren't supported.";

function isDirectMessageChannel(slackChannelId: string): boolean {
  return slackChannelId.startsWith("D");
}

export type SendMessage = (input: {
  readonly tenantId: string;
  readonly channelId: string;
  readonly principalId: string;
  readonly text: string;
}) => Promise<{ readonly id: string }>;

export type MountWorkbenchSlackDeps = {
  /** The workbench tenant (bench) this Slack app's messages land in. One
   * Slack app install maps to exactly one tenant — see `./schema.ts`'s
   * header comment on why that is also the tenant-isolation boundary. */
  readonly tenantId: string;
  readonly slack: { readonly botToken: string; readonly signingSecret: string };
  readonly botName?: string;
  /** Chat SDK state backend (subscriptions/dedup/locks) — see
   * `./thread-state.ts`'s `resolveThreadState` for the
   * connect-or-fall-back helper hosts are expected to call before
   * passing this in. */
  readonly state: StateAdapter;
  readonly bindings: SlackChannelBindingStore;
  /** Resolves a Slack author to an auto-provisioned Interchange
   * principal — build with `createAutoProvisionPrincipalResolver`. */
  readonly resolvePrincipal: PrincipalResolver;
  /** The host's real channel-creation path (tenancy mint + host launch +
   * agent join) — never reimplemented in this package. */
  readonly provisionChannel: ProvisionChannel;
  /** Posts a message into a channel through the existing chat platform —
   * the same path a human's web-UI message takes. */
  readonly sendMessage: SendMessage;
  /** Subscribes to a channel's live event stream — the same seam
   * `packages/chat/src/channel-events.ts`'s SSE bridge uses. */
  readonly subscribeToChannel: SubscribeToChannel;
  /** How long to wait for the agent's reply before leaving the
   * thinking-indicator placeholder for `corbits-tag/slack` to retract.
   * Default 60s. */
  readonly replyWaitMs?: number;
  readonly path?: string;
  /** Titles a freshly provisioned channel after the Slack channel's
   * display name. Defaults to `createSlackChannelNameResolver(deps.slack.botToken)`;
   * inject a fake in tests rather than mocking `fetch`. */
  readonly resolveChannelName?: ResolveSlackChannelName;
};

/**
 * The Slack `TagAuthor` shape carries every field `corbits-tag/interchange`'s
 * `AuthorIdentity` needs (`userId`, `email`, `emailVerified`, `isRestricted`,
 * `isBot`) — see `corbits-tag/interchange`'s own `principal.ts` doc comment.
 * `email` is merely optional (`email?: string`) on `TagAuthor` where
 * `AuthorIdentity` requires the key present (`string | undefined`), so this
 * copies the fields across explicitly rather than passing `event.author`
 * through as-is.
 */
function authorIdentityFrom(author: TagEvent["author"]): AuthorLookup {
  return {
    userId: author.userId,
    email: author.email,
    emailVerified: author.emailVerified,
    isRestricted: author.isRestricted,
    isBot: author.isBot,
  };
}

export async function dispatchWorkbenchSlackEvent(
  deps: MountWorkbenchSlackDeps,
  event: TagEvent,
  thread: TagThread,
): Promise<void> {
  const slackChannelId = slackChannelIdFromThreadId(event.threadId);
  if (slackChannelId === undefined) {
    log.error(
      "Could not recover a Slack channel id from thread id {threadId}",
      { threadId: event.threadId },
    );
    return;
  }
  if (isDirectMessageChannel(slackChannelId)) {
    await thread.post(DM_DECLINED_MESSAGE);
    return;
  }

  const resolution = await deps.resolvePrincipal(
    authorIdentityFrom(event.author),
  );
  if (!resolution.ok) {
    await thread.post(UNRESOLVED_MESSAGE[resolution.reason]);
    return;
  }

  const existingBinding = await deps.bindings.getBinding(
    deps.tenantId,
    slackChannelId,
  );
  const slackChannelName =
    existingBinding !== undefined
      ? slackChannelId
      : await (
          deps.resolveChannelName ??
          createSlackChannelNameResolver(deps.slack.botToken)
        )(slackChannelId);

  const binding = await resolveOrCreateChannelBinding(
    { bindings: deps.bindings, provisionChannel: deps.provisionChannel },
    {
      tenantId: deps.tenantId,
      slackChannelId,
      slackChannelName,
      principalId: resolution.principal.principalId,
    },
  );

  await thread.subscribe();

  const replyWaitMs = deps.replyWaitMs ?? DEFAULT_REPLY_WAIT_MS;
  const pendingReply = waitForReply(
    deps.subscribeToChannel,
    binding.channelId,
    replyWaitMs,
  );

  await deps.sendMessage({
    tenantId: deps.tenantId,
    channelId: binding.channelId,
    principalId: resolution.principal.principalId,
    text: event.text,
  });

  const reply = await pendingReply;
  if (reply !== undefined) {
    await thread.post(reply);
  }
}

export function mountWorkbenchSlack(
  app: Hono,
  deps: MountWorkbenchSlackDeps,
): MountedSlackTag {
  const credentials = parseSlackCredentials(deps.slack);

  return mountSlackTag(app, {
    userName: deps.botName ?? DEFAULT_BOT_NAME,
    state: deps.state,
    slack: credentials,
    ...(deps.path !== undefined ? { path: deps.path } : {}),
    thinkingIndicator: true,
    onTag: (event, thread) => dispatchWorkbenchSlackEvent(deps, event, thread),
    onThreadMessage: (event, thread) =>
      dispatchWorkbenchSlackEvent(deps, event, thread),
  });
}
