import { AnimatePresence, motion, type Transition } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { AgentChat } from '../components/AgentChat';
import { WorkflowPanel } from '../components/WorkflowPanel';
import { NewWorkflowPane } from '../components/NewWorkflowPane';
import { PresentationGenerationWizard } from '@workbench/workflow';
import RecentCallsPicker from '../components/RecentCallsPicker';
import ArtifactSourcePicker from '../components/ArtifactSourcePicker';
import {
  useCreatePresentationWorkflow,
  useSubmitPresentationStep,
  useGeraltInstances,
  useGammaTemplates,
} from '../hooks/use-presentation-workflow';
import { LibraryRail } from '../components/layout/LibraryRail';
import { UnifiedCatalogModal } from '../components/layout/UnifiedCatalogModal';
import { ArtifactGallery } from '../components/layout/ArtifactGallery';
import { useResizableRail } from '@workbench/ui';
import { useMediaQuery } from '../lib/use-media-query';
import { deployAgentFromTemplate, getMe, listWorkbenches } from '../lib/hub-api';
import { useChatLauncher } from '../lib/chat-launcher-context';
import type { AgentSelection } from '../components/layout/LibraryRail';
import type { MeResponse, WorkbenchEntry } from '../lib/hub-api';

const ME_MAX_RETRIES = 10;

type ProvisioningState =
  | { status: 'loading' }
  | { status: 'needs-onboarding'; me: MeResponse }
  | { status: 'ready' }
  | { status: 'error'; message: string };

function useProvisioningGuard(): {
  state: ProvisioningState;
  retry: () => void;
} {
  const [state, setState] = useState<ProvisioningState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryCountRef = useRef(0);

  useEffect(() => {
    retryCountRef.current = 0;

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
          me.provisioned && me.paInstanceId
            ? { status: 'ready' }
            : { status: 'needs-onboarding', me }
        );
        clear();
      } catch {
        retryCountRef.current += 1;
        if (retryCountRef.current >= ME_MAX_RETRIES) {
          clear();
          setState({
            status: 'error',
            message: 'Could not reach the server. Check your connection and try again.',
          });
        }
      }
    }

    void check();
    intervalRef.current = setInterval(() => void check(), 3000);
    return clear;
  }, [attempt]);

  const retry = () => {
    setState({ status: 'loading' });
    setAttempt((n) => n + 1);
  };

  return { state, retry };
}

function OnboardingScreen({
  tenantId,
  tenantName,
  onComplete,
}: {
  tenantId: string | null;
  tenantName: string | null;
  onComplete: () => void;
}) {
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLaunch = async () => {
    if (!tenantId) return;
    setLaunching(true);
    setError(null);
    try {
      await deployAgentFromTemplate(tenantId, 'myra');
      onComplete();
    } catch {
      setError('Something went wrong. Please try again.');
      setLaunching(false);
    }
  };

  const buttonLabel = launching
    ? 'Launching…'
    : tenantName
      ? `Launch Myra and join the ${tenantName} team`
      : 'Launch Myra';

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 px-4">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <h1 className="text-[20px] font-semibold text-text">Welcome to Workbench</h1>
        <p className="text-[14px] leading-relaxed text-text-2">
          Myra is your personal agent — she gets smarter the more you work together and stays in
          context across everything you do.
        </p>
        {error && <p className="text-[13px] text-red-500">{error}</p>}
        <button
          type="button"
          disabled={launching || !tenantId}
          onClick={() => void handleLaunch()}
          className="mt-2 rounded-[9px] bg-orange px-5 py-2.5 text-[14px] font-medium text-white transition-opacity disabled:opacity-50"
        >
          {buttonLabel}
        </button>
      </div>
    </div>
  );
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

type NewModal = 'none' | 'catalog';

