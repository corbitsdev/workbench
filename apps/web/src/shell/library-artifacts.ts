import type { ArtifactSummary } from "@/library";
import { ApiQueryError, UnauthenticatedError } from "@/lib/api-query";

import { ARTIFACTS_PATH_PREFIX } from "../path-ids";

/** List row from the hub artifacts surface (content omitted). */
export type ArtifactListRow = {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** Detail body — list metadata plus the stored content string. */
export type ArtifactDetail = ArtifactListRow & {
  readonly content: string;
  readonly version: number;
};

/** One list row reshaped for the Library gallery. */
export function artifactListRowToSummary(row: ArtifactListRow): ArtifactSummary {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Map a full listing into gallery rows, preserving order and count. */
export function mapArtifactListToSummaries(rows: readonly ArtifactListRow[]): ArtifactSummary[] {
  return rows.map(artifactListRowToSummary);
}

/** `GET /api/tenants/:id/artifacts/counts` — the Library kind nav's counts. */
export function artifactCountsPath(tenantId: string): string {
  return `/api/tenants/${tenantId}/artifacts/counts`;
}

// Throws with status on non-2xx so the page can surface an honest failure.
export async function uploadArtifactFiles(
  tenantId: string,
  files: readonly File[],
): Promise<readonly ArtifactDetail[]> {
  const form = new FormData();
  for (const file of files) {
    form.append("file", file, file.name);
  }
  let response: Response;
  try {
    response = await fetch(`/api/tenants/${tenantId}/artifacts/upload`, {
      method: "POST",
      body: form,
    });
  } catch (cause) {
    throw new ApiQueryError(cause instanceof Error ? cause.message : String(cause));
  }
  if (response.status === 401) {
    throw new UnauthenticatedError();
  }
  if (!response.ok) {
    throw new ApiQueryError(
      `The server answered ${response.status} for artifact upload.`,
      response.status,
    );
  }
  const body = (await response.json()) as {
    artifacts?: readonly ArtifactDetail[];
  };
  if (!Array.isArray(body.artifacts)) {
    throw new ApiQueryError("Unexpected response shape from artifact upload.");
  }
  return body.artifacts;
}

// Throws with status on non-2xx, never silently pretends the write landed.
export async function saveArtifactContent(
  tenantId: string,
  artifactId: string,
  content: string,
): Promise<ArtifactDetail> {
  let response: Response;
  try {
    response = await fetch(`/api/tenants/${tenantId}/artifacts/${encodeURIComponent(artifactId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
  } catch (cause) {
    throw new ApiQueryError(cause instanceof Error ? cause.message : String(cause));
  }
  if (response.status === 401) {
    throw new UnauthenticatedError();
  }
  if (!response.ok) {
    throw new ApiQueryError(
      `The server answered ${response.status} for artifact save.`,
      response.status,
    );
  }
  return (await response.json()) as ArtifactDetail;
}

// Read off the query's status field, never string-matched out of the
// rendered message.
export function isArtifactsUnavailableStatus(status: number | undefined): boolean {
  return status === 503;
}

export function artifactUploadToast(names: readonly string[]): string {
  const [only] = names;
  return only !== undefined && names.length === 1
    ? `Uploaded · ${only}`
    : `Uploaded ${names.length} files`;
}

// Deliberately just the one shippable operation: delete/move/rename/
// download have no backend route yet, and a button with nothing behind
// it is exactly the dead control this adoption avoids.
export const LIBRARY_BULK_OPERATION_IDS = ["copy-link"] as const;

/** `/artifacts/a/:id` — the one canonical deep link a file has. */
export function libraryArtifactDeepLink(id: string): string {
  return `${ARTIFACTS_PATH_PREFIX}/a/${encodeURIComponent(id)}`;
}

/** Copies one or more files' canonical links, newline-joined, to the
 * clipboard — the same `copyLink` idiom already used for workbenches,
 * routines, and insight runs, extended to a whole selection. */
export async function copyArtifactLinks(ids: readonly string[]): Promise<void> {
  const urls = ids.map((id) => `${window.location.origin}${libraryArtifactDeepLink(id)}`);
  await navigator.clipboard.writeText(urls.join("\n"));
}

export function copyArtifactLinksToastLabel(count: number): string {
  return count === 1 ? "Link copied" : `${count} links copied`;
}

/** The action's own label — shared by the bulk action bar and the context
 * menu so both surfaces say the same count-aware thing. */
export function copyArtifactLinksActionLabel(count: number): string {
  return count > 1 ? `Copy ${count} links` : "Copy link";
}

// Null for an artifact with no upload backing at all — the only case
// where an empty `content` genuinely means "nothing here yet."
export function uploadMimeTypeFromSource(source: Record<string, unknown>): string | null {
  const upload = source.upload;
  if (typeof upload !== "object" || upload === null) return null;
  const mimeType = (upload as Record<string, unknown>).mimeType;
  return typeof mimeType === "string" ? mimeType : null;
}
