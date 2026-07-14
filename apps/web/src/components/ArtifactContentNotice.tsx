import { FileWarning, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import type { SessionStatus } from "@workbench/shared";

// Shared "designed" fallback for weak/unparseable/empty previews (invalid URL,
// missing id, malformed payload, no content yet): an icon + message inside the
// same muted card treatment across every artifact viewer, never a raw <pre>
// dump or a bare sentence. Lives outside ArtifactBody.tsx so kind-specific
// renderers (CompareBody, GammaPresentationBody) can reuse it without a
// circular import back into ArtifactBody.
export function PreviewFallback({
  icon: Icon = FileWarning,
  message,
  action,
}: {
  icon?: typeof FileWarning;
  message: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded border border-border bg-surface-2/40 px-6 py-10 text-center">
      <Icon className="h-8 w-8 text-text-3" aria-hidden="true" />
      <p className="max-w-[42ch] text-sm text-text-3">{message}</p>
      {action}
    </div>
  );
}

// A session actively producing collateral: an empty artifact body here means
// "not written yet", not "broken" — the viewer must say so explicitly.
export function isArtifactProcessing(
  sessionStatus?: SessionStatus | null,
): boolean {
  return (
    sessionStatus === "pending" ||
    sessionStatus === "analyzing" ||
    sessionStatus === "generating"
  );
}

/** Explicit empty/processing state for any text-bodied artifact viewer. */
export function EmptyContentNotice({
  sessionStatus,
}: {
  sessionStatus?: SessionStatus | null;
}) {
  if (isArtifactProcessing(sessionStatus)) {
    return (
      <PreviewFallback
        icon={Loader2}
        message="This artifact is still being generated — check back shortly."
      />
    );
  }
  return <PreviewFallback message="This artifact has no content yet." />;
}
