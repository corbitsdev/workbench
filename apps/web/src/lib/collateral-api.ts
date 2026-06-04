import { api } from './api';
import type {
  ArtifactsResponse,
  CollateralGenerationWorkflow,
  CreateCollateralGenerationRequest,
  OutputType,
} from '@workbench/shared';

export type {
  OutputType,
  GeneratedArtifact,
  CollateralGenerationWorkflow,
} from '@workbench/shared';

export const OUTPUT_TYPES: OutputType[] = ['case-study', 'one-pager', 'email-draft'];

export const OUTPUT_TYPE_LABELS: Record<OutputType, string> = {
  'case-study': 'Case Study',
  'one-pager': 'One-Pager',
  'email-draft': 'Email Draft',
};

export async function createCollateralGeneration(
  inputArtifactIds: string[],
  outputTypes: OutputType[]
): Promise<{ id: string; status: string }> {
  const body: CreateCollateralGenerationRequest = {
    kind: 'collateral-generation',
    inputArtifactIds,
    outputTypes,
  };
  return api('POST', 'collateral-generation', body);
}

export async function getCollateralGeneration(id: string): Promise<CollateralGenerationWorkflow> {
  return api('GET', `collateral-generation/${id}`);
}

export async function getArtifacts(): Promise<ArtifactsResponse> {
  return api('GET', 'artifacts');
}
