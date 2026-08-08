// Channel-level orchestration that sits above the platform port:
// joining an agent into a channel (shared by chat creation and
// `POST .../invite`), and sending a message with its full mention
// fan-out — recipient resolution, prior-context loading, and the
// per-recipient delivery loop. Each depends only on the platform/store
// seams it actually calls, not the full `ChatPlatform`/`ChatStore`.
import { getLogger } from "@intx/log";
import { decodeMail, encodeParts, senderOf } from "./codec";
import type { Part as PartType } from "./parts";
import { localPartOf } from "./agent-address";
import { isAgentAddress, mentionedParticipants } from "./mentions";
import {
  mergeContextIntoParts,
  renderChannelContext,
  type ChannelContextItem,
} from "./channel-context";
import {
  addParticipant,
  handleFromName,
  type ParticipantRecord,
} from "./participants";
import {
  contextWindowOf,
  DEFAULT_CONTEXT_WINDOW,
  kindOf,
  participantsOf,
} from "./channel-settings";
import type {
  ChannelLauncher,
  ChannelMail,
  ChatChannelEvent,
} from "./platform-port";
import type { ChatStore } from "./store";

const contextLog = getLogger(["chat", "context"]);

export type LaunchAndJoinAgentDeps = {
  readonly store: Pick<ChatStore, "updateChannelSettings">;
  readonly platform: ChannelLauncher & Pick<ChannelMail, "sendMail">;
  readonly publish: (channelId: string, event: ChatChannelEvent) => void;
};

export type LaunchAndJoinAgentInput = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly channelId: string;
  readonly definitionId: string;
  readonly existingSettings: Record<string, unknown>;
};

export type LaunchAndJoinAgentResult = {
  readonly address: string;
  readonly definitionId: string;
  readonly handle: string;
  readonly settings: Record<string, unknown>;
};

/**
 * The invite core: launches the definition's own instance, derives
 * its friendly mention handle, appends the participant record, posts
 * the join event onto the channel's timeline, and arms the reply
 * bridge. Shared by `POST .../invite` and chat creation (a chat's
 * single agent is invited exactly this way, at creation) so the two
 * paths can never drift.
 */
export async function launchAndJoinAgent(
  deps: LaunchAndJoinAgentDeps,
  input: LaunchAndJoinAgentInput,
): Promise<LaunchAndJoinAgentResult> {
  const launched = await deps.platform.launchInvite({
    tenantId: input.tenantId,
    creatorPrincipalId: input.principalId,
    definitionId: input.definitionId,
  });

  // The invited definition's name becomes the friendly mention handle
  // (e.g. "echo" for a definition named "Echo"), rather than the
  // invited run's own unusable instance-id local part; a definition
  // the listing no longer carries falls back to that local part.
  // Either way it is de-duplicated against every handle already in
  // the channel ("echo", "echo-2", ...).
  const invitable = await deps.platform.listInvitableDefinitions(
    input.tenantId,
  );
  const invitedDefinition = invitable.find(
    (definition) => definition.id === input.definitionId,
  );
  const desiredHandle =
    invitedDefinition !== undefined
      ? handleFromName(invitedDefinition.name, launched.address)
      : localPartOf(launched.address);

  // The record is updated before the join event is posted, matching
  // the settings PATCH route's record-then-mail ordering: the
  // participant list is the durable source of truth, so a failure
  // below never leaves it unwritten.
  const participants = participantsOf(input.existingSettings);
  const row = await deps.store.updateChannelSettings({
    tenantId: input.tenantId,
    channelId: input.channelId,
    settings: {
      ...input.existingSettings,
      "chat/participants": addParticipant(
        participants,
        launched.address,
        desiredHandle,
      ),
    },
    updatedBy: input.principalId,
  });

  const joinEvent: PartType = {
    kind: "event",
    event: "channel.agent-joined",
    data: {
      address: launched.address,
      definitionId: input.definitionId,
      invitedBy: input.principalId,
    },
  };
  await deps.platform.sendMail({
    tenantId: input.tenantId,
    channelId: input.channelId,
    principalId: input.principalId,
    content: encodeParts([joinEvent]),
  });

  deps.publish(input.channelId, {
    type: "chat.settings",
    data: { updatedBy: input.principalId, settings: row.settings },
  });

  return {
    address: launched.address,
    definitionId: input.definitionId,
    handle: desiredHandle,
    settings: row.settings,
  };
}

/**
 * The label a sender renders as inside a channel context block: an
 * agent participant renders as its channel handle (`@echo`), matching
 * the mention syntax participants already type; anything else — the
 * server has no human display names to draw on — renders as the
 * literal string `"user"`. Never a raw address or principal id: this
 * text reaches a model prompt and possibly logs.
 */
function labelForSender(
  address: string,
  participants: readonly ParticipantRecord[],
): string {
  // Mail's `from` always carries a full `id@domain` address regardless
  // of sender kind (see `platform-adapter.ts`'s `sendMail`), so an
  // agent sender is recognized by matching its local part against a
  // known *agent* participant's local part — never by the mere
  // presence of "@", which every mail sender address carries either
  // way.
  const known = participants.find(
    (participant) =>
      isAgentAddress(participant.address) &&
      localPartOf(participant.address) === localPartOf(address),
  );
  return known !== undefined ? `@${known.handle}` : "user";
}

