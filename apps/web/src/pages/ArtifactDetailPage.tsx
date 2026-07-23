import { useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
  Archive,
  ArrowLeft,
  Download,
  ExternalLink,
  MessageSquare,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { type } from "arktype";
import { buttonVariants, Button, cn, ConfirmButton } from "@workbench/ui";
import {
  ArtifactDetailShell,
  ArtifactMeta,
  formatArtifactDate,
  visualForKind,
} from "@workbench/artifact";
import { GammaPresentationContentSchema } from "@workbench/shared";
import { useArchiveArtifact, useArtifact } from "@workbench/client/react";

import { getMe } from "../lib/hub-api";
import { buildApiUrl } from "../lib/api";
import { clientOptions } from "../lib/client-options";
import ArtifactBody, {
  ArtifactUploadPresenceSchema,
} from "../components/ArtifactBody";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { resolveKindLabel } from "../lib/resolve-kind-label";
import { useActiveWorkbench } from "../lib/active-workbench-context";
import { useChatLauncher } from "../lib/chat-launcher-context";
import { buildArtifactMessage } from "../lib/artifact-chat-message";
import { usePublishActiveContext } from "../lib/active-context-store";
import { useSetPageChrome, useSetPageChromeLeading } from "../lib/page-chrome";

// Kinds whose content is a downloadable file served by the download route
// (uploaded binaries and CSV exports). gamma_presentation is handled
// separately below since it is only downloadable when a PDF was attached.
const DOWNLOADABLE_ARTIFACT_KINDS = new Set(["image", "file", "csv-export"]);

const ARTIFACT_DETAIL_CHROME_ACTION_CLASS =
  "inline-flex items-center gap-1.5 text-xs font-medium text-text-2 hover:text-text";

// A presence check only (not the strict field-typed schema used for
// isCsvUpload/extractUploadFilename) — this decides whether to show a
// download button, and a legacy row with a malformed upload.mimeType or
// upload.filename still genuinely has upload metadata worth downloading.
function hasUploadSource(source: unknown): boolean {
  const parsed = ArtifactUploadPresenceSchema(source);
  if (parsed instanceof type.errors) return false;
  return parsed.upload !== undefined;
}

// The Gamma deck URL lives in the artifact's JSON content, not on the row —
// parse it via the shared schema (same one GammaPresentationBody uses) purely
// to decide whether an "Open in Gamma" action belongs in the page header.
// Never build or touch the download/embed URL logic itself.
function resolveGammaUrl(kind: string, content: string): string | null {
  if (kind !== "gamma_presentation") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return null;
  }
  const deck = GammaPresentationContentSchema(raw);
  if (deck instanceof type.errors) return null;
  try {
    return new URL(deck.url).protocol === "https:" ? deck.url : null;
  } catch {
    return null;
  }
}

