// The one path from "an agent's definitionId" to "the person is in a
// fresh chat with it" — the same `POST /channels` call this app's every
// create path uses. `CreateAgentPanel`'s Settings → Agents entry point
// calls this on success so an explicitly-defined new agent never ends
// nowhere, and `instant-agent-create.ts` — THE one creation verb
// (CL-6138) — calls it against the account's default setup template.
// Always creates (CL-6089) — never the `reuseExisting` land-hop path,
// which is `default-agent-channel.ts`'s own call, not this one.

import { createChannel } from "@corbits/chat-ui";

import { channelPath } from "./channel-path";

export async function launchAgentChat(
  tenantId: string,
  definitionId: string,
  navigate: (to: string) => void,
  name?: string,
): Promise<void> {
  const channel = await createChannel(tenantId, {
    kind: "chat",
    definitionId,
    ...(name !== undefined ? { name } : {}),
  });
  navigate(channelPath(channel.id));
}
