/**
 * Resolves a Slack channel id to its display name via Slack's Web API
 * `conversations.info`, so a freshly provisioned workbench channel can
 * be titled after the Slack channel it is bound to. `TagEvent` carries
 * no channel-name field (see `./channel-binding.ts`'s doc comment on
 * `threadId`), so this is a small, direct Slack Web API call rather
 * than something `corbits-tag/slack` already surfaces.
 *
 * Fails soft: a lookup failure (rate limit, missing scope, network
 * error) falls back to the raw Slack channel id rather than blocking
 * channel provisioning on a cosmetic title.
 */
import { getLogger } from "@intx/log";

const log = getLogger(["slack-tag", "channel-name"]);

const CONVERSATIONS_INFO_URL = "https://slack.com/api/conversations.info";

export type ResolveSlackChannelName = (
  slackChannelId: string,
) => Promise<string>;

export function createSlackChannelNameResolver(
  botToken: string,
): ResolveSlackChannelName {
  return async (slackChannelId) => {
    try {
      const url = new URL(CONVERSATIONS_INFO_URL);
      url.searchParams.set("channel", slackChannelId);
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${botToken}` },
      });
      const body: unknown = await response.json();
      const name = (body as { ok?: boolean; channel?: { name?: string } })
        .channel?.name;
      if (
        (body as { ok?: boolean }).ok !== true ||
        typeof name !== "string" ||
        name === ""
      ) {
        log.warn("conversations.info returned no usable name for {channel}", {
          channel: slackChannelId,
        });
        return slackChannelId;
      }
      return name;
    } catch (cause) {
      log.warn("conversations.info lookup failed for {channel}: {error}", {
        channel: slackChannelId,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      return slackChannelId;
    }
  };
}
