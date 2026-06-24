import { AnimatePresence, motion, type Transition } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useArtifacts } from '@workbench/client/react';
import { clientOptions } from '../lib/client-options';
import { AgentChat } from '../components/AgentChat';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { WorkflowRunPane } from '../components/WorkflowRunPane';
import { LibraryRail } from '../components/layout/LibraryRail';
import { UnifiedCatalogModal } from '../components/layout/UnifiedCatalogModal';
import { ArtifactGallery } from '../components/layout/ArtifactGallery';
import type { ArtifactWithSession } from '@workbench/artifact';
import { useResizableRail } from '@workbench/ui';
import { useMediaQuery } from '../lib/use-media-query';
import { useRightPane } from '../hooks/use-right-pane';
import { useChatLauncher } from '../lib/chat-launcher-context';
import { useActiveWorkbench } from '../lib/active-workbench-context';
import type { AgentSelection } from '../components/layout/LibraryRail';

const RAIL_HEIGHT = 'h-full';

type NewModal = 'none' | 'catalog';

/**
 * The workbench surface — artifacts, the library rail, and workspace agents —
 * scoped to the globally-selected workbench (the sidebar's workbench toggle owns
 * tenancy; this page just reads it). Replaces the former `/workbenches/:slug`
 * page now that chat is the home.
 */
export function ArtifactsPage() {
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const { width, min, max, dragging, containerRef, handleProps } = useResizableRail();
  const [railOpen, setRailOpen] = useState(false);
  const [activeModal, setActiveModal] = useState<NewModal>('none');
  // When the catalog is opened from an artifact ("Use in Workflow"), this holds
  // the source artifact so the catalog can filter to accepting workflows.
  const [workflowArtifact, setWorkflowArtifact] = useState<ArtifactWithSession | null>(null);
  const [agentRefreshTick, setAgentRefreshTick] = useState(0);
  const { setHidden: setLauncherHidden } = useChatLauncher();
  const { rightPane, showGallery, showAgent, showWorkflow } = useRightPane({
    onShow: () => setLauncherHidden(true),
    onClose: () => setLauncherHidden(false),
  });

  const {
    workbenches,
    loading: workbenchesLoading,
    activeWorkbench,
    activeTenantId,
    setActiveWorkbench,
  } = useActiveWorkbench();
  const workbenchTenantId = activeTenantId;
  const activeSlug = activeWorkbench?.tenantSlug;

  const [searchParams, setSearchParams] = useSearchParams();
  const artifactIdFromURL = searchParams.get('artifactId');

  const { data: artifactsForURL, isSuccess: artifactsLoaded } = useArtifacts(clientOptions, {
    tenantId: workbenchTenantId,
    enabled: !!workbenchTenantId && !!artifactIdFromURL,
  });

  const handledArtifactIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!artifactIdFromURL || !artifactsForURL) return;
    if (handledArtifactIdRef.current === artifactIdFromURL) return;

    const artifact = artifactsForURL.find((a) => a.id === artifactIdFromURL);
    handledArtifactIdRef.current = artifactIdFromURL;

    if (artifact) {
      setWorkflowArtifact(artifact);
      setActiveModal('catalog');
    }

    if (artifactsLoaded) {
      setSearchParams(
        (params) => {
          const next = new URLSearchParams(params);
          next.delete('artifactId');
          return next;
        },
        { replace: true }
      );
    }
  }, [artifactIdFromURL, artifactsForURL, artifactsLoaded, setSearchParams]);

  if (workbenchesLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[14px] text-text-3">Loading…</p>
      </div>
    );
  }

  if (workbenches.length === 0) {
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
    const wb = workbenches.find((entry) => entry.tenantSlug === selectedSlug);
    if (wb) setActiveWorkbench(wb.id);
  };

  const handleAgentSelect = (selection: AgentSelection) => showAgent(selection);
  const handleWorkflowSelect = (deploymentId: string) => showWorkflow(deploymentId);

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

  const handleWorkflowStarted = (deploymentId: string) => {
    setActiveModal('none');
    setWorkflowArtifact(null);
    showWorkflow(deploymentId);
  };

  const handleAgentDeleted = () => {
    setAgentRefreshTick((n) => n + 1);
    showGallery();
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
        <motion.div
          key={`agent-${rightPane.instanceId}`}
          {...paneFade}
          className="min-h-0 flex-1 overflow-hidden rounded-panel border border-border"
        >
          <AgentChat
            instanceId={rightPane.instanceId}
            tenantId={rightPane.tenantId}
            agentName={rightPane.agentName}
            onClose={showGallery}
          />
        </motion.div>
      );
    }
    if (rightPane.view === 'workflow') {
      return (
        <motion.div
          key={`workflow-${rightPane.deploymentId}`}
          {...paneFade}
          className="min-h-0 flex-1 overflow-hidden rounded-panel border border-border bg-surface"
        >
          <WorkflowRunPane
            deploymentId={rightPane.deploymentId}
            tenantId={workbenchTenantId}
            onClose={showGallery}
          />
        </motion.div>
      );
    }
    return (
      <motion.div
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

  function getPaneKey(): string {
    if (rightPane.view === 'agent') return `agent-${rightPane.instanceId}`;
    if (rightPane.view === 'workflow') return `workflow-${rightPane.deploymentId}`;
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
              onClose={showGallery}
            />
          ) : rightPane.view === 'workflow' ? (
            <WorkflowRunPane
              deploymentId={rightPane.deploymentId}
              tenantId={workbenchTenantId}
              onClose={showGallery}
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
              activeAgentInstanceId={rightPane.view === 'agent' ? rightPane.instanceId : undefined}
              activeWorkflowId={rightPane.view === 'workflow' ? rightPane.deploymentId : undefined}
              activeWorkbenchSlug={activeSlug}
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
          onWorkflowStarted={handleWorkflowStarted}
          defaultTab={workflowArtifact ? 'workflows' : 'agents'}
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
            activeAgentInstanceId={rightPane.view === 'agent' ? rightPane.instanceId : undefined}
            activeWorkflowId={rightPane.view === 'workflow' ? rightPane.deploymentId : undefined}
            activeWorkbenchSlug={activeSlug}
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
        onWorkflowStarted={handleWorkflowStarted}
        defaultTab={workflowArtifact ? 'workflows' : 'agents'}
      />
    </>
  );
}
