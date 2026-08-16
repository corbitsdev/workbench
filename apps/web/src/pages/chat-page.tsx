// Channel surface for the main stage. `/c` and `/c/:channelId` (plus legacy
// `/chat` prefixes) render the conversation here — not in the canvas.
// Canvas stays auxiliary (profiles and similar) and opens on demand from
// this workspace.

import { libraryArtifactPath } from "@corbits/artifact-ui";
import { describeApiError } from "@corbits/api-query";
import { ChatWorkspace, fetchChannelBlob, type Part } from "@corbits/chat-ui";
import { toast } from "@corbits/react-ui";
import { listPrincipals } from "@corbits/settings-ui";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";

import { fetchArtifactDetail } from "../api";
import { createChatApprovalActions } from "../approval-actions";
import { createChatBlockResponseActions } from "../block-response-actions";
import { useBench } from "../bench-context";
import { useSignOut } from "../navigation";
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
} from "../command-palette-actions";
import { reportChannelNotFound } from "../channel-not-found-event";
import { createAgentAndLaunch } from "../instant-agent-create";
import { workbenchInsightsPath } from "../insights-deeplinks";
import { ONBOARDING_PATH } from "../routes";
import {
  useProviderHealthBanner,
  useRequestPluginsConnect,
} from "../shell/provider-health-context";
import {
  useOpenArtifactInCanvas,
  useOpenProfileInCanvas,
  useOpenRoutineInCanvas,
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
  const onSignIn = useSignOut();
  const channelId = channelIdFromPath(path);
  const settingsOpen = isChannelSettingsPath(path);
  const settingsSection = channelSettingsSectionFromPath(path) ?? "general";
  const openProfile = useOpenProfileInCanvas();
  const registerComposerInsert = useRegisterComposerInsert();
  const openArtifactInCanvas = useOpenArtifactInCanvas();
  const openRoutine = useOpenRoutineInCanvas();
  const tenant = tenantResolutionFromBench(bench);
  const principalId = bench.selectedPrincipalId ?? undefined;
  const queryClient = useQueryClient();
  const tenantId = bench.selectedTenantId;
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

  // The in-chat "Fix this connection" affordance's deep link (CL-6092) —
  // the exact same hop the shell banner's own "Fix it" takes, reusing
  // `providerHealthBanner`'s current provider (chat-ui only sees a
  // classified reply's prose, never which provider it named — see
  // `inference-failure.ts`'s own header) rather than inventing a second
  // routing decision. Falls back to a bare Plugins visit if the banner's
  // provider isn't currently known (an edge case: the health poll hasn't
  // landed yet, or the incident already cleared between the reply and
  // the click).
  const providerHealthBanner = useProviderHealthBanner();
  const requestPluginsConnect = useRequestPluginsConnect();
  const handleFixConnection = useCallback(() => {
    if (providerHealthBanner === null) {
      navigate("/plugins");
      return;
    }
    if (providerHealthBanner.zeroWorkingProviders) {
      navigate(ONBOARDING_PATH);
      return;
    }
    requestPluginsConnect(providerHealthBanner.provider);
    navigate("/plugins");
  }, [providerHealthBanner, requestPluginsConnect, navigate]);

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
                describeApiError(err, "loading this artifact"),
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
              describeApiError(err, "loading this attachment"),
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
      onFixConnection={handleFixConnection}
      {...(approvalActions !== undefined ? { approvalActions } : {})}
      {...(blockResponses !== undefined ? { blockResponses } : {})}
      listMembers={listMembers}
      onOpenRoutines={() =>
        requestNewRoutine({
          navigateToRoutines: () => navigate("/routines"),
          openRoutine,
        })
      }
      onCreateRoutineInSpace={() =>
        requestNewRoutine({
          navigateToRoutines: () => navigate("/routines"),
          openRoutine,
        })
      }
      presenceMembers={presenceMembers}
      {...(tenantId !== null
        ? {
            onRequestNewAgent: () => {
              createAgentAndLaunch(tenantId, navigate).catch(() => {
                toast("Couldn't create the agent — try again.");
              });
            },
            onOpenInsights: () => navigate(workbenchInsightsPath(tenantId)),
          }
        : {})}
      onChannelNotFound={reportChannelNotFound}
      onBackToChannelList={() => navigate(channelPath(null))}
      {...(onSignIn !== undefined ? { onSignIn } : {})}
    />
  );

  // The conversation itself carries the open workbench's own name inline
  // (see ChatWorkspace's `chat-channel-header`) — that header IS the
  // stage's page identity here, so no generic `StageTopBar` renders above
  // it (CL-6089: a second "Workbenches" bar over the conversation's own
  // header was a double identity, not two different things).
  return workspace;
}
