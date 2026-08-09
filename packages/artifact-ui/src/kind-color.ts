// Kind-colored gallery tiles: each artifact kind gets a stable background
// drawn from the Corbits chart token series so light/dark (and preset
// overlays) stay on-brand. The mapping is a hash over the kind string
// rather than a hand-maintained table, so a workflow that emits a brand-new
// kind still gets a consistent color instead of falling through to muted.

const PALETTE = [
  "bg-[var(--chart-1)]",
  "bg-[var(--chart-2)]",
  "bg-[var(--chart-3)]",
  "bg-[var(--chart-4)]",
  "bg-[var(--chart-5)]",
  "bg-muted",
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
