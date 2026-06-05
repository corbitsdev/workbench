import { AnimatePresence } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { CollateralGenerationPanel } from '../components/CollateralGenerationPanel';
import { LibraryRail } from '../components/layout/LibraryRail';
import { NewWorkbenchModal } from '../components/layout/NewWorkbenchModal';
import { NewAgentModal } from '../components/layout/NewAgentModal';
import { ArtifactGallery } from '../components/layout/ArtifactGallery';
import { useResizableRail } from '@workbench/ui';
import { useMediaQuery } from '../lib/use-media-query';
import { getMe, listWorkbenches } from '../lib/hub-api';
import type { ProvisionAgentResponse } from '../lib/hub-api';

type ProvisioningState =
  | { status: 'loading' }
  | { status: 'needs-onboarding' }
  | { status: 'ready'; personalTenantId: string | null };

function useProvisioningGuard(): ProvisioningState {
  const [state, setState] = useState<ProvisioningState>({ status: 'loading' });
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    function clear() {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }

    async function check() {
      try {
        const me = await getMe();
        if (!me.provisioned) return; // Keep polling until personal tenant is ready
        const workbenches = await listWorkbenches();
        if (workbenches.length === 0) {
          setState({ status: 'needs-onboarding' });
        } else {
          setState({ status: 'ready', personalTenantId: me.personalTenantId });
        }
        clear();
      } catch {
        // Keep polling — transient errors should not break the guard
      }
    }

    void check();
    intervalRef.current = setInterval(() => void check(), 3000);
    return clear;
  }, []);

  return state;
}

/**
 * Workbench home. Full-bleed, mobile-responsive layout.
 *
 * Desktop (lg+): resizable two-pane grid (library rail | handle | gallery).
 * The grid is the page scroll container; the rail and handle are sticky at
 * full viewport height while the gallery scrolls with the natural page scroll.
 *
 * Mobile (<lg): single-column gallery with natural scroll; the library opens
 * as a full-screen overlay from a button in the gallery header.
 *
 * The right pane toggles between the artifact gallery and the inline
 * collateral-generation panel — no route change, sidebar and Ada remain visible.
 */
const RAIL_HEIGHT = 'h-full';

// Controls which "New" modal is open.
type NewModal = 'none' | 'workbench' | 'agent';

function useFirstWorkspaceTenantId(): string | null {
  const [tenantId, setTenantId] = useState<string | null>(null);

  useEffect(() => {
    listWorkbenches()
      .then((entries) => {
        const first = entries[0];
        if (first) setTenantId(first.tenantId);
      })
      .catch(() => {
        // non-fatal
      });
  }, []);

  return tenantId;
}

export default function WorkbenchHome() {
  const provisioningState = useProvisioningGuard();
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const { width, min, max, dragging, containerRef, handleProps } = useResizableRail();
  const [railOpen, setRailOpen] = useState(false);
  const [showGenPanel, setShowGenPanel] = useState(false);
  const [activeModal, setActiveModal] = useState<NewModal>('none');
  const workspaceTenantId = useFirstWorkspaceTenantId();
  const navigate = useNavigate();

  useEffect(() => {
    if (provisioningState.status === 'needs-onboarding') {
      void navigate('/onboarding', { replace: true });
    }
  }, [provisioningState, navigate]);

  if (provisioningState.status === 'loading' || provisioningState.status === 'needs-onboarding') {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[14px] text-text-3">Setting up your workspace…</p>
      </div>
    );
  }

  const { personalTenantId } = provisioningState;

  const handleWorkbenchCreated = (slug: string) => {
    setActiveModal('none');
    void navigate(`/workbenches/${slug}`);
  };

  const handleAgentCreated = (_response: ProvisionAgentResponse) => {
    setActiveModal('none');
  };

  // The "+ New" button in the LibraryRail "Workbenches & agents" section
  // opens the agent modal by default (the more common creation path once
  // workspaces exist). If no workspace exists, fall back to the workbench modal.
  const handleNew = () => {
    setActiveModal('agent');
  };

  if (!isDesktop) {
    return (
      <div className="h-full overflow-y-auto px-2 pb-10 pt-1">
        {showGenPanel ? (
          <CollateralGenerationPanel onClose={() => setShowGenPanel(false)} />
        ) : (
          <ArtifactGallery
            onNew={() => setShowGenPanel(true)}
            onOpenLibrary={() => setRailOpen(true)}
          />
        )}
        {railOpen && (
          <div className="fixed inset-0 z-50 bg-page p-2">
            <LibraryRail onClose={() => setRailOpen(false)} onNew={handleNew} />
          </div>
        )}
        <NewWorkbenchModal
          open={activeModal === 'workbench'}
          onClose={() => setActiveModal('none')}
          onCreated={handleWorkbenchCreated}
        />
        <NewAgentModal
          open={activeModal === 'agent'}
          onClose={() => setActiveModal('none')}
          onCreated={handleAgentCreated}
          workspaceTenantId={workspaceTenantId}
          personalTenantId={personalTenantId}
        />
      </div>
    );
  }

  return (
    <>
      <div
        ref={containerRef}
        className={`grid h-full gap-0 overflow-y-auto px-2 pb-10 pt-1 ${dragging ? 'select-none' : ''}`}
        style={{ gridTemplateColumns: `${width}px 16px 1fr` }}
      >
        <div className={`sticky top-0 self-start ${RAIL_HEIGHT}`}>
          <LibraryRail onNew={handleNew} />
        </div>

        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panels"
          aria-valuenow={width}
          aria-valuemin={min}
          aria-valuemax={max}
          tabIndex={0}
          className={`group sticky top-0 flex cursor-col-resize touch-none items-center justify-center self-start ${RAIL_HEIGHT}`}
          {...handleProps}
        >
          <div
            className={`w-[5px] rounded-full bg-border-strong transition-all duration-300 ease-spring group-hover:bg-orange group-focus:bg-orange ${
              dragging ? 'h-20 bg-orange' : 'h-[46px] group-hover:h-20'
            }`}
          />
        </div>

        <AnimatePresence mode="wait">
          {showGenPanel ? (
            <CollateralGenerationPanel key="gen-panel" onClose={() => setShowGenPanel(false)} />
          ) : (
            <ArtifactGallery key="gallery" onNew={() => setShowGenPanel(true)} />
          )}
        </AnimatePresence>
      </div>
      <NewWorkbenchModal
        open={activeModal === 'workbench'}
        onClose={() => setActiveModal('none')}
        onCreated={handleWorkbenchCreated}
      />
      <NewAgentModal
        open={activeModal === 'agent'}
        onClose={() => setActiveModal('none')}
        onCreated={handleAgentCreated}
        workspaceTenantId={workspaceTenantId}
        personalTenantId={personalTenantId}
      />
    </>
  );
}
