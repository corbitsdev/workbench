import { PresentationGenerationWizard } from '@workbench/workflow';
import RecentCallsPicker from '../../components/RecentCallsPicker';
import ArtifactSourcePicker from '../../components/ArtifactSourcePicker';
import {
  useCreatePresentationWorkflow,
  useSubmitPresentationStep,
  useGeraltInstances,
  useGammaTemplates,
} from '../../hooks/use-presentation-workflow';
import type { WorkflowNewPaneProps } from '../registry';

// Self-contained creation pane for presentation-generation. Owns every
// presentation-specific hook so the page never has to.
export function PresentationNewPane({
  tenantId,
  onCreated,
  onClose,
  seedArtifactId,
}: WorkflowNewPaneProps) {
  const createWorkflow = useCreatePresentationWorkflow();
  const submitStep = useSubmitPresentationStep();
  const geraltInstances = useGeraltInstances();
  const gammaTemplates = useGammaTemplates();

  return (
    <PresentationGenerationWizard
      tenantId={tenantId}
      onCreated={onCreated}
      onClose={onClose}
      createWorkflow={createWorkflow}
      submitStep={submitStep}
      geraltInstances={geraltInstances}
      gammaTemplates={gammaTemplates}
      {...(seedArtifactId ? { seedArtifactId } : {})}
      renderRecentPicker={({ onSelect, isLoading }) => (
        <RecentCallsPicker
          onSelect={onSelect}
          isLoading={isLoading}
          tenantId={tenantId}
          kind="presentation-generation"
        />
      )}
      renderArtifactPicker={({ onSelect, isLoading }) => (
        <ArtifactSourcePicker
          onSelect={onSelect}
          isLoading={isLoading}
          tenantId={tenantId}
          {...(seedArtifactId ? { initialSelectedId: seedArtifactId } : {})}
        />
      )}
    />
  );
}
