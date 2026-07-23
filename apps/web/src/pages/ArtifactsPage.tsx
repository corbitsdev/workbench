import { PagePanel } from "@workbench/ui";
import { useNavigate } from "react-router";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { ArtifactGallery } from "../components/layout/ArtifactGallery";
import { useActiveWorkbench } from "../lib/active-workbench-context";

/**
 * Artifacts for the globally-selected workbench (the sidebar's workbench toggle
 * owns tenancy; this page just reads it). Intentionally just the artifact
 * gallery — no in-page library rail or agent/workflow panes.
 */
export function ArtifactsPage() {
  const { workbenches, loading, activeTenantId } = useActiveWorkbench();
  const navigate = useNavigate();

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[14px] text-text-3">Loading…</p>
      </div>
    );
  }

  if (workbenches.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-[14px] text-text-2">
          You have not been provided access to any workbenches.
        </p>
        <p className="text-[13px] text-text-3">
          Please contact your administrator to request access.
        </p>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <PagePanel>
        <ArtifactGallery
          tenantId={activeTenantId}
          onOpenArtifact={(artifact) =>
            navigate(`/library/artifacts/${artifact.id}`)
          }
        />
      </PagePanel>
    </ErrorBoundary>
  );
}
