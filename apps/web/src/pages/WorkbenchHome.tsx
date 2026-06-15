import { AnimatePresence, motion, type Transition } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { AgentChat } from '../components/AgentChat';
import { ErrorBoundary } from '../components/ErrorBoundary';
import {
  getWorkflowUi,
  type WorkflowNewPaneProps,
  type WorkflowSelectedPanelProps,
} from '../workflows/registry';
import { LibraryRail } from '../components/layout/LibraryRail';
import { UnifiedCatalogModal } from '../components/layout/UnifiedCatalogModal';
import { ArtifactGallery } from '../components/layout/ArtifactGallery';
import type { ArtifactWithSession } from '@workbench/artifact';
import { useResizableRail } from '@workbench/ui';
import { useMediaQuery } from '../lib/use-media-query';
import { deployAgentFromTemplate, getMe } from '../lib/hub-api';
import { useWorkbenches } from '../hooks/use-workbenches';
import { useRightPane } from '../hooks/use-right-pane';
import { useWorkflow } from '../hooks/use-workflow';
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

function useWorkbenchContext(slug: string | undefined): {
  tenantId: string | null;
  workbenches: WorkbenchEntry[];
  loaded: boolean;
} {
  const { data, isSuccess, isError } = useWorkbenches();
  const workbenches = data ?? [];
  const loaded = isSuccess || isError;

  // Derive the active tenantId from the loaded list whenever slug changes.
  const match = slug ? workbenches.find((entry) => entry.tenantSlug === slug) : undefined;
  const tenantId = (match ?? workbenches[0])?.tenantId ?? null;

  return { tenantId, workbenches, loaded };
}

// Resolve the workflow's package-owned UI from the registry. The page renders
// these generically — no workflow-kind branching lives here. The selected
// panel derives its kind from the loaded workflow, not a navigation prop.
function SelectedWorkflowView({ workflowId, onClose, onOpenAgent }: WorkflowSelectedPanelProps) {
  const { data: workflow, isError } = useWorkflow(workflowId);
  if (isError) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[13px] text-text-3">Could not load workflow.</p>
      </div>
    );
  }
  if (!workflow) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[13px] text-text-3">Loading workflow…</p>
      </div>
    );
  }
  const { SelectedPanel } = getWorkflowUi(workflow.kind);
  return <SelectedPanel workflowId={workflowId} onClose={onClose} onOpenAgent={onOpenAgent} />;
}

function NewWorkflowView(props: WorkflowNewPaneProps) {
  const { NewPane } = getWorkflowUi(props.workflowKind);
  return <NewPane {...props} />;
}

