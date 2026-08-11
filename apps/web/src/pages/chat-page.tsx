// Channel surface for the main stage. `/c` and `/c/:channelId` (plus legacy
// `/chat` prefixes) render the conversation here — not in the canvas.
// Canvas stays auxiliary (profiles and similar) and opens on demand from
// this workspace.

import { ChatWorkspace } from "@corbits/chat-ui";

import { useBench } from "../bench-context";
import { channelIdFromPath, channelPath } from "../channel-path";
import { useOpenProfileInCanvas } from "../shell/canvas-availability";
import { tenantResolutionFromBench } from "../shell/tenant-resolution";

export function ChatPage({
  path,
  navigate,
}: {
  readonly path: string;
  readonly navigate: (to: string) => void;
}) {
  const bench = useBench();
  const channelId = channelIdFromPath(path);
  const openProfile = useOpenProfileInCanvas();
  const tenant = tenantResolutionFromBench(bench);
  const principalId = bench.selectedPrincipalId ?? undefined;

  return (
    <ChatWorkspace
      tenant={tenant}
      {...(principalId !== undefined ? { currentUser: { principalId } } : {})}
      channelId={channelId}
      onChannelChange={(nextChannelId) => navigate(channelPath(nextChannelId))}
      onOpenProfile={openProfile}
    />
  );
}
