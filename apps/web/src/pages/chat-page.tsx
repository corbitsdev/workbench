// Channel surface for the main stage. `/c` and `/c/:channelId` (plus legacy
// `/chat` prefixes) render the conversation here — not in the canvas.
// Canvas stays auxiliary (profiles and similar) and opens on demand from
// this workspace.

import { ChatWorkspace } from "@corbits/chat-ui";

import { useBench } from "../bench-context";
import {
  channelIdFromPath,
  channelPath,
  channelSettingsPath,
  isChannelSettingsPath,
} from "../channel-path";
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
  const settingsOpen = isChannelSettingsPath(path);
  const openProfile = useOpenProfileInCanvas();
  const tenant = tenantResolutionFromBench(bench);
  const principalId = bench.selectedPrincipalId ?? undefined;

  // A chat file part only carries a blob id today — Library artifacts have
  // no stored link back to it, so the chip can only send the reader to the
  // Library at large. A real per-artifact deep link (and opening in canvas
  // rather than navigating away) is follow-up work once that link exists.
  function openArtifact() {
    navigate("/library");
  }

  return (
    <ChatWorkspace
      tenant={tenant}
      {...(principalId !== undefined ? { currentUser: { principalId } } : {})}
      channelId={channelId}
      onChannelChange={(nextChannelId) => navigate(channelPath(nextChannelId))}
      onOpenProfile={openProfile}
      settingsOpen={settingsOpen}
      onSettingsOpenChange={(open) => {
        if (channelId === null) return;
        navigate(
          open ? channelSettingsPath(channelId) : channelPath(channelId),
        );
      }}
      onOpenArtifact={openArtifact}
    />
  );
}
