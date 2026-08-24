// The one path from an agent definition's id to "the person is in their
// direct chat with it" (CL-6253) — the sidebar's agent rows are the one
// caller. Mirrors `agent-chat-launch.ts`'s shape exactly, through
// `openAgentConversation`: the first click mints the conversation, every
// later click finds the same workbench by `chat/definitionId`
// (`findExistingAgentChat` in `packages/chat/src/routes.ts`) instead of
// spawning a new one each time.

import { openAgentConversation } from "@corbits/chat-ui";

import { workbenchPath } from "./workbench-path";

export async function openAgentDmChat(
  tenantId: string,
  definitionId: string,
  navigate: (to: string) => void,
): Promise<void> {
  const workbench = await openAgentConversation(tenantId, definitionId);
  navigate(workbenchPath(workbench.id));
}
