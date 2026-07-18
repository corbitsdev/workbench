// The single mapping from an upload's MIME type to the artifact `kind` that
// controls how it renders. Shared by every route that stores a MIME-typed
// upload as an artifact (direct upload, imported/parsed documents) so an
// image never silently falls back to the bare-download "file" kind in one
// path while rendering inline in another.
export function uploadArtifactKind(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "image";
  return "file";
}
