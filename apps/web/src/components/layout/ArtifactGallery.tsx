// Thin data wrapper around the stateless @workbench/artifact gallery. This is
// the only place the gallery is bound to transport: it fetches artifacts via
// @workbench/client and passes the array + flags into the package component.
// Presentation, layout, and tile mapping all live in @workbench/artifact.

import { useRef, useState } from 'react';
import { useArtifacts, useTenantMembers } from '@workbench/client/react';
import { ArtifactGallery as ArtifactGalleryView, ArtifactModal } from '@workbench/artifact';
import type { GalleryArtifact, ArtifactWithSession } from '@workbench/artifact';
import { clientOptions } from '../../lib/client-options';
import ArtifactBody from '../ArtifactBody';
import { resolveKindLabel } from '../../lib/resolve-kind-label';
import { canUseArtifactInWorkflow } from '@workbench/artifact';
import { useChatLauncher } from '../../lib/chat-launcher-context';

const SEARCH_DEBOUNCE_MS = 300;

interface ArtifactGalleryProps {
  /** Active workbench tenant. Null means workbench context is still loading. */
  tenantId?: string | null;
  /** Bridge to the working intake flow (real Dashboard) until CL-988/Phase 4 wires it natively. */
  onNew?: () => void;
  /** When provided, renders a mobile-only control to open the library overlay. */
  onOpenLibrary?: () => void;
  /** Open the workflow catalog seeded with this artifact (owned by the page). */
  onUseInWorkflow?: (artifact: ArtifactWithSession) => void;
  /**
   * When provided, opening an artifact calls this (e.g. navigate to a full-page
   * artifact view) instead of the built-in preview modal.
   */
  onOpenArtifact?: (artifact: ArtifactWithSession) => void;
}

// Hand the agent a reference, not the body: it loads the current content via
// the artifact_read tool, so the chat message stays small and never goes stale.
export function buildArtifactMessage(artifact: ArtifactWithSession, tenantId?: string): string {
  if (artifact.id === '') {
    throw new Error('Cannot reference an artifact with an empty id');
  }
  const tenantClause = tenantId ? ` in tenant ${tenantId}` : '';
  return `I'd like to work with the artifact ${JSON.stringify(artifact.title)} (id: ${artifact.id}${tenantClause}). Load it with artifact_read before responding.`;
}

export function ArtifactGallery({
  tenantId,
  onNew,
  onOpenLibrary,
  onUseInWorkflow,
  onOpenArtifact,
}: ArtifactGalleryProps) {
  const { openWithMessage } = useChatLauncher();
  const [inputQuery, setInputQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest');
  const [ownerFilter, setOwnerFilter] = useState<string | undefined>(undefined);

  const {
    data: artifacts,
    isLoading,
    isError,
  } = useArtifacts(clientOptions, {
    tenantId,
    query: debouncedQuery || undefined,
    sort,
    ownerPrincipalId: ownerFilter,
  });

  const { data: members } = useTenantMembers(clientOptions, { tenantId });

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
    if (onOpenArtifact && full) {
      onOpenArtifact(full);
      return;
    }
    setSelected(full);
  };

  function handleOpenInMyra(artifact: ArtifactWithSession) {
    if (artifact.id === '') {
      throw new Error('Cannot open an artifact with an empty id in Myra');
    }
    openWithMessage(buildArtifactMessage(artifact, tenantId ?? undefined));
    setSelected(null);
  }

  function handleUseInWorkflow(artifact: ArtifactWithSession) {
    onUseInWorkflow?.(artifact);
    setSelected(null);
  }

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
        sort={sort}
        onSortChange={setSort}
        ownerPrincipalId={ownerFilter}
        onOwnerFilterChange={setOwnerFilter}
        owners={members}
      />
      <ArtifactModal
        open={selected !== null}
        artifact={selected}
        onClose={() => setSelected(null)}
        kindLabel={selected ? resolveKindLabel(selected.kind) : undefined}
        onOpenInMyra={handleOpenInMyra}
        onUseInWorkflow={onUseInWorkflow ? handleUseInWorkflow : undefined}
        canUseInWorkflow={(a) => canUseArtifactInWorkflow(a.kind)}
      >
        {selected && <ArtifactBody artifact={selected} />}
      </ArtifactModal>
    </>
  );
}