function ArtifactSummaryHeader({
  title,
  kindLabel,
  version,
  createdAt,
}: {
  title: string;
  kindLabel: string | undefined;
  version: number;
  createdAt: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <h1 className="text-lg font-semibold leading-snug text-text">{title}</h1>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {kindLabel && (
          <span className="font-medium text-text">{kindLabel}</span>
        )}
        <span className="text-text-3">v{version}</span>
        <span className="text-text-3">{formatArtifactDate(createdAt)}</span>
      </div>
    </div>
  );
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
    const canDownload =
      DOWNLOADABLE_ARTIFACT_KINDS.has(artifact.kind) ||
      (artifact.kind === "gamma_presentation" &&
        hasUploadSource(artifact.source));
    const gammaUrl = resolveGammaUrl(artifact.kind, artifact.content);
    return (
      <div
        data-testid="artifact-detail-chrome-actions"
        className="flex flex-row flex-wrap items-center justify-end gap-1"
      >
        {canDownload && (
          <a
            href={buildApiUrl(`/artifacts/${artifact.id}/download`)}
            download
            className={cn(
              buttonVariants({ variant: "ghost", size: "sm" }),
              ARTIFACT_DETAIL_CHROME_ACTION_CLASS,
            )}
          >
            <Download size={14} aria-hidden />
            Download
          </a>
        )}
        {gammaUrl !== null && (
          <a
            href={gammaUrl}
            target="_blank"
            rel="noreferrer"
            className={cn(
              buttonVariants({ variant: "ghost", size: "sm" }),
              ARTIFACT_DETAIL_CHROME_ACTION_CLASS,
            )}
          >
            <ExternalLink size={14} aria-hidden />
            Open in Gamma
          </a>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            openWithMessage(
              buildArtifactMessage(artifact, activeTenantId ?? undefined),
            )
          }
          className={ARTIFACT_DETAIL_CHROME_ACTION_CLASS}
        >
          <MessageSquare size={14} aria-hidden />
          Chat about this
        </Button>
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
              onConfirm={() =>
                archiveMutation.mutate(
                  { artifactId: artifact.id, tenantId: activeTenantId },
                  { onSuccess: () => navigate("/library/artifacts") },
                )
              }
              className={ARTIFACT_DETAIL_CHROME_ACTION_CLASS}
            >
              <Archive size={14} />
              {archiveMutation.isPending ? "Archiving…" : "Archive"}
            </ConfirmButton>
          </>
        )}
      </div>
    );
    // Depend on stable/primitive fields only. The full `archiveMutation` and
    // `meQuery.data` objects get fresh identities each render; using them here
    // regenerated the chrome node every render, and useSetPageChrome's effect
    // re-published it in a loop ("Maximum update depth exceeded").
  }, [
    artifact,
    activeTenantId,
    openWithMessage,
    meQuery.data?.isAdmin,
    meQuery.data?.isOwner,
    activeWorkbench?.id,
    archiveMutation.mutate,
    archiveMutation.isPending,
    archiveMutation.isError,
    navigate,
  ]);

  const leadingChrome = useMemo(() => {
    if (artifact === undefined) return null;
    return (
      <Link
        to="/library/artifacts"
        className="inline-flex items-center gap-1.5 text-sm text-text-2 transition-colors hover:text-text"
      >
        <ArrowLeft size={14} aria-hidden />
        Back to Artifacts
      </Link>
    );
  }, [artifact]);

  useSetPageChrome(pageChrome);
  useSetPageChromeLeading(leadingChrome);

  if (isLoading) return <CenteredNotice>Loading artifact…</CenteredNotice>;

  if (isError || artifact === undefined) {
    return (
      <CenteredNotice>
        <div className="flex flex-col items-center gap-2">
          <span>This artifact couldn't be found.</span>
          <Link to="/library/artifacts" className="text-orange underline">
            Back to Artifacts
          </Link>
        </div>
      </CenteredNotice>
    );
  }

  function handleOpenSession(sessionId: string) {
    navigate(`/insights/trace/${sessionId}`);
  }

  function handleOpenParent(parentId: string) {
    navigate(`/library/artifacts/${parentId}`);
  }

  const kindLabel = resolveKindLabel(artifact.kind);
  const accent = visualForKind(artifact.kind).fill;

  // The metadata rail only ever holds real provenance (source session,
  // related conversation/workflow, or a parent artifact); kind/version/status/
  // date already live in the header above. When an artifact has none of that
  // provenance, the rail is omitted entirely rather than rendering an empty
  // column.
  const hasProvenance =
    artifact.sessionId !== null ||
    artifact.sessionName !== null ||
    artifact.sessionStatus !== null ||
    artifact.parentId !== null;

  return (
    <ArtifactDetailShell
      accentClass={accent}
      header={
        <ArtifactSummaryHeader
          title={artifact.title}
          kindLabel={kindLabel}
          version={artifact.version}
          createdAt={artifact.createdAt}
        />
      }
      rail={
        hasProvenance ? (
          <ArtifactMeta
            createdAt={null}
            sessionId={artifact.sessionId}
            sessionName={artifact.sessionName}
            sessionStatus={artifact.sessionStatus}
            parentId={artifact.parentId}
            onOpenSession={handleOpenSession}
            onOpenParent={handleOpenParent}
          />
        ) : null
      }
    >
      <ErrorBoundary>
        <ArtifactBody artifact={artifact} layout="detail" />
      </ErrorBoundary>
    </ArtifactDetailShell>
  );
}
