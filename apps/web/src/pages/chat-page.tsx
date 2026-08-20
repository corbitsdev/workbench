// Workbench surface for the main stage. `/w` and `/w/:workbenchId` (plus legacy
// `/chat` prefixes) render the conversation here — not in the canvas.
// Canvas stays auxiliary (profiles and similar) and opens on demand from
// this workspace.

import { libraryArtifactPath } from "@corbits/artifact-ui";
import { describeApiError } from "@corbits/api-query";
import { listPrincipals } from "@corbits/settings-ui";
import { ChatWorkspace, fetchWorkbenchBlob, type Part } from "@corbits/chat-ui";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { fetchArtifactDetail } from "../api";
import { createChatApprovalActions } from "../approval-actions";
import { createChatBlockResponseActions } from "../block-response-actions";
import { createChatConnectGithubActions } from "../connect-github-actions";
import { useBench } from "../bench-context";
import { useSignOut } from "../navigation";
import {
  artifactContentFromBlob,
  artifactContentFromBlobError,
  artifactContentFromDetail,
  artifactContentFromDetailError,
} from "../chat-artifact-open";
import {
  workbenchIdFromPath,
  workbenchPath,
  workbenchSettingsPath,
  workbenchSettingsSectionFromPath,
  workbenchSettingsEntityIdFromPath,
  isWorkbenchSettingsPath,
} from "../workbench-path";
import { reportWorkbenchNotFound } from "../workbench-not-found-event";
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

export function ChatPage({
  path,
  navigate,
}: {
  readonly path: string;
  readonly navigate: (to: string) => void;
}) {
  const bench = useBench();
  const onSignIn = useSignOut();
  const workbenchId = workbenchIdFromPath(path);
  const settingsOpen = isWorkbenchSettingsPath(path);
  const settingsSection = workbenchSettingsSectionFromPath(path) ?? "general";
  const settingsEntityId = settingsOpen
    ? workbenchSettingsEntityIdFromPath(path, settingsSection)
    : null;
  const openProfile = useOpenProfileInCanvas();
  const registerComposerInsert = useRegisterComposerInsert();
  const openArtifactInCanvas = useOpenArtifactInCanvas();
  const openRoutine = useOpenRoutineInCanvas();
  const tenant = tenantResolutionFromBench(bench);
  const principalId = bench.selectedPrincipalId ?? undefined;
  const queryClient = useQueryClient();
  const tenantId = bench.selectedTenantId;
  // Who's live in this workbench right now is derived inside `ChatWorkspace`
  // itself now (CL-6328), off the same `/stream` connection as everything
  // else — no separate `@corbits/presence` room/heartbeat for this surface
  // any more (that stack still backs the artifact canvas's cursor sync,
  // which has no chat stream of its own to piggyback on).
  const approvalActions = useMemo(
    () =>
      tenantId === null
        ? undefined
        : createChatApprovalActions(tenantId, queryClient),
    [tenantId, queryClient],
  );
  const blockResponses = useMemo(
    () =>
      tenantId === null || workbenchId === null
        ? undefined
        : createChatBlockResponseActions(tenantId, workbenchId),
    [tenantId, workbenchId],
  );
  const connectGithubActions = useMemo(
    () =>
      tenantId === null || workbenchId === null
        ? undefined
        : createChatConnectGithubActions(tenantId, workbenchId),
    [tenantId, workbenchId],
  );

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
  const listMembers = useCallback(async (memberTenantId: string) => {
    const principals = await listPrincipals(memberTenantId);
    return principals
      .filter((p) => p.kind === "user" && p.status === "active")
      .map((p) => ({ id: p.id, displayName: p.displayName }));
  }, []);

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
            openArtifactInCanvas(artifactContentFromDetail(tenantId, detail));
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
      if (part.blobId === undefined || workbenchId === null) return;
      const blobId = part.blobId;
      void fetchWorkbenchBlob(tenantId, workbenchId, blobId)
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
    [tenantId, workbenchId, openArtifactInCanvas],
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

  const workspace = (
    <ChatWorkspace
      tenant={tenant}
      {...(principalId !== undefined ? { currentUser: { principalId } } : {})}
      workbenchId={workbenchId}
      onWorkbenchChange={(nextWorkbenchId) =>
        navigate(workbenchPath(nextWorkbenchId))
      }
      onOpenProfile={openProfile}
      registerComposerInsert={registerComposerInsert}
      settingsOpen={settingsOpen}
      onSettingsOpenChange={(open, section) => {
        if (workbenchId === null) return;
        navigate(
          open
            ? workbenchSettingsPath(workbenchId, section ?? settingsSection)
            : workbenchPath(workbenchId),
        );
      }}
      settingsSection={settingsSection}
      onSettingsSectionChange={(section) => {
        if (workbenchId === null) return;
        navigate(workbenchSettingsPath(workbenchId, section));
      }}
      settingsEntityId={settingsEntityId}
      onSettingsEntityIdChange={(entityId) => {
        if (workbenchId === null) return;
        navigate(
          workbenchSettingsPath(
            workbenchId,
            settingsSection,
            entityId ?? undefined,
          ),
        );
      }}
      onOpenArtifact={openArtifact}
      onOpenArtifactInLibrary={openArtifactInLibrary}
      onFixConnection={handleFixConnection}
      {...(approvalActions !== undefined ? { approvalActions } : {})}
      {...(blockResponses !== undefined ? { blockResponses } : {})}
      {...(connectGithubActions !== undefined ? { connectGithubActions } : {})}
      listMembers={listMembers}
      // The header's Routines affordance and `/run`: the panel's default
      // list view, beside this conversation — never a `/routines` hop
      // (CL-6139). Bound to this workbench so the list's own "New routine"
      // row still targets this conversation's agent/workbench.
      onOpenRoutines={() =>
        openRoutine({
          view: "list",
          ...(workbenchId !== null ? { workbenchId } : {}),
        })
      }
      // The header's Insights affordance: this conversation's own scoped
      // timeline, never the global landing. Passes the workbench id as-is —
      // the route itself resolves the workbench's workbench tenant (see
      // `insights-workbench-scope.ts`), since a workbench id is never a
      // tenant id.
      onOpenInsights={() => {
        if (workbenchId === null) return;
        navigate(workbenchInsightsPath(workbenchId));
      }}
      // `/routine`: opens the editor directly on a brand-new routine
      // bound to this workbench.
      onCreateRoutineInSpace={(inSpaceWorkbenchId) =>
        openRoutine({ routineId: null, workbenchId: inSpaceWorkbenchId })
      }
      onWorkbenchNotFound={reportWorkbenchNotFound}
      onBackToWorkbenchList={() => navigate(workbenchPath(null))}
      {...(onSignIn !== undefined ? { onSignIn } : {})}
    />
  );

  // The conversation itself carries the open workbench's own name inline
  // (see ChatWorkspace's `chat-workbench-header`) — that header IS the
  // stage's page identity here, so no generic `StageTopBar` renders above
  // it (CL-6089: a second "Workbenches" bar over the conversation's own
  // header was a double identity, not two different things).
  return workspace;
}
