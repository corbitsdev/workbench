import { useQuery } from "@tanstack/react-query";
import { apiText } from "../lib/api";

// Fetches an artifact's raw downloadable text (GET /artifacts/:id/download).
// Used by the uploaded-CSV viewer, whose bytes live in the upload table rather
// than inline `artifact.content`. Gated with `enabled` so it only fires for the
// CSV-file case, never on every artifact open. The bytes are immutable for a
// given artifact version, so a long staleTime avoids refetching on remount.
export function useArtifactDownloadText(
  artifactId: string | undefined,
  enabled: boolean,
) {
  return useQuery<string>({
    queryKey: ["artifact-download-text", artifactId ?? null],
    queryFn: () => apiText("GET", `/artifacts/${artifactId}/download`),
    enabled: enabled && artifactId !== undefined && artifactId.length > 0,
    staleTime: 5 * 60_000,
  });
}
