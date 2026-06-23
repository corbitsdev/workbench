import { toHumanLabel } from '@workbench/ui';

// Humanize a raw workflow/artifact kind for display.
export function resolveKindLabel(kind: string | null | undefined): string | undefined {
  if (!kind) return undefined;
  return toHumanLabel(kind);
}
