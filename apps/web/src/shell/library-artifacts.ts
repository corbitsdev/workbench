// The Library page's one seam to the hub's real artifacts plane:
// `GET /api/tenants/:tenantId/artifacts` (list) and
// `GET /api/tenants/:tenantId/artifacts/:id` (detail), plus
// `POST .../artifacts/upload` for file ingest and
// `GET .../artifacts/counts` for the kind nav's counts.
//
// This module owns pure mapping + upload helper so the page stays thin and
// the shape contract has its own tests. The old asset-shim path is gone.

import type { ArtifactSummary } from "@corbits/artifact-ui";
import { ApiQueryError, UnauthenticatedError } from "@corbits/api-query";

import { FILES_PATH_PREFIX } from "../path-ids";

/** List row from the hub artifacts surface (content omitted). */
export type ArtifactListRow = {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly ownerName: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** Detail body — list metadata plus the stored content string. */
export type ArtifactDetail = ArtifactListRow & {
  readonly content: string;
  readonly version: number;
};

/** One list row reshaped for the Library gallery. */
export function artifactListRowToSummary(
  row: ArtifactListRow,
): ArtifactSummary {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    ownerName: row.ownerName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Map a full listing into gallery rows, preserving order and count. */
export function mapArtifactListToSummaries(
  rows: readonly ArtifactListRow[],
): ArtifactSummary[] {
  return rows.map(artifactListRowToSummary);
}

/** `GET /api/tenants/:id/artifacts/counts` — the Library kind nav's counts. */
export function artifactCountsPath(tenantId: string): string {
  return `/api/tenants/${tenantId}/artifacts/counts`;
}

/**
 * POST multipart upload against the tenant artifacts surface. Returns the
 * created detail rows on 201; throws with status on non-2xx so the page can
 * surface an honest failure.
 */
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
    throw new ApiQueryError(
      cause instanceof Error ? cause.message : String(cause),
    );
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
    data?: readonly ArtifactDetail[];
  };
  if (!Array.isArray(body.data)) {
    throw new ApiQueryError("Unexpected response shape from artifact upload.");
  }
  return body.data;
}

/** True when the hub answered "artifacts plane not configured" (503) —
 * read off the query's own status field, never string-matched out of a
 * rendered message (that copy is display-boundary plain by design and
 * carries no status text to match against). */
export function isArtifactsUnavailableStatus(
  status: number | undefined,
): boolean {
  return status === 503;
}

export function artifactUploadToast(names: readonly string[]): string {
  const [only] = names;
  return only !== undefined && names.length === 1
    ? `Uploaded · ${only}`
    : `Uploaded ${names.length} files`;
}

/**
 * The bulk/context-menu operation set this file adopts from the shared
 * selection system (CL-6423) — deliberately just the one real, already-
 * shippable operation: every other candidate (delete, move, rename,
 * download) has no backend route or store method behind it yet (see
 * `packages/artifacts-hub/src/routes.ts` and `@corbits/artifacts`'
 * `ArtifactStore`), so wiring a button for any of them would be exactly the
 * dead/no-op control this adoption is required to avoid. `BulkActionBar`
 * and the shell context menu's `artifact` target both read this same
 * constant, which is what the parity test asserts against.
 */
export const LIBRARY_BULK_OPERATION_IDS = ["copy-link"] as const;

/** `/files/a/:id` (CL-6015) — the one canonical deep link a file has. */
export function libraryArtifactDeepLink(id: string): string {
  return `${FILES_PATH_PREFIX}/a/${encodeURIComponent(id)}`;
}

/** Copies one or more files' canonical links, newline-joined, to the
 * clipboard — the same `copyLink` idiom already used for workbenches,
 * routines, and insight runs, extended to a whole selection. */
export async function copyArtifactLinks(ids: readonly string[]): Promise<void> {
  const urls = ids.map(
    (id) => `${window.location.origin}${libraryArtifactDeepLink(id)}`,
  );
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
