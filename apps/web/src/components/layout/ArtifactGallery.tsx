// Thin data wrapper around the stateless @workbench/artifact gallery. This is
// the only place the gallery is bound to transport: it fetches artifacts via
// @workbench/client and passes the array + flags into the package component.
// Presentation, layout, and tile mapping all live in @workbench/artifact.

import { useState } from 'react';
import { useArtifacts } from '@workbench/client/react';
import { ArtifactGallery as ArtifactGalleryView, ArtifactModal } from '@workbench/artifact';
import type { GalleryArtifact, ArtifactWithSession } from '@workbench/artifact';
import { clientOptions } from '../../lib/client-options';

interface ArtifactGalleryProps {
  /** Active workspace tenant. Null means workspace context is still loading. */
  tenantId?: string | null;
  /** Bridge to the working intake flow (real Dashboard) until CL-988/Phase 4 wires it natively. */
  onNew?: () => void;
  /** When provided, renders a mobile-only control to open the library overlay. */
  onOpenLibrary?: () => void;
}

export function ArtifactGallery({ tenantId, onNew, onOpenLibrary }: ArtifactGalleryProps) {
  const { data: artifacts, isLoading, isError } = useArtifacts(clientOptions, { tenantId });
  const [selected, setSelected] = useState<ArtifactWithSession | null>(null);

  const handleOpen = (gallery: GalleryArtifact) => {
    const full = (artifacts ?? []).find((a) => a.id === gallery.id) ?? null;
    setSelected(full);
  };

  return (
    <>
      <ArtifactGalleryView
        artifacts={artifacts ?? []}
        isLoading={isLoading}
        isError={isError}
        onOpen={handleOpen}
        onNew={onNew}
        onOpenLibrary={onOpenLibrary}
      />
      <ArtifactModal
        open={selected !== null}
        artifact={selected}
        onClose={() => setSelected(null)}
      />
    </>
  );
}