type RightPane =
  | { view: 'gallery' }
  | {
      view: 'agent';
      instanceId: string;
      tenantId: string;
      agentName: string;
    }
  | { view: 'workflow'; workflowId: string }
  | { view: 'new-workflow'; workflowKind: string };

function useWorkbenchContext(slug: string | undefined): {
  tenantId: string | null;
  workbenches: WorkbenchEntry[];
  loaded: boolean;
} {
  const [workbenches, setWorkbenches] = useState<WorkbenchEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Fetch the workbench list once at mount — slug changes do not re-fetch.
  useEffect(() => {
    listWorkbenches()
      .then((entries) => {
        setWorkbenches(entries);
      })
      .catch(() => {
        // non-fatal
      })
      .finally(() => {
        setLoaded(true);
      });
  }, []);

  // Derive the active tenantId from the already-loaded list whenever slug changes.
  const match = slug ? workbenches.find((entry) => entry.tenantSlug === slug) : undefined;
  const tenantId = (match ?? workbenches[0])?.tenantId ?? null;

  return { tenantId, workbenches, loaded };
}

export default function WorkbenchHome() {
  const { state: provisioningState, retry: retryProvisioning } = useProvisioningGuard();
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const { width, min, max, dragging, containerRef, handleProps } = useResizableRail();
  const [railOpen, setRailOpen] = useState(false);
  const [rightPane, setRightPane] = useState<RightPane>({ view: 'gallery' });
  const [activeModal, setActiveModal] = useState<NewModal>('none');
  const [agentRefreshTick, setAgentRefreshTick] = useState(0);
  const { slug } = useParams<{ slug?: string }>();
  const navigate = useNavigate();
  const { setHidden: setLauncherHidden, notifyProvisioned } = useChatLauncher();
  const createWorkflow = useCreatePresentationWorkflow();
  const submitStep = useSubmitPresentationStep();
  const geraltInstances = useGeraltInstances();
  const gammaTemplates = useGammaTemplates();
  const {
    tenantId: workbenchTenantId,
    workbenches,
    loaded: workbenchesLoaded,
  } = useWorkbenchContext(slug);

  // Auto-redirect from "/" to the first available workbench.
  useEffect(() => {
    if (!workbenchesLoaded || slug) return;
    const first = workbenches[0];
    if (first) void navigate(`/workbenches/${first.tenantSlug}`, { replace: true });
  }, [workbenchesLoaded, workbenches, slug, navigate]);

  if (provisioningState.status === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <p className="text-[14px] text-text-3">{provisioningState.message}</p>
        <button
          type="button"
          onClick={retryProvisioning}
          className="rounded-[9px] border border-border px-4 py-2 text-[13px] font-medium text-text-2 transition-colors hover:bg-surface hover:text-text"
        >
          Try again
        </button>
      </div>
    );
  }

  if (provisioningState.status === 'loading') {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[14px] text-text-3">Loading…</p>
      </div>
    );
  }

  if (provisioningState.status === 'needs-onboarding') {
    return (
      <OnboardingScreen
        tenantId={provisioningState.me.personalTenantId}
        tenantName={workbenches[0]?.tenantName ?? null}
        onComplete={() => {
          notifyProvisioned();
          retryProvisioning();
        }}
      />
    );
  }

  if (provisioningState.status === 'ready' && workbenchesLoaded && workbenches.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-[14px] text-text-2">
          You have not been provided access to any workbenches.
        </p>
        <p className="text-[13px] text-text-3">
          Please contact your administrator to request access.
        </p>
      </div>
    );
  }

  const handleWorkbenchSelect = (selectedSlug: string) => {
    void navigate(`/workbenches/${selectedSlug}`);
  };

  const handleAgentSelect = (selection: AgentSelection) => {
    setRightPane({ view: 'agent', ...selection });
    setLauncherHidden(true);
  };

  const handleWorkflowSelect = (workflowId: string) => {
    setRightPane({ view: 'workflow', workflowId });
    setLauncherHidden(true);
  };

  const handleNewWorkflow = () => {
    setActiveModal('catalog');
  };

  const handleWorkflowKindSelected = (kind: string) => {
    setActiveModal('none');
    setRightPane({ view: 'new-workflow', workflowKind: kind });
    setLauncherHidden(true);
  };

  const handleWorkflowCreated = (workflowId: string) => {
    setRightPane({ view: 'workflow', workflowId });
  };

  const handleAgentDeleted = () => {
    setAgentRefreshTick((n) => n + 1);
    setRightPane({ view: 'gallery' });
    setLauncherHidden(false);
  };

  const handleWorkflowDeleted = (workflowId: string) => {
    if (rightPane.view === 'workflow' && rightPane.workflowId === workflowId) {
      setRightPane({ view: 'gallery' });
      setLauncherHidden(false);
    }
  };

  const paneTransition: Transition = {
    duration: 0.15,
    ease: [0.23, 1, 0.32, 1],
  };
  const paneFade = {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: paneTransition,
  };

  function renderRightPane() {
    if (rightPane.view === 'agent') {
      return (
        <motion.div
          key={`agent-${rightPane.instanceId}`}
          {...paneFade}
          className="min-h-0 flex-1 overflow-hidden rounded-panel border border-border"
        >
          <AgentChat
            instanceId={rightPane.instanceId}
            tenantId={rightPane.tenantId}
            agentName={rightPane.agentName}
            onClose={() => {
              setRightPane({ view: 'gallery' });
              setLauncherHidden(false);
            }}
          />
        </motion.div>
      );
    }
    if (rightPane.view === 'workflow') {
      return (
        <motion.div
          key={`workflow-${rightPane.workflowId}`}
          {...paneFade}
          className="min-h-0 flex-1 overflow-hidden"
        >
          <WorkflowPanel
            workflowId={rightPane.workflowId}
            onClose={() => {
              setRightPane({ view: 'gallery' });
              setLauncherHidden(false);
            }}
          />
        </motion.div>
      );
    }
    if (rightPane.view === 'new-workflow') {
      const closeHandler = () => {
        setRightPane({ view: 'gallery' });
        setLauncherHidden(false);
      };
      return (
        <motion.div key="new-workflow" {...paneFade} className="min-h-0 flex-1 overflow-hidden">
          {rightPane.workflowKind === 'presentation-generation' ? (
            <PresentationGenerationWizard
              tenantId={workbenchTenantId}
              onCreated={handleWorkflowCreated}
              onClose={closeHandler}
              createWorkflow={createWorkflow}
              submitStep={submitStep}
              geraltInstances={geraltInstances}
              gammaTemplates={gammaTemplates}
              renderRecentPicker={({ onSelect, isLoading }) => (
                <RecentCallsPicker
                  onSelect={onSelect}
                  isLoading={isLoading}
                  tenantId={workbenchTenantId}
                  kind="presentation-generation"
                />
              )}
              renderArtifactPicker={({ onSelect, isLoading }) => (
                <ArtifactSourcePicker
                  onSelect={onSelect}
                  isLoading={isLoading}
                  tenantId={workbenchTenantId}
                />
              )}
            />
          ) : (
            <NewWorkflowPane
              workflowKind={rightPane.workflowKind}
              tenantId={workbenchTenantId}
              onCreated={handleWorkflowCreated}
              onClose={closeHandler}
            />
          )}
        </motion.div>
      );
    }
    return (
      <motion.div
        // key change forces remount when workbench resolves, refreshing the query
        key={`gallery-${workbenchTenantId ?? 'loading'}`}
        {...paneFade}
        className="min-h-0 flex-1"
      >
        <ArtifactGallery tenantId={workbenchTenantId} onNew={handleNewWorkflow} />
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
            onClose={() => {
              setRightPane({ view: 'gallery' });
              setLauncherHidden(false);
            }}
          />
        ) : rightPane.view === 'workflow' ? (
          <WorkflowPanel
            workflowId={rightPane.workflowId}
            onClose={() => {
              setRightPane({ view: 'gallery' });
              setLauncherHidden(false);
            }}
          />
        ) : rightPane.view === 'new-workflow' ? (
          rightPane.workflowKind === 'presentation-generation' ? (
            <PresentationGenerationWizard
              tenantId={workbenchTenantId}
              onCreated={handleWorkflowCreated}
              onClose={() => {
                setRightPane({ view: 'gallery' });
                setLauncherHidden(false);
              }}
              createWorkflow={createWorkflow}
              submitStep={submitStep}
              geraltInstances={geraltInstances}
              gammaTemplates={gammaTemplates}
              renderRecentPicker={({ onSelect, isLoading }) => (
                <RecentCallsPicker
                  onSelect={onSelect}
                  isLoading={isLoading}
                  tenantId={workbenchTenantId}
                  kind="presentation-generation"
                />
              )}
              renderArtifactPicker={({ onSelect, isLoading }) => (
                <ArtifactSourcePicker
                  onSelect={onSelect}
                  isLoading={isLoading}
                  tenantId={workbenchTenantId}
                />
              )}
            />
          ) : (
            <NewWorkflowPane
              workflowKind={rightPane.workflowKind}
              tenantId={workbenchTenantId}
              onCreated={handleWorkflowCreated}
              onClose={() => {
                setRightPane({ view: 'gallery' });
                setLauncherHidden(false);
              }}
            />
          )
        ) : (
          <ArtifactGallery
            tenantId={workbenchTenantId}
            onNew={handleNewWorkflow}
            onOpenLibrary={() => setRailOpen(true)}
          />
        )}
        {railOpen && (
          <div className="fixed inset-0 z-50 bg-page p-2">
            <LibraryRail
              onClose={() => setRailOpen(false)}
              onNew={() => setActiveModal('catalog')}
              onAgentSelect={handleAgentSelect}
              onWorkflowSelect={handleWorkflowSelect}
              onWorkbenchSelect={handleWorkbenchSelect}
              onAgentDeleted={handleAgentDeleted}
              onWorkflowDeleted={handleWorkflowDeleted}
              activeAgentInstanceId={rightPane.view === 'agent' ? rightPane.instanceId : undefined}
              activeWorkflowId={rightPane.view === 'workflow' ? rightPane.workflowId : undefined}
              activeWorkbenchSlug={slug}
              refreshTick={agentRefreshTick}
            />
          </div>
        )}
        <UnifiedCatalogModal
          open={activeModal === 'catalog'}
          tenantId={workbenchTenantId ?? null}
          onClose={() => setActiveModal('none')}
          onAgentDeployed={() => {
            setActiveModal('none');
            setAgentRefreshTick((n) => n + 1);
          }}
          onWorkflowSelected={handleWorkflowKindSelected}
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
            onNew={() => setActiveModal('catalog')}
            onAgentSelect={handleAgentSelect}
            onWorkflowSelect={handleWorkflowSelect}
            onWorkbenchSelect={handleWorkbenchSelect}
            onAgentDeleted={handleAgentDeleted}
            onWorkflowDeleted={handleWorkflowDeleted}
            activeAgentInstanceId={rightPane.view === 'agent' ? rightPane.instanceId : undefined}
            activeWorkflowId={rightPane.view === 'workflow' ? rightPane.workflowId : undefined}
            activeWorkbenchSlug={slug}
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
      <UnifiedCatalogModal
        open={activeModal === 'catalog'}
        tenantId={workbenchTenantId ?? null}
        onClose={() => setActiveModal('none')}
        onAgentDeployed={() => {
          setActiveModal('none');
          setAgentRefreshTick((n) => n + 1);
        }}
        onWorkflowSelected={handleWorkflowKindSelected}
      />
    </>
  );
}
