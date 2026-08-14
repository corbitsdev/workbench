// Find-or-create a bench's 1:1 with a given deployed agent, generalizing
// `apps/web/src/myra-channel.ts`'s original Myra-specific resolution: list
// channel + chat kinds, reuse a chat-kind title match if one exists,
// otherwise create a chat against the agent's deployed definition. The
// agent's title and deployed asset name are config an app supplies — this
// module carries no product literal of its own.
//
// A legacy channel-kind title match still carrying the agent is converted
// to a chat in place (one `chat/kind` settings patch): an agent chat must
// always auto-respond, and only `kind === "chat"` gets the unconditional
// fan-out in `sendChannelMessage` — reusing the row as a channel left the
// agent mention-gated and silent. A channel-kind match with no agent
// participant is a husk that can't answer under either kind, so it is
// left alone and the real chat is created.

import { isAgentAddress } from "@corbits/chat/mentions";

import {
  createChannel,
  listChannels,
  patchChannelSettings,
  type Channel,
} from "./api";

export type DefaultAgentChannelConfig = {
  readonly title: string;
  readonly assetName: string | undefined;
};

export type EnsureDefaultAgentChannelResult =
  | { readonly kind: "ready"; readonly channelId: string }
  | { readonly kind: "error"; readonly message: string };

export function isChannelTitleMatch(title: string, target: string): boolean {
  return title.trim().toLowerCase() === target.trim().toLowerCase();
}

export function findChannelByTitle(
  channels: readonly Channel[],
  title: string,
): Channel | undefined {
  return channels.find((channel) => isChannelTitleMatch(channel.title, title));
}

/** An agent definition matched by its deployed asset name — never by
 * display name, which is a UI label, not a wire identifier. */
export function findDefinitionByAssetName<D extends { readonly name: string }>(
  definitions: readonly D[],
  assetName: string | undefined,
): D | undefined {
  if (assetName === undefined) return undefined;
  return definitions.find((definition) => definition.name === assetName);
}

/**
 * A bound handle over one configured agent: `ensure` resolves or creates
 * its channel, and the cached id lets a caller answer "is this the
 * default agent's channel?" synchronously from an id alone, with no
 * channel-title fetch of its own.
 */
export function createDefaultAgentChannel(config: DefaultAgentChannelConfig) {
  let cachedChannelId: string | null = null;

  function isCachedChannelId(channelId: string | null): boolean {
    return channelId !== null && channelId === cachedChannelId;
  }

  function resetCache(): void {
    cachedChannelId = null;
  }

  function findByTitle(channels: readonly Channel[]): Channel | undefined {
    return findChannelByTitle(channels, config.title);
  }

  async function ensure<
    D extends { readonly id: string; readonly name: string },
  >(
    tenantId: string,
    listDefinitions: (tenantId: string) => Promise<readonly D[]>,
  ): Promise<EnsureDefaultAgentChannelResult> {
    try {
      const [channels, chats] = await Promise.all([
        listChannels(tenantId, "channel"),
        listChannels(tenantId, "chat"),
      ]);
      const existingChat = findByTitle(chats);
      if (existingChat !== undefined) {
        cachedChannelId = existingChat.id;
        return { kind: "ready", channelId: existingChat.id };
      }
      const legacy = findByTitle(channels);
      if (
        legacy !== undefined &&
        legacy.participants.some((participant) =>
          isAgentAddress(participant.address),
        )
      ) {
        await patchChannelSettings(tenantId, legacy.id, {
          "chat/kind": "chat",
        });
        cachedChannelId = legacy.id;
        return { kind: "ready", channelId: legacy.id };
      }
      const definitions = await listDefinitions(tenantId);
      const definition = findDefinitionByAssetName(
        definitions,
        config.assetName,
      );
      if (definition === undefined) {
        return {
          kind: "error",
          message: `No "${config.title}" agent found for this workbench.`,
        };
      }
      const created = await createChannel(tenantId, {
        kind: "chat",
        definitionId: definition.id,
        name: config.title,
      });
      cachedChannelId = created.id;
      return { kind: "ready", channelId: created.id };
    } catch (cause) {
      return {
        kind: "error",
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }

  return {
    ensure,
    isCachedChannelId,
    resetCache,
    findChannelByTitle: findByTitle,
  };
}

export type DefaultAgentChannel = ReturnType<typeof createDefaultAgentChannel>;
