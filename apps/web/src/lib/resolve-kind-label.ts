import { toHumanLabel } from "@workbench/ui";

// Kinds whose humanized form would read wrong (acronyms, casing) get an explicit
// label; everything else falls back to the generic humanizer.
const KIND_LABEL_OVERRIDES: Record<string, string> = {
  "ab-comparison": "A/B Comparison",
};

// Humanize a raw workflow/artifact kind for display.
export function resolveKindLabel(
  kind: string | null | undefined,
): string | undefined {
  if (!kind) return undefined;
  return KIND_LABEL_OVERRIDES[kind] ?? toHumanLabel(kind);
}
