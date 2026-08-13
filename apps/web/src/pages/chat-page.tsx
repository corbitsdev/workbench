// Channel surface for the main stage. `/c` and `/c/:channelId` (plus legacy
// `/chat` prefixes) render the conversation here — not in the canvas.
// Canvas stays auxiliary (profiles and similar) and opens on demand from
// this workspace.

import { ChatWorkspace } from "@corbits/chat-ui";
import { useEffect } from "react";

import { useBench } from "../bench-context";
import { channelIdFromPath, channelPath } from "../channel-path";
import {
  consumePendingNewChannel,
  NEW_CHANNEL_EVENT,
} from "../command-palette-actions";
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

  // The command palette may have requested "New channel" from another
  // page, before ChatWorkspace's own listener existed to catch the
  // dispatch — see pending-dialog-request.ts. React commits child effects
  // before parent effects, so by the time this runs, ChatWorkspace (a
  // child of this component) has already registered its listener for
  // NEW_CHANNEL_EVENT — re-dispatching here is safe.
  useEffect(() => {
    if (consumePendingNewChannel()) {
      window.dispatchEvent(new CustomEvent(NEW_CHANNEL_EVENT));
    }
  }, []);

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
