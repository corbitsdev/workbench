// Default Myra chat: the product land surface. Find an existing Myra-titled
// row (chat or, for a bench seeded before CL-5985, legacy channel kind) or
// create a 1:1 chat against Myra's deployed agent definition. Pure helpers
// stay free of React so they unit-test without a DOM.

import { createChannel, listChannels, type Channel } from "@corbits/chat-ui";
import { WORKFLOW_CATALOG } from "@corbits/workflow-catalog";

import { listAgentDefinitions, type AgentDefinition } from "./agents-api";

export const MYRA_CHANNEL_TITLE = "Myra";

/** The seeded workflow asset backing Myra (`packages/hub-client/src/seed.ts`
 * deploys it as `assistant`, stamped with catalog displayName "Myra"). A
 * chat's `definitionId` names this deployed definition's row id, never the
 * asset name itself. */
const MYRA_ASSET_NAME = WORKFLOW_CATALOG.find(
  (entry) => entry.displayName === MYRA_CHANNEL_TITLE,
)?.assetName;

export type EnsureMyraChannelResult =
  | { readonly kind: "ready"; readonly channelId: string }
  | { readonly kind: "error"; readonly message: string };

export function isMyraChannelTitle(title: string): boolean {
  return title.trim().toLowerCase() === MYRA_CHANNEL_TITLE.toLowerCase();
}

/** The last channel id `ensureMyraChannel` resolved to, for the shell's
 * col2-wide derivation (CL-5936): "Myra is the active surface" reduces to
 * "the open channel is the one Talk-to-Myra last landed us on". Module-level
 * because the shell needs it synchronously from `path` alone, with no
 * channel-title fetch of its own. */
let cachedMyraChannelId: string | null = null;

export function isMyraChannelId(channelId: string | null): boolean {
  return channelId !== null && channelId === cachedMyraChannelId;
}

/** Test helper — drop the cached id between cases. */
export function resetMyraChannelCache(): void {
  cachedMyraChannelId = null;
}

/** Prefer an exact Myra title; first match wins across the given list. */
export function findMyraChannel(
  channels: readonly Channel[],
): Channel | undefined {
  return channels.find((channel) => isMyraChannelTitle(channel.title));
}

/** Myra's deployed agent definition, matched by the seeded `assistant`
 * asset name — never by display name, which is a UI label, not a wire
 * identifier. */
export function findMyraDefinition(
  definitions: readonly AgentDefinition[],
): AgentDefinition | undefined {
  if (MYRA_ASSET_NAME === undefined) return undefined;
  return definitions.find((definition) => definition.name === MYRA_ASSET_NAME);
}

/**
 * List channel + chat kinds, reuse a Myra-titled row if one exists — a
 * legacy channel-kind Myra from a bench seeded before CL-5985 included, so
 * no bench ever ends up with two — otherwise create a 1:1 chat against
 * Myra's deployed agent definition.
 */
export async function ensureMyraChannel(
  tenantId: string,
): Promise<EnsureMyraChannelResult> {
  try {
    const [channels, chats] = await Promise.all([
      listChannels(tenantId, "channel"),
      listChannels(tenantId, "chat"),
    ]);
    const existing = findMyraChannel(channels) ?? findMyraChannel(chats);
    if (existing !== undefined) {
      cachedMyraChannelId = existing.id;
      return { kind: "ready", channelId: existing.id };
    }
    const definitions = await listAgentDefinitions(tenantId);
    const definition = findMyraDefinition(definitions);
    if (definition === undefined) {
      return {
        kind: "error",
        message: `No deployed "${MYRA_CHANNEL_TITLE}" agent definition found for this workbench.`,
      };
    }
    const created = await createChannel(tenantId, {
      kind: "chat",
      definitionId: definition.id,
      name: MYRA_CHANNEL_TITLE,
    });
    cachedMyraChannelId = created.id;
    return { kind: "ready", channelId: created.id };
  } catch (cause) {
    return {
      kind: "error",
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
