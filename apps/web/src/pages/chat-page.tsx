// Channel surface for the main pane. On an expanded layout the canvas
// column hosts the same `ChatWorkspace` and this page is a short pointer
// so the main pane isn't empty under a deep link. On compact/narrow the
// canvas is gone, so this page is the full conversation surface.
//
// Deep links use `/c/:channelId`; the legacy `/chat/:channelId` prefix is
// still parsed so old links keep working.

import { ChatWorkspace } from "@corbits/chat-ui";
import { EmptyState } from "@corbits/react-ui";
import { MessageSquare } from "lucide-react";

import { useBench } from "../bench-context";
import { channelIdFromPath, channelPath } from "../channel-path";
import { useCanvasColumnAvailable } from "../shell/canvas-availability";
import { tenantResolutionFromBench } from "../shell/tenant-resolution";

export function ChatPage({
  path,
  navigate,
}: {
  readonly path: string;
  readonly navigate: (to: string) => void;
}) {
  const canvasAvailable = useCanvasColumnAvailable();
  const bench = useBench();
  const channelId = channelIdFromPath(path);

  if (canvasAvailable) {
    return (
      <EmptyState
        icon={<MessageSquare />}
        title={channelId === null ? "Channels" : "Channel open"}
        description={
          channelId === null
            ? "Pick a channel from the panel — the conversation opens in the canvas on the right."
            : "The conversation is open in the canvas on the right. Close the canvas to free the space, or pick another channel from the panel."
        }
      />
    );
  }

  const tenant = tenantResolutionFromBench(bench);
  const principalId = bench.selectedPrincipalId ?? undefined;

  return (
    <ChatWorkspace
      tenant={tenant}
      {...(principalId !== undefined ? { currentUser: { principalId } } : {})}
      channelId={channelId}
      onChannelChange={(nextChannelId) => navigate(channelPath(nextChannelId))}
    />
  );
}