export default function WorkbenchHome() {
  const { state: provisioningState, retry: retryProvisioning } = useProvisioningGuard();
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const { width, min, max, dragging, containerRef, handleProps } = useResizableRail();
  const [railOpen, setRailOpen] = useState(false);
  const [activeModal, setActiveModal] = useState<NewModal>('none');
  // When the catalog is opened from an artifact ("Use in Workflow"), this holds
  // the source artifact so the catalog can filter to accepting workflows and
  // the chosen workflow's intake is seeded with its content.
  const [workflowArtifact, setWorkflowArtifact] = useState<ArtifactWithSession | null>(null);
  const [agentRefreshTick, setAgentRefreshTick] = useState(0);
  const { slug } = useParams<{ slug?: string }>();
  const navigate = useNavigate();
  const { setHidden: setLauncherHidden, notifyProvisioned } = useChatLauncher();
  const {
    rightPane,
    showGallery,
    showAgent,
    showWorkflow,
    showNewWorkflow,
    promoteCreatedWorkflow,
    closeWorkflow,
  } = useRightPane({
    onShow: () => setLauncherHidden(true),
    onClose: () => setLauncherHidden(false),
  });
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
    showAgent(selection);
  };

  const handleWorkflowSelect = (workflowId: string) => {
    showWorkflow(workflowId);
  };

  const handleNewWorkflow = () => {
    setWorkflowArtifact(null);
    setActiveModal('catalog');
  };

  const handleUseArtifactInWorkflow = (artifact: ArtifactWithSession) => {
    setWorkflowArtifact(artifact);
    setActiveModal('catalog');
  };

  const handleCatalogClose = () => {
    setActiveModal('none');
    setWorkflowArtifact(null);
  };

  const handleWorkflowKindSelected = (kind: string) => {
    setActiveModal('none');
    showNewWorkflow(kind, workflowArtifact?.id);
    setWorkflowArtifact(null);
  };

  const handleWorkflowCreated = (workflowId: string) => {
    promoteCreatedWorkflow(workflowId);
  };

  const handleAgentDeleted = () => {
    setAgentRefreshTick((n) => n + 1);
    showGallery();
  };

  const handleWorkflowDeleted = (workflowId: string) => {
    closeWorkflow(workflowId);
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
              showGallery();
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
          <SelectedWorkflowView
            workflowId={rightPane.workflowId}
            onOpenAgent={handleAgentSelect}
            onClose={showGallery}
          />
        </motion.div>
      );
    }
    if (rightPane.view === 'new-workflow') {
      return (
        <motion.div key="new-workflow" {...paneFade} className="min-h-0 flex-1 overflow-hidden">
          <NewWorkflowView
            workflowKind={rightPane.workflowKind}
            tenantId={workbenchTenantId}
            onCreated={handleWorkflowCreated}
            onClose={showGallery}
            {...(rightPane.seedArtifactId ? { seedArtifactId: rightPane.seedArtifactId } : {})}
          />
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
        <ArtifactGallery
          tenantId={workbenchTenantId}
          onNew={handleNewWorkflow}
          onUseInWorkflow={handleUseArtifactInWorkflow}
        />
      </motion.div>
    );
  }

  // Identity of the currently-rendered pane. Used as the ErrorBoundary `key` so
  // navigating to a different pane remounts the boundary and clears a stale
  // error fallback, instead of the new pane staying hidden behind it.
  function getPaneKey(): string {
    if (rightPane.view === 'agent') return `agent-${rightPane.instanceId}`;
    if (rightPane.view === 'workflow') return `workflow-${rightPane.workflowId}`;
    return rightPane.view;
  }
  const paneKey = getPaneKey();

  if (!isDesktop) {
    return (
      <div className="h-full overflow-y-auto px-2 pb-10 pt-1">
        <ErrorBoundary key={paneKey} onReset={() => showGallery()}>
          {rightPane.view === 'agent' ? (
            <AgentChat
              instanceId={rightPane.instanceId}
              tenantId={rightPane.tenantId}
              agentName={rightPane.agentName}
              onClose={() => {
                showGallery();
              }}
            />
          ) : rightPane.view === 'workflow' ? (
            <SelectedWorkflowView
              workflowId={rightPane.workflowId}
              onOpenAgent={handleAgentSelect}
              onClose={showGallery}
            />
          ) : rightPane.view === 'new-workflow' ? (
            <NewWorkflowView
              workflowKind={rightPane.workflowKind}
              tenantId={workbenchTenantId}
              onCreated={handleWorkflowCreated}
              onClose={showGallery}
              {...(rightPane.seedArtifactId ? { seedArtifactId: rightPane.seedArtifactId } : {})}
            />
          ) : (
            <ArtifactGallery
              tenantId={workbenchTenantId}
              onNew={handleNewWorkflow}
              onOpenLibrary={() => setRailOpen(true)}
              onUseInWorkflow={handleUseArtifactInWorkflow}
            />
          )}
        </ErrorBoundary>
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
          onClose={handleCatalogClose}
          onAgentDeployed={() => {
            setActiveModal('none');
            setAgentRefreshTick((n) => n + 1);
          }}
          onWorkflowSelected={handleWorkflowKindSelected}
          artifactKind={workflowArtifact?.kind ?? null}
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

        <ErrorBoundary key={paneKey} onReset={() => showGallery()}>
          <AnimatePresence mode="wait">{renderRightPane()}</AnimatePresence>
        </ErrorBoundary>
      </div>
      <UnifiedCatalogModal
        open={activeModal === 'catalog'}
        tenantId={workbenchTenantId ?? null}
        onClose={handleCatalogClose}
        onAgentDeployed={() => {
          setActiveModal('none');
          setAgentRefreshTick((n) => n + 1);
        }}
        onWorkflowSelected={handleWorkflowKindSelected}
        artifactKind={workflowArtifact?.kind ?? null}
      />
    </>
  );
}
