import { AnimatePresence, motion, type Transition } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { AgentChat } from '../components/AgentChat';
import { LibraryRail } from '../components/layout/LibraryRail';
import { NewWorkbenchModal } from '../components/layout/NewWorkbenchModal';
import { NewAgentModal } from '../components/layout/NewAgentModal';
import { ArtifactGallery } from '../components/layout/ArtifactGallery';
import { useResizableRail } from '@workbench/ui';
import { useMediaQuery } from '../lib/use-media-query';
import { getMe, listWorkbenches } from '../lib/hub-api';
import type { AgentSelection } from '../components/layout/LibraryRail';
import type { ProvisionAgentResponse } from '../lib/hub-api';

type ProvisioningState =
  | { status: 'loading' }
  | { status: 'needs-onboarding' }
  | { status: 'ready' };

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
        setState(
          me.provisioned && me.paInstanceId ? { status: 'ready' } : { status: 'needs-onboarding' }
        );
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
 * The right pane toggles between: artifact gallery, collateral-generation
 * panel, or agent chat — no route change.
 */
const RAIL_HEIGHT = 'h-full';

type NewModal = 'none' | 'workbench' | 'agent';

type RightPane =
  | { view: 'gallery' }
  | { view: 'agent'; instanceId: string; tenantId: string; agentName: string };

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
  const [rightPane, setRightPane] = useState<RightPane>({ view: 'gallery' });
  const [activeModal, setActiveModal] = useState<NewModal>('none');
  const [agentRefreshTick, setAgentRefreshTick] = useState(0);
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
        <p className="text-[14px] text-text-3">Setting up your workbench…</p>
      </div>
    );
  }

  const handleWorkbenchCreated = (slug: string) => {
    setActiveModal('none');
    void navigate(`/workbenches/${slug}`);
  };

  const handleAgentCreated = (_response: ProvisionAgentResponse) => {
    setActiveModal('none');
    setAgentRefreshTick((n) => n + 1);
  };

  const handleNew = () => {
    setActiveModal('agent');
  };

  const handleAgentSelect = (selection: AgentSelection) => {
    setRightPane({ view: 'agent', ...selection });
  };

  const paneTransition: Transition = { duration: 0.15, ease: [0.23, 1, 0.32, 1] };
  const paneFade = {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: paneTransition,
  };

  function renderRightPane() {
    if (rightPane.view === 'agent') {
      return (
        <motion.div key={`agent-${rightPane.instanceId}`} {...paneFade} className="min-h-0 flex-1">
          <AgentChat
            instanceId={rightPane.instanceId}
            tenantId={rightPane.tenantId}
            agentName={rightPane.agentName}
            onClose={() => setRightPane({ view: 'gallery' })}
          />
        </motion.div>
      );
    }
    return (
      <motion.div key="gallery" {...paneFade} className="min-h-0 flex-1">
        <ArtifactGallery />
      </motion.div>
    );
  }

  if (!isDesktop) {
    return (
      <div className="h-full overflow-y-auto px-2 pb-10 pt-1">
        {rightPane.view === 'agent' ? (
          <AgentChat
            instanceId={rightPane.instanceId}
            tenantId={rightPane.tenantId}
            agentName={rightPane.agentName}
            onClose={() => setRightPane({ view: 'gallery' })}
          />
        ) : (
          <ArtifactGallery onOpenLibrary={() => setRailOpen(true)} />
        )}
        {railOpen && (
          <div className="fixed inset-0 z-50 bg-page p-2">
            <LibraryRail
              onClose={() => setRailOpen(false)}
              onNew={handleNew}
              onAgentSelect={handleAgentSelect}
              refreshTick={agentRefreshTick}
            />
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
          <LibraryRail
            onNew={handleNew}
            onAgentSelect={handleAgentSelect}
            refreshTick={agentRefreshTick}
          />
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
            className={`w-[5px] rounded-full bg-border-strong transition-[background-color,height] duration-200 ease-out group-hover:bg-orange group-focus:bg-orange ${
              dragging ? 'h-20 bg-orange' : 'h-[46px] group-hover:h-20'
            }`}
          />
        </div>

        <AnimatePresence mode="wait">{renderRightPane()}</AnimatePresence>
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
      />
    </>
  );
}
