// The Library page's one seam to the hub's real artifacts plane:
// `GET /api/tenants/:tenantId/artifacts` (list) and
// `GET /api/tenants/:tenantId/artifacts/:id` (detail), plus
// `POST .../artifacts/upload` for file ingest and
// `GET .../artifacts/counts` for the kind nav's counts.
//
// This module owns pure mapping + upload helper so the page stays thin and
// the shape contract has its own tests. The old asset-shim path is gone.

import type { ArtifactSummary } from "@corbits/artifact-ui";

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
    throw new ArtifactUploadError(
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (!response.ok) {
    throw new ArtifactUploadError(
      `The hub answered ${response.status} for artifact upload.`,
      response.status,
    );
  }
  const body = (await response.json()) as {
    data?: readonly ArtifactDetail[];
  };
  if (!Array.isArray(body.data)) {
    throw new ArtifactUploadError(
      "Unexpected response shape from artifact upload.",
    );
  }
  return body.data;
}

export class ArtifactUploadError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** True when the hub answered "artifacts plane not configured". */
export function isArtifactsUnavailableMessage(message: string): boolean {
  return (
    message.includes(" answered 503 ") ||
    message.toLowerCase().includes("not configured")
  );
}

export function artifactUploadToast(names: readonly string[]): string {
  const [only] = names;
  return only !== undefined && names.length === 1
    ? `Uploaded · ${only}`
    : `Uploaded ${names.length} files`;
}
