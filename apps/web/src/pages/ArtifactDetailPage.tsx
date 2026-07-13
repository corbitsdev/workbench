import { Link, useNavigate, useParams } from "react-router";
import { Archive, ArrowLeft, MessageSquare } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button, ConfirmButton } from "@workbench/ui";
import { ArtifactMeta } from "@workbench/artifact";
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
  function handleChatAboutArtifact() {
    openWithMessage(
      buildArtifactMessage(loadedArtifact, activeTenantId ?? undefined),
    );
  }

  // `/insights/trace/:runId` resolves a `workflow_run_record` id (see
  // WorkflowTracePage). `ArtifactWithSession.sessionId` is emitted as null by
  // the hub today (session enrichment is not wired up — see artifacts.ts), so
  // this destination is unverified: re-check it resolves a real run once the
  // hub starts populating sessionId, rather than assuming the old pre-M6
  // "session" concept lines up with a workflow_run_record id.
  function handleOpenSession(sessionId: string) {
    navigate(`/insights/trace/${sessionId}`);
  }

  function handleOpenParent(parentId: string) {
    navigate(`/artifacts/${parentId}`);
  }

  // Owner-or-admin gate; the server re-checks. Archiving redirects back to the
  // gallery, whose list query the mutation invalidates.
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

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <button
          type="button"
          onClick={() => navigate("/artifacts")}
          aria-label="Back to artifacts"
          className="grid h-8 w-8 place-items-center rounded-sm text-text-2 outline-none transition-[color,background-color,transform] hover:bg-page hover:text-text focus-visible:ring-2 focus-visible:ring-orange active:scale-[0.97]"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold text-text">
            {artifact.title}
          </h1>
          <ArtifactMeta
            kindLabel={resolveKindLabel(artifact.kind)}
            createdAt={artifact.createdAt}
            sessionId={artifact.sessionId}
            sessionName={artifact.sessionName}
            sessionStatus={artifact.sessionStatus}
            parentId={artifact.parentId}
            onOpenSession={handleOpenSession}
            onOpenParent={handleOpenParent}
          />
        </div>
        {canArchive && (
          <div className="flex shrink-0 items-center gap-2">
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
              className="flex items-center gap-1.5"
            >
              <Archive size={14} />
              {archiveMutation.isPending ? "Archiving…" : "Archive"}
            </ConfirmButton>
          </div>
        )}
        <Button
          variant="secondary"
          size="sm"
          onClick={handleChatAboutArtifact}
          className="flex shrink-0 items-center gap-1.5"
        >
          <MessageSquare size={14} />
          Chat about this artifact
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
        <ErrorBoundary>
          <ArtifactBody artifact={artifact} />
        </ErrorBoundary>
      </div>
    </div>
  );
}
