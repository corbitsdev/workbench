// The one path from "just-created agent definition" to "the person is
// in a chat with it" (CL-6074) — the same `POST /channels` call, with
// the server's own find-or-create dedup (CL-6070), that picking an
// existing agent in the new-chat picker already goes through
// (`NewChannelDialog`'s agent tab → `ChatWorkspace.handleCreateChannel`).
// Both `CreateAgentPanel`'s entry points (Settings → Agents, and the
// new-chat picker's "New agent…" affordance) call this exact function on
// success, so a freshly created agent never ends nowhere.

import { createChannel } from "@corbits/chat-ui";

import { channelPath } from "./channel-path";

export async function launchAgentChat(
  tenantId: string,
  definitionId: string,
  navigate: (to: string) => void,
): Promise<void> {
  const channel = await createChannel(tenantId, {
    kind: "chat",
    definitionId,
  });
  navigate(channelPath(channel.id));
}
