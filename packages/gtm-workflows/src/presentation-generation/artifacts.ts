import type { WorkflowArtifactDraft } from '@workbench/workflow-core';

export function derivePresentationRunTitle(
  input: Record<string, unknown> | undefined
): string | null {
  const companyName = typeof input?.companyName === 'string' ? input.companyName.trim() : '';
  if (companyName) return companyName;
  const callTitle = typeof input?.callTitle === 'string' ? input.callTitle.trim() : '';
  if (callTitle) return callTitle;
  const artifactTitle = typeof input?.artifactTitle === 'string' ? input.artifactTitle.trim() : '';
  if (artifactTitle) return artifactTitle;
  return null;
}

export function createPresentationIntakeArtifacts({
  content,
  callTitle,
  transcriptSource,
}: {
  content: string;
  callTitle?: string;
  transcriptSource: 'granola' | 'paste' | 'artifact';
}): WorkflowArtifactDraft[] {
  if (transcriptSource === 'artifact') return [];
  return [
    {
      kind: 'call-transcript',
      title: `Transcript — ${callTitle?.trim() || 'Call'}`,
      content,
      status: 'approved',
      version: 1,
    },
  ];
}
