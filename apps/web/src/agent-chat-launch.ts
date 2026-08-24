// The one path from "an agent's definitionId" to "the person is in a
// chat with it" — `openAgentConversation` find-or-reopens the agent's
// one conversation (CL-6981). `CreateAgentPanel`'s Settings → Agents
// entry point calls this on success so an explicitly-defined new agent
// never ends nowhere, and `instant-agent-create.ts` — THE one creation
// verb (CL-6138) — calls against the account's default setup template
// through `createWorkbench` with template fields, not this hop.

import { createWorkbench, openAgentConversation } from "@corbits/chat-ui";

import { workbenchPath } from "./workbench-path";

export async function launchAgentChat(
  tenantId: string,
  definitionId: string,
  navigate: (to: string) => void,
  name?: string,
): Promise<void> {
  const workbench =
    name === undefined
      ? await openAgentConversation(tenantId, definitionId)
      : await createWorkbench(tenantId, {
          kind: "chat",
          definitionId,
          name,
        });
  navigate(workbenchPath(workbench.id));
}
