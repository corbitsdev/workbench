import { useQuery } from "@tanstack/react-query";
import { CSV_MAX_PREVIEW_BYTES } from "@workbench/artifact";
import { fetchCsvPreview, type CsvPreviewResult } from "../lib/api";

// Fetches an uploaded CSV artifact's bytes (GET /artifacts/:id/download) for
// inline preview. The bytes live in the upload table rather than inline
// `artifact.content`, so this is the only way to read them. Gated with `enabled`
// so it fires only for the CSV-file case, never on every artifact open. The
// bytes are immutable for a given artifact version, so a long staleTime avoids
// refetching on remount. Content-type and size guards live in `fetchCsvPreview`
// so the returned result is already discriminated for the viewer.
export function useArtifactCsvPreview(
  artifactId: string | undefined,
  enabled: boolean,
) {
  return useQuery<CsvPreviewResult>({
    queryKey: ["artifact-csv-preview", artifactId ?? null],
    queryFn: () =>
      fetchCsvPreview(
        `/artifacts/${artifactId}/download`,
        CSV_MAX_PREVIEW_BYTES,
      ),
    enabled: enabled && artifactId !== undefined && artifactId.length > 0,
    staleTime: 5 * 60_000,
  });
}
