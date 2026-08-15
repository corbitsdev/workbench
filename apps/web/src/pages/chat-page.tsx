// Channel surface for the main stage. `/c` and `/c/:channelId` (plus legacy
// `/chat` prefixes) render the conversation here — not in the canvas.
// Canvas stays auxiliary (profiles and similar) and opens on demand from
// this workspace.

import { libraryArtifactPath } from "@corbits/artifact-ui";
import { ChatWorkspace, fetchChannelBlob, type Part } from "@corbits/chat-ui";
import { toast } from "@corbits/react-ui";
import { listPrincipals } from "@corbits/settings-ui";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

import { fetchArtifactDetail } from "../api";
import { launchAgentChat } from "../agent-chat-launch";
import { CreateAgentPanel } from "./create-agent-panel";
import { createChatApprovalActions } from "../approval-actions";
import { createChatBlockResponseActions } from "../block-response-actions";
import { useBench } from "../bench-context";
import {
  artifactContentFromBlob,
  artifactContentFromBlobError,
  artifactContentFromDetail,
  artifactContentFromDetailError,
} from "../chat-artifact-open";
import {
  channelIdFromPath,
  channelPath,
  channelSettingsPath,
  channelSettingsSectionFromPath,
  isChannelSettingsPath,
} from "../channel-path";
import {
  consumePendingNewChannel,
  NEW_CHANNEL_EVENT,
  requestNewRoutine,
  requestNewRoutineInSpace,
} from "../command-palette-actions";
import {
  useOpenArtifactInCanvas,
  useOpenProfileInCanvas,
} from "../shell/canvas-availability";
import { useRegisterComposerInsert } from "../shell/composer-insertion";
import { tenantResolutionFromBench } from "../shell/tenant-resolution";
import { usePresenceRoom } from "../presence/use-presence-room";

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
  const settingsSection = channelSettingsSectionFromPath(path) ?? "general";
  const openProfile = useOpenProfileInCanvas();
  const registerComposerInsert = useRegisterComposerInsert();
  const openArtifactInCanvas = useOpenArtifactInCanvas();
  const tenant = tenantResolutionFromBench(bench);
  const principalId = bench.selectedPrincipalId ?? undefined;
  const queryClient = useQueryClient();
  const tenantId = bench.selectedTenantId;
  const [createAgentOpen, setCreateAgentOpen] = useState(false);
  // Who's live in this channel right now, beyond the static participants
  // list — the server derives displayName/color, so no identity data
  // needs resolving here (see `usePresenceRoom`).
  const { members: presenceMembers } = usePresenceRoom(
    tenantId,
    channelId === null ? null : `channel:${channelId}`,
  );
  const approvalActions = useMemo(
    () =>
      tenantId === null
        ? undefined
        : createChatApprovalActions(tenantId, queryClient),
    [tenantId, queryClient],
  );
  const blockResponses = useMemo(
    () =>
      tenantId === null || channelId === null
        ? undefined
        : createChatBlockResponseActions(tenantId, channelId),
    [tenantId, channelId],
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

  // A file part with an `artifactId` links back to a real Library row
  // (CL-6000) — this always resolves through the Library artifacts read
  // surface for that id, the same one `LibraryRoute` reads, never raw blob
  // bytes. Only a part with no `artifactId` (a plain human upload the
  // platform never diverted into an artifact) falls back to reading the
  // bytes off the chat platform's own blob route. Either path renders
  // through the same typed renderers Library and the canvas already share.
  const openArtifact = useCallback(
    (part: Part & { kind: "file" }) => {
      if (tenantId === null) return;
      if (part.artifactId !== undefined) {
        const artifactId = part.artifactId;
        void fetchArtifactDetail(tenantId, artifactId)
          .then((detail) => {
            openArtifactInCanvas(artifactContentFromDetail(detail));
          })
          .catch((err) => {
            openArtifactInCanvas(
              artifactContentFromDetailError(
                part,
                artifactId,
                err instanceof Error ? err.message : String(err),
              ),
            );
          });
        return;
      }
      if (part.blobId === undefined || channelId === null) return;
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

  // The chip's "Open in Library" affordance — only ever offered for a part
  // that carries an `artifactId` (see `ArtifactChip`), so this always has a
  // real row to deep-link to.
  const openArtifactInLibrary = useCallback(
    (part: Part & { kind: "file" }) => {
      if (part.artifactId === undefined) return;
      navigate(libraryArtifactPath(part.artifactId));
    },
    [navigate],
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

  const workspace = (
    <ChatWorkspace
      tenant={tenant}
      {...(principalId !== undefined ? { currentUser: { principalId } } : {})}
      channelId={channelId}
      onChannelChange={(nextChannelId) => navigate(channelPath(nextChannelId))}
      onOpenProfile={openProfile}
      registerComposerInsert={registerComposerInsert}
      settingsOpen={settingsOpen}
      onSettingsOpenChange={(open, section) => {
        if (channelId === null) return;
        navigate(
          open
            ? channelSettingsPath(channelId, section ?? settingsSection)
            : channelPath(channelId),
        );
      }}
      settingsSection={settingsSection}
      onSettingsSectionChange={(section) => {
        if (channelId === null) return;
        navigate(channelSettingsPath(channelId, section));
      }}
      onOpenArtifact={openArtifact}
      onOpenArtifactInLibrary={openArtifactInLibrary}
      {...(approvalActions !== undefined ? { approvalActions } : {})}
      {...(blockResponses !== undefined ? { blockResponses } : {})}
      listMembers={listMembers}
      onOpenRoutines={() =>
        requestNewRoutine({
          alreadyOnRoutines: false,
          navigateToRoutines: () => navigate("/routines"),
        })
      }
      onCreateRoutineInSpace={(spaceChannelId) =>
        requestNewRoutineInSpace({
          alreadyOnRoutines: false,
          navigateToRoutines: () => navigate("/routines"),
          deliveryChannelId: spaceChannelId,
        })
      }
      presenceMembers={presenceMembers}
      {...(tenantId !== null
        ? { onRequestNewAgent: () => setCreateAgentOpen(true) }
        : {})}
    />
  );

  return (
    <>
      {workspace}
      {tenantId !== null ? (
        <CreateAgentPanel
          open={createAgentOpen}
          onOpenChange={setCreateAgentOpen}
          tenantId={tenantId}
          onCreated={(definition) => {
            launchAgentChat(tenantId, definition.id, navigate).catch(() => {
              toast("Created the agent, but couldn't open a chat with it.");
            });
          }}
        />
      ) : null}
    </>
  );
}
