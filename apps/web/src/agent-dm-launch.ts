// The one path from an agent definition's id to "the person is in their
// direct chat with it" (CL-6253) — the sidebar's agent rows are the one
// caller. Mirrors `agent-chat-launch.ts`'s shape exactly, but through
// `openAgentDm` (`kind: "chat"`, `reuseExisting: true`) rather than
// `createWorkbench` directly: the first click mints the DM, every later
// click finds the same workbench by `chat/definitionId`
// (`findExistingAgentChat` in `packages/chat/src/routes.ts`) instead of
// spawning a new one each time.

import { openAgentDm } from "@corbits/chat-ui";

import { workbenchPath } from "./workbench-path";

export async function openAgentDmChat(
  tenantId: string,
  definitionId: string,
  navigate: (to: string) => void,
): Promise<void> {
  const workbench = await openAgentDm(tenantId, definitionId);
  navigate(workbenchPath(workbench.id));
}
