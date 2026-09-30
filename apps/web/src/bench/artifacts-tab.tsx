import { Skeleton, formatRelativeTime } from "@corbits/react-ui";

import { ArtifactListPageSchema, useAPIQuery } from "@/api";
import { libraryArtifactPath } from "@/library";
import { FileText } from "@/lib/icons";
import { Link } from "@/navigation";
import { ARTIFACTS_PATH_PREFIX } from "@/path-ids";
import { benchLink } from "../shell/page-crumbs";

/** The files saved in this bench, newest first. */
export function ArtifactsTab({ workbenchTenantId }: { readonly workbenchTenantId: string }) {
  const page = useAPIQuery(`/api/tenants/${workbenchTenantId}/artifacts`, ArtifactListPageSchema);
  const rows =
    page.kind === "ready"
      ? [...page.data.artifacts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      : [];

  return (
    <section className="drawer-sec">
      <div className="drawer-sec-head">
        <h3>Files saved here</h3>
        <Link to={benchLink(ARTIFACTS_PATH_PREFIX, workbenchTenantId)}>Open all</Link>
      </div>
      {page.kind === "loading" ? <Skeleton className="h-16 w-full" /> : null}
      {page.kind === "error" ? <p className="workbench-info-empty-note">{page.message}</p> : null}
      {page.kind === "ready" && rows.length === 0 ? (
        <p className="workbench-info-empty-note">Nothing saved here yet.</p>
      ) : null}
      {rows.length > 0 ? (
        <div className="drawer-list">
          {rows.map((artifact) => (
            <Link key={artifact.id} to={libraryArtifactPath(artifact.id)} className="drawer-li">
              <span className="drawer-file-ic">
                <FileText size={16} aria-hidden="true" />
              </span>
              <span className="drawer-li-t">
                <b>{artifact.title}</b>
                <span>{artifact.kind}</span>
              </span>
              <span className="drawer-li-m">{formatRelativeTime(artifact.updatedAt)}</span>
            </Link>
          ))}
        </div>
      ) : null}
    </section>
  );
}
