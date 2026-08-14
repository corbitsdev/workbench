// Channel surface for the main stage. `/c` and `/c/:channelId` (plus legacy
// `/chat` prefixes) render the conversation here — not in the canvas.
// Canvas stays auxiliary (profiles and similar) and opens on demand from
// this workspace.

import { ChatWorkspace, fetchChannelBlob, type Part } from "@corbits/chat-ui";
import { listPrincipals } from "@corbits/settings-ui";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";

import { createChatApprovalActions } from "../approval-actions";
import { useBench } from "../bench-context";
import {
  artifactContentFromBlob,
  artifactContentFromBlobError,
} from "../chat-artifact-open";
import {
  channelIdFromPath,
  channelPath,
  channelSettingsPath,
  isChannelSettingsPath,
} from "../channel-path";
import {
  consumePendingNewChannel,
  NEW_CHANNEL_EVENT,
} from "../command-palette-actions";
import {
  useOpenArtifactInCanvas,
  useOpenProfileInCanvas,
} from "../shell/canvas-availability";
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
  const openArtifactInCanvas = useOpenArtifactInCanvas();
  const tenant = tenantResolutionFromBench(bench);
  const principalId = bench.selectedPrincipalId ?? undefined;
  const queryClient = useQueryClient();
  const tenantId = bench.selectedTenantId;
  const approvalActions = useMemo(
    () =>
      tenantId === null
        ? undefined
        : createChatApprovalActions(tenantId, queryClient),
    [tenantId, queryClient],
  );

  // The new-chat dialog's People tab: the same bench-membership listing
  // Settings → People renders from (`listPrincipals`), reduced to what a
  // counterpart picker needs and restricted to active human members — an
  // "agent" or "workflow" kind principal, or one that is suspended,
  // invited, or deactivated, is never a valid direct-chat counterpart
  // (the server's own `POST /channels` validation agrees; see
  // `packages/chat/src/routes.ts`).
  const listMembers = useCallback(async (memberTenantId: string) => {
    const principals = await listPrincipals(memberTenantId);
    return principals
      .filter((p) => p.kind === "user" && p.status === "active")
      .map((p) => ({ id: p.id, displayName: p.displayName }));
  }, []);

  // A chat file part only carries a blob id today — Library artifacts have
  // no stored link back to it (see `artifact-chip.tsx`), so this can't
  // resolve through the Library artifacts read surface. It opens the
  // canvas straight from the blob instead: read the bytes off the chat
  // platform's own blob route and render them through the same typed
  // renderers Library and the canvas already share. A real per-artifact
  // deep link is follow-up work once that stored link exists.
  const openArtifact = useCallback(
    (part: Part & { kind: "file" }) => {
      if (
        part.blobId === undefined ||
        tenantId === null ||
        channelId === null
      ) {
        return;
      }
      const blobId = part.blobId;
      void fetchChannelBlob(tenantId, channelId, blobId)
        .then((contentBase64) => {
          openArtifactInCanvas(
            artifactContentFromBlob(part, blobId, contentBase64),
          );
        })
        .catch((err) => {
          openArtifactInCanvas(
            artifactContentFromBlobError(
              part,
              blobId,
              err instanceof Error ? err.message : String(err),
            ),
          );
        });
    },
    [tenantId, channelId, openArtifactInCanvas],
  );

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
      settingsOpen={settingsOpen}
      onSettingsOpenChange={(open) => {
        if (channelId === null) return;
        navigate(
          open ? channelSettingsPath(channelId) : channelPath(channelId),
        );
      }}
      onOpenArtifact={openArtifact}
      {...(approvalActions !== undefined ? { approvalActions } : {})}
      listMembers={listMembers}
    />
  );
}
