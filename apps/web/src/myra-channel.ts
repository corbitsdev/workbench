// Default Myra chat: the product land surface. Composition only — the
// find-or-create logic itself is `@corbits/chat-ui`'s generic
// `createDefaultAgentChannel`; this file's job is to name Myra as the
// configured agent and wire it to this app's agent-definitions fetch.

import {
  createDefaultAgentChannel,
  findChannelByTitle,
  findDefinitionByAssetName,
  isChannelTitleMatch,
  type Channel,
} from "@corbits/chat-ui";
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

export type { EnsureDefaultAgentChannelResult as EnsureMyraChannelResult } from "@corbits/chat-ui";

const myraChannel = createDefaultAgentChannel({
  title: MYRA_CHANNEL_TITLE,
  assetName: MYRA_ASSET_NAME,
});

export function isMyraChannelTitle(title: string): boolean {
  return isChannelTitleMatch(title, MYRA_CHANNEL_TITLE);
}

/** The last channel id `ensureMyraChannel` resolved to, for the shell's
 * col2-wide derivation (CL-5936): "Myra is the active surface" reduces to
 * "the open channel is the one Talk-to-Myra last landed us on". */
export function isMyraChannelId(channelId: string | null): boolean {
  return myraChannel.isCachedChannelId(channelId);
}

/** Test helper — drop the cached id between cases. */
export function resetMyraChannelCache(): void {
  myraChannel.resetCache();
}

/** Prefer an exact Myra title; first match wins across the given list. */
export function findMyraChannel(
  channels: readonly Channel[],
): Channel | undefined {
  return findChannelByTitle(channels, MYRA_CHANNEL_TITLE);
}

/** Myra's deployed agent definition, matched by the seeded `assistant`
 * asset name — never by display name, which is a UI label, not a wire
 * identifier. */
export function findMyraDefinition(
  definitions: readonly AgentDefinition[],
): AgentDefinition | undefined {
  return findDefinitionByAssetName(definitions, MYRA_ASSET_NAME);
}

/**
 * List channel + chat kinds, reuse a Myra-titled row if one exists — a
 * legacy channel-kind Myra from a bench seeded before CL-5985 included, so
 * no bench ever ends up with two — otherwise create a 1:1 chat against
 * Myra's deployed agent definition.
 */
export function ensureMyraChannel(tenantId: string) {
  return myraChannel.ensure(tenantId, listAgentDefinitions);
}
