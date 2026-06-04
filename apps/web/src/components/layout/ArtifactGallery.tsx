// Thin data wrapper around the stateless @workbench/artifact gallery. This is
// the only place the gallery is bound to transport: it fetches artifacts via
// @workbench/client and passes the array + flags into the package component.
// Presentation, layout, and tile mapping all live in @workbench/artifact.

import { useArtifacts } from '@workbench/client/react';
import { ArtifactGallery as ArtifactGalleryView } from '@workbench/artifact';
import { clientOptions } from '../../lib/client-options';

interface ArtifactGalleryProps {
  /** Bridge to the working intake flow (real Dashboard) until CL-988/Phase 4 wires it natively. */
  onNew?: () => void;
  /** When provided, renders a mobile-only control to open the library overlay. */
  onOpenLibrary?: () => void;
}

export function ArtifactGallery({ onNew, onOpenLibrary }: ArtifactGalleryProps) {
  const { data: artifacts, isLoading, isError } = useArtifacts(clientOptions);

  return (
    <ArtifactGalleryView
      artifacts={artifacts ?? []}
      isLoading={isLoading}
      isError={isError}
      {...(onNew ? { onNew } : {})}
      {...(onOpenLibrary ? { onOpenLibrary } : {})}
    />
  );
}
