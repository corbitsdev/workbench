import { useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Archive, ArrowLeft, MessageSquare } from "lucide-react";
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
    return (
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
    );
  }, [artifact, activeTenantId, openWithMessage]);

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

  const loadedArtifact = artifact;

  function handleOpenSession(sessionId: string) {
    navigate(`/insights/trace/${sessionId}`);
  }

  function handleOpenParent(parentId: string) {
    navigate(`/artifacts/${parentId}`);
  }

  const canArchive =
    meQuery.data?.isAdmin === true ||
    meQuery.data?.isOwner === true ||
    (loadedArtifact.ownerPrincipalId !== null &&
      loadedArtifact.ownerPrincipalId === (activeWorkbench?.id ?? null));

  function handleArchive() {
    archiveMutation.mutate(
      { artifactId: loadedArtifact.id, tenantId: activeTenantId },
      { onSuccess: () => navigate("/artifacts") },
    );
  }

  const kindLabel = resolveKindLabel(artifact.kind);
  const accent = visualForKind(artifact.kind).fill;

  return (
    <ArtifactDetailShell
      accentClass={accent}
      header={
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate("/artifacts")}
            aria-label="Back to artifacts"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-sm text-text-2 outline-none transition-[color,background-color,transform] hover:bg-page hover:text-text focus-visible:ring-2 focus-visible:ring-orange active:scale-[0.97]"
          >
            <ArrowLeft size={18} />
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold text-text">
              {artifact.title}
            </h1>
            <p className="mt-0.5 font-mono text-[11px] text-text-3">
              {kindLabel} · v{artifact.version} ·{" "}
              {artifactStatusLabel(artifact.status)}
            </p>
          </div>
        </div>
      }
      rail={
        <div className="flex flex-col gap-4">
          <ArtifactMeta
            kindLabel={kindLabel}
            createdAt={artifact.createdAt}
            sessionId={artifact.sessionId}
            sessionName={artifact.sessionName}
            sessionStatus={artifact.sessionStatus}
            parentId={artifact.parentId}
            onOpenSession={handleOpenSession}
            onOpenParent={handleOpenParent}
          />
          <div className="flex flex-col gap-2">
            {canArchive && (
              <>
                {archiveMutation.isError && (
                  <span className="text-xs text-red">
                    Couldn&apos;t archive — try again
                  </span>
                )}
                <ConfirmButton
                  variant="ghost"
                  size="sm"
                  confirmLabel="Confirm archive"
                  disabled={archiveMutation.isPending}
                  onConfirm={handleArchive}
                  className="flex w-full items-center justify-center gap-1.5"
                >
                  <Archive size={14} />
                  {archiveMutation.isPending ? "Archiving…" : "Archive"}
                </ConfirmButton>
              </>
            )}
          </div>
        </div>
      }
    >
      <ErrorBoundary>
        <ArtifactBody artifact={artifact} layout="detail" />
      </ErrorBoundary>
    </ArtifactDetailShell>
  );
}
