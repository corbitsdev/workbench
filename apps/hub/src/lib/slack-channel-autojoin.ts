import { getLogger } from "@intx/log";
import type { SlackCredential } from "./slack-api-client";
import { joinChannel, listAllPublicChannels } from "./slack-api-client";

const log = getLogger(["lib", "slack-channel-autojoin"]);

export interface AutoJoinResult {
  attempted: number;
  joined: number;
  alreadyMember: number;
  failed: number;
}

/**
 * Join every public channel in the workspace. Meant to be invoked once when
 * the workspace owner enables the Slack inbox source (see the wiring
 * instructions for the one-line call from the enablement toggle) — private
 * channels are never auto-joined; they stay invite-only by design.
 *
 * Each channel is joined independently: one failure (e.g. a channel the bot
 * is somehow barred from) is logged and does not abort the sweep.
 */
export async function joinAllPublicChannels(
  credential: SlackCredential,
  signal: AbortSignal,
): Promise<AutoJoinResult> {
  const channels = await listAllPublicChannels(credential, signal);
  const result: AutoJoinResult = {
    attempted: channels.length,
    joined: 0,
    alreadyMember: 0,
    failed: 0,
  };

  for (const channel of channels) {
    if (channel.is_member) {
      result.alreadyMember += 1;
      continue;
    }
    try {
      await joinChannel(credential, channel.id, signal);
      result.joined += 1;
    } catch (err) {
      result.failed += 1;
      log.error("slack-channel-autojoin: failed to join channel", {
        channelId: channel.id,
        channelName: channel.name,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  log.info("slack-channel-autojoin: sweep complete", { ...result });
  return result;
}

/**
 * Auto-join a single newly created public channel (the `channel_created`
 * event). Private channels never fire this event with a joinable public
 * channel — Slack only emits `channel_created` for public channels.
 */
export async function joinNewlyCreatedChannel(
  credential: SlackCredential,
  channelId: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    await joinChannel(credential, channelId, signal);
  } catch (err) {
    log.error(
      "slack-channel-autojoin: failed to join a newly created channel",
      { channelId, error: err instanceof Error ? err : new Error(String(err)) },
    );
  }
}
