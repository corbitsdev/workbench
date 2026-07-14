import { useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Archive, MessageSquare } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button, ConfirmButton } from "@workbench/ui";
import {
  ArtifactDetailShell,
  ArtifactMeta,
  visualForKind,
} from "@workbench/artifact";
import type { ArtifactStatus } from "@workbench/shared";
import { useArchiveArtifact, useArtifact } from "@workbench/client/react";

import { getMe } from "../lib/hub-api";
import { clientOptions } from "../lib/client-options";
import ArtifactBody from "../components/ArtifactBody";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { resolveKindLabel } from "../lib/resolve-kind-label";
import { useActiveWorkbench } from "../lib/active-workbench-context";
import { useChatLauncher } from "../lib/chat-launcher-context";
import { buildArtifactMessage } from "../lib/artifact-chat-message";
import { usePublishActiveContext } from "../lib/active-context-store";
import { useSetPageChrome } from "../lib/page-chrome";

function artifactStatusLabel(status: ArtifactStatus): string {
  switch (status) {
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
    default:
      return "Draft";
  }
}

function CenteredNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center px-6 text-center text-sm text-text-2">
      {children}
    </div>
  );
}

/**
 * Full-page view of a single artifact: type-adaptive render (ArtifactBody).
 * The in-pane chat composer was removed as redundant; the global Myra dock is
 * artifact-agnostic, so this view offers a "Chat about this artifact" action
 * that opens the dock seeded with the artifact via buildArtifactMessage.
 */
export function ArtifactDetailPage() {
  const { artifactId } = useParams();
  const navigate = useNavigate();
  const { activeTenantId, activeWorkbench } = useActiveWorkbench();
  const { openWithMessage } = useChatLauncher();
  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: getMe,
    staleTime: 5 * 60_000,
  });
  const archiveMutation = useArchiveArtifact(clientOptions);

  const {
    data: artifact,
    isLoading,
    isError,
  } = useArtifact(clientOptions, {
    tenantId: activeTenantId,
    artifactId,
    enabled: !!activeTenantId && !!artifactId,
  });

  usePublishActiveContext(
    artifact
      ? {
          kind: "artifact",
          id: artifact.id,
          label: artifact.title,
          artifactKind: artifact.kind,
          body: artifact.content,
        }
      : null,
    artifact ? String(artifact.version) : undefined,
  );

  const pageChrome = useMemo(() => {
    if (artifact === undefined) return null;
    const canArchive =
      meQuery.data?.isAdmin === true ||
      meQuery.data?.isOwner === true ||
      (artifact.ownerPrincipalId !== null &&
        artifact.ownerPrincipalId === (activeWorkbench?.id ?? null));
    return (
      <>
        <button
          type="button"
          onClick={() =>
            openWithMessage(
              buildArtifactMessage(artifact, activeTenantId ?? undefined),
            )
          }
          className="inline-flex items-center gap-1.5 rounded-[8px] px-2 py-1 text-xs font-medium text-text-2 transition-colors hover:bg-page hover:text-text"
        >
          <MessageSquare size={14} aria-hidden />
          Chat about this
        </button>
        {canArchive && (
          <>
            {archiveMutation.isError && (
              <span className="text-xs text-red">Couldn&apos;t archive</span>
            )}
            <ConfirmButton
              variant="ghost"
              size="sm"
              confirmLabel="Confirm archive"
              disabled={archiveMutation.isPending}
              onConfirm={() =>
                archiveMutation.mutate(
                  { artifactId: artifact.id, tenantId: activeTenantId },
                  { onSuccess: () => navigate("/artifacts") },
                )
              }
              className="inline-flex items-center gap-1.5"
            >
              <Archive size={14} />
              {archiveMutation.isPending ? "Archiving…" : "Archive"}
            </ConfirmButton>
          </>
        )}
      </>
    );
  }, [
    artifact,
    activeTenantId,
    openWithMessage,
    meQuery.data,
    activeWorkbench,
    archiveMutation,
    navigate,
  ]);

  useSetPageChrome(pageChrome);

  if (isLoading) return <CenteredNotice>Loading artifact…</CenteredNotice>;

  if (isError || artifact === undefined) {
    return (
      <CenteredNotice>
        <div className="flex flex-col items-center gap-2">
          <span>This artifact couldn't be found.</span>
          <Link to="/artifacts" className="text-orange underline">
            Back to artifacts
          </Link>
        </div>
      </CenteredNotice>
    );
  }

  function handleOpenSession(sessionId: string) {
    navigate(`/insights/trace/${sessionId}`);
  }

  function handleOpenParent(parentId: string) {
    navigate(`/artifacts/${parentId}`);
  }

  const kindLabel = resolveKindLabel(artifact.kind);
  const accent = visualForKind(artifact.kind).fill;

  return (
    <ArtifactDetailShell
      accentClass={accent}
      rail={
        <ArtifactMeta
          kindLabel={kindLabel}
          version={artifact.version}
          statusLabel={artifactStatusLabel(artifact.status)}
          createdAt={artifact.createdAt}
          sessionId={artifact.sessionId}
          sessionName={artifact.sessionName}
          sessionStatus={artifact.sessionStatus}
          parentId={artifact.parentId}
          onOpenSession={handleOpenSession}
          onOpenParent={handleOpenParent}
        />
      }
    >
      <ErrorBoundary>
        <ArtifactBody artifact={artifact} layout="detail" />
      </ErrorBoundary>
    </ArtifactDetailShell>
  );
}