/**
 * Loads and decodes the channel's recent timeline into context items
 * for a mention fan-out copy, excluding the just-sent message (matched
 * by mail id, since it is typically the newest item in the listing)
 * and any decoded message with no text parts (event-only mail
 * contributes nothing a context block can render). Capped to the
 * channel's resolved `contextWindow` (most-recent-first before the
 * final oldest-first slice, so a window of 0 loads nothing and a small
 * window keeps only the newest few). Returns `undefined` on empty
 * history — the "zero context" case, where a fan-out copy carries no
 * context part at all — or when the timeline fails to load or decode:
 * that failure must never break the send, so it is logged and
 * swallowed here, leaving the caller to fan out un-situated.
 */
async function loadChannelContext(input: {
  platform: Pick<ChannelMail, "listMail" | "fetchBlob">;
  tenantId: string;
  channelId: string;
  excludeMailId: string;
  participants: readonly ParticipantRecord[];
  contextWindow: number;
}): Promise<string | undefined> {
  if (input.contextWindow === 0) return undefined;
  try {
    const listed = await input.platform.listMail({
      tenantId: input.tenantId,
      channelId: input.channelId,
    });
    const newestFirstExcludingSent = listed.items.filter(
      (item) => item.id !== input.excludeMailId,
    );
    const oldestFirst = newestFirstExcludingSent
      .slice(0, input.contextWindow)
      .reverse();

    const items: ChannelContextItem[] = [];
    for (const item of oldestFirst) {
      const parts = await decodeMail(item.mail, {
        fetchBlob: (blobId) =>
          input.platform.fetchBlob(input.channelId, blobId),
      });
      const texts = parts
        .filter(
          (part): part is Extract<PartType, { kind: "text" }> =>
            part.kind === "text",
        )
        .map((part) => part.text);
      if (texts.length === 0) continue;
      const sender = senderOf(item.mail);
      items.push({
        label: labelForSender(sender.address, input.participants),
        text: texts.join(" "),
      });
    }

    if (items.length === 0) return undefined;
    return renderChannelContext({ items });
  } catch (err) {
    contextLog.warn`failed to load channel context for mention fan-out on channel ${input.channelId}: ${
      err instanceof Error ? err.message : String(err)
    }`;
    return undefined;
  }
}

export type SendChannelMessageDeps = {
  readonly store: Pick<ChatStore, "getChannelSettings">;
  readonly platform: Pick<ChannelMail, "sendMail" | "listMail" | "fetchBlob">;
};

export type SendChannelMessageInput = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly channelId: string;
  readonly messageParts: PartType[];
};

export type SendChannelMessageResult = {
  readonly id: string;
  readonly createdAt: string;
};

/**
 * Sends a message into a channel and fans it out to every recipient
 * its kind and mentions resolve to: a chat delivers to its one agent
 * unconditionally, no @mention required (its agent is chosen at
 * creation, fixed for the chat's lifetime); a channel (or anything
 * else) keeps the mention-only fan-out. Never hardcoded to "one agent"
 * even for a chat — a chat has exactly one by construction, but this
 * still iterates every agent participant the settings carry.
 */
export async function sendChannelMessage(
  deps: SendChannelMessageDeps,
  input: SendChannelMessageInput,
): Promise<SendChannelMessageResult> {
  const sent = await deps.platform.sendMail({
    tenantId: input.tenantId,
    channelId: input.channelId,
    principalId: input.principalId,
    content: encodeParts(input.messageParts),
  });

  const settingsRow = await deps.store.getChannelSettings(
    input.tenantId,
    input.channelId,
  );
  const participants =
    settingsRow !== undefined ? participantsOf(settingsRow.settings) : [];
  const kind =
    settingsRow !== undefined ? kindOf(settingsRow.settings) : "chat";
  const recipients =
    kind === "chat"
      ? participants
          .filter((participant) => isAgentAddress(participant.address))
          .map((participant) => participant.address)
      : mentionedParticipants(input.messageParts, participants);

  // Situates a mentioned agent in the conversation it is being dropped
  // into — a chat's one agent already receives every message and has
  // full history via its own mailbox, so this only applies to a
  // channel's mention fan-out.
  const contextText =
    kind === "channel" && recipients.length > 0
      ? await loadChannelContext({
          platform: deps.platform,
          tenantId: input.tenantId,
          channelId: input.channelId,
          excludeMailId: sent.id,
          participants,
          contextWindow:
            settingsRow !== undefined
              ? contextWindowOf(settingsRow.settings)
              : DEFAULT_CONTEXT_WINDOW,
        })
      : undefined;
  const fanoutParts =
    contextText !== undefined
      ? (mergeContextIntoParts(contextText, input.messageParts) as PartType[])
      : input.messageParts;

  for (const participant of recipients) {
    // The chat orchestrator (built once by the host, subscribed to the
    // sidecar's own event stream) is what turns this participant's
    // eventual `connector.reply` back into a channel message — no
    // per-delivery arming needed here anymore.
    await deps.platform.sendMail({
      tenantId: input.tenantId,
      channelId: localPartOf(participant),
      principalId: input.principalId,
      content: encodeParts(fanoutParts, { replyTo: input.channelId }),
      fromChannelId: input.channelId,
    });
  }

  return sent;
}
