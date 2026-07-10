import { useQuery } from "@tanstack/react-query";
import { CSV_MAX_PREVIEW_BYTES } from "@workbench/artifact";
import { fetchCsvPreview, type CsvPreviewResult } from "../lib/api";

// Fetches an uploaded CSV artifact's bytes (GET /artifacts/:id/download) for
// inline preview. The bytes live in the upload table rather than inline
// `artifact.content`, so this is the only way to read them. The query is gated on
// a present artifact id (it is only ever mounted for the routed CSV-file case).
// The bytes are immutable for a given artifact version, so a long staleTime
// avoids refetching on remount. The size guard lives in `fetchCsvPreview`.
export function useArtifactCsvPreview(artifactId: string | undefined) {
  return useQuery<CsvPreviewResult>({
    queryKey: ["artifact-csv-preview", artifactId ?? null],
    queryFn: () =>
      fetchCsvPreview(
        `/artifacts/${artifactId}/download`,
        CSV_MAX_PREVIEW_BYTES,
      ),
    enabled: artifactId !== undefined && artifactId.length > 0,
    staleTime: 5 * 60_000,
  });
}
