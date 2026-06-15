import { collateralTypeOptions } from '@workbench/gtm-workflows';
import { toHumanLabel } from '@workbench/ui';

// Prefer the curated label; fall back to a humanized version of the raw kind.
export function resolveKindLabel(kind: string | null | undefined): string | undefined {
  if (!kind) return undefined;
  return collateralTypeOptions.find((o) => o.id === kind)?.label ?? toHumanLabel(kind);
}
