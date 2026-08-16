// Shared by kind-filter.ts and renderer-kind.ts: both need a title's file
// extension to fall back on when an artifact's `kind` is the generic
// "file" bucket rather than a typed kind like "document" or "pdf".

export function titleExtension(title: string): string {
  const lower = title.trim().toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot <= 0 || dot === lower.length - 1) return "";
  return lower.slice(dot + 1);
}
