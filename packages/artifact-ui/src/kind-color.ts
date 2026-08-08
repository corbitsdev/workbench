// Kind-colored gallery tiles: each artifact kind gets a stable background
// color so a grid of mixed kinds reads as distinct groups at a glance, the
// way the reference gallery's fill-per-kind cards do. The mapping is a hash
// over the kind string rather than a hand-maintained table, so a workflow
// that emits a brand-new kind still gets a consistent color instead of
// falling through to an "unknown" gray.

const PALETTE = [
  "bg-blue-500",
  "bg-emerald-500",
  "bg-amber-500",
  "bg-violet-500",
  "bg-rose-500",
  "bg-cyan-500",
] as const;

function hashKind(kind: string): number {
  let hash = 0;
  for (let index = 0; index < kind.length; index += 1) {
    hash = (hash * 31 + kind.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

/** The Tailwind background class a given artifact kind always gets. */
export function artifactKindColor(kind: string): string {
  const normalized = kind.trim().toLowerCase();
  const palette = PALETTE[hashKind(normalized) % PALETTE.length];
  return palette ?? "bg-muted";
}
