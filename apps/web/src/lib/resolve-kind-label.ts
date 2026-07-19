import { toHumanLabel } from "@workbench/ui";
import { explicitVisualForKind } from "@workbench/artifact";

// The gallery card chip and this detail-page label must always agree, so
// this defers to @workbench/artifact's kind→label vocabulary (the same table
// that drives the card chip) rather than keeping a second, independently
// maintained override map. Only a kind with no explicit entry there falls
// back to the generic humanizer.
export function resolveKindLabel(
  kind: string | null | undefined,
): string | undefined {
  if (!kind) return undefined;
  return explicitVisualForKind(kind)?.label ?? toHumanLabel(kind);
}
