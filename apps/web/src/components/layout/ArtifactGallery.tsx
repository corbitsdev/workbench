// Thin data wrapper around the stateless @workbench/artifact gallery. This is
// the only place the gallery is bound to transport: it fetches artifacts via
// @workbench/client and passes the array + flags into the package component.
// Presentation, layout, and tile mapping all live in @workbench/artifact.

import { useRef, useState } from 'react';
import { useArtifacts } from '@workbench/client/react';
import { ArtifactGallery as ArtifactGalleryView, ArtifactModal } from '@workbench/artifact';
import type { GalleryArtifact, ArtifactWithSession } from '@workbench/artifact';
import { clientOptions } from '../../lib/client-options';
import ArtifactBody from '../ArtifactBody';
import { collateralTypeOptions } from '@workbench/gtm-workflows';

const SEARCH_DEBOUNCE_MS = 300;

interface ArtifactGalleryProps {
  /** Active workbench tenant. Null means workbench context is still loading. */
  tenantId?: string | null;
  /** Bridge to the working intake flow (real Dashboard) until CL-988/Phase 4 wires it natively. */
  onNew?: () => void;
  /** When provided, renders a mobile-only control to open the library overlay. */
  onOpenLibrary?: () => void;
}

export function ArtifactGallery({ tenantId, onNew, onOpenLibrary }: ArtifactGalleryProps) {
  const [inputQuery, setInputQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const {
    data: artifacts,
    isLoading,
    isError,
  } = useArtifacts(clientOptions, {
    tenantId,
    query: debouncedQuery || undefined,
  });
  const [selected, setSelected] = useState<ArtifactWithSession | null>(null);

  const handleQueryChange = (value: string) => {
    setInputQuery(value);
    if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      setDebouncedQuery(value);
    }, SEARCH_DEBOUNCE_MS);
  };

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
        query={inputQuery}
        onQueryChange={handleQueryChange}
        onOpen={handleOpen}
        onNew={onNew}
        onOpenLibrary={onOpenLibrary}
      />
      <ArtifactModal
        open={selected !== null}
        artifact={selected}
        onClose={() => setSelected(null)}
        kindLabel={
          selected
            ? (collateralTypeOptions.find((o) => o.id === selected.kind)?.label ?? selected.kind)
            : undefined
        }
      >
        {selected && <ArtifactBody body={selected.content} type={selected.kind} />}
      </ArtifactModal>
    </>
  );
}
