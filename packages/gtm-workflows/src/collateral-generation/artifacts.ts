export interface CollateralPainPoint {
  severity: string;
  context: string;
  quote: string;
}

export interface WorkflowArtifactDraft {
  kind: string;
  title: string;
  content: string;
  status?: 'draft' | 'approved' | 'rejected';
  version?: number;
}

export const collateralTypeOptions = [
  { id: 'linkedin-post', label: 'LinkedIn Post' },
  { id: 'linkedin-daily', label: 'LinkedIn Daily (3 Drafts)' },
  { id: 'twitter-post', label: 'Twitter Post' },
  { id: 'blog', label: 'Blog' },
  { id: 'founder-pov-post', label: 'Founder POV Post' },
  { id: 'email', label: 'Follow-up Email' },
  { id: 'one-pager', label: 'Sales One-Pager' },
  { id: 'battlecard', label: 'Battlecard' },
  { id: 'case-study', label: 'Case Study' },
  { id: 'objection-handling', label: 'Objection Handling' },
  { id: 'customer-quotes', label: 'Customer Quotes' },
] as const;

type CollateralTypeId = (typeof collateralTypeOptions)[number]['id'];

const MULTI_VARIANT_KINDS: Partial<Record<CollateralTypeId, number>> = {
  'linkedin-daily': 3,
};

export function getVariantCount(kind: string): number {
  return MULTI_VARIANT_KINDS[kind as CollateralTypeId] ?? 1;
}

export function hasMultiVariantKind(artifacts: { kind: string }[]): boolean {
  return artifacts.some((a) => getVariantCount(a.kind) > 1);
}

export function appendVariantSuffix(
  collateral: { title: string; body: string },
  kind: string,
  variantIndex: number
): { title: string; body: string } {
  if (getVariantCount(kind) <= 1) return collateral;
  return { ...collateral, title: `${collateral.title} — Draft ${variantIndex + 1}` };
}

const BOOKKEEPING_KINDS = new Set(['call-transcript', 'pain-points']);

export function isCollateralKind(kind: string): boolean {
  return !BOOKKEEPING_KINDS.has(kind);
}

export function selectCollateralTypeIds(requested: string[] | undefined): string[] {
  const allowed = new Set(collateralTypeOptions.map((option) => option.id));
  return (requested ?? []).filter((id) =>
    allowed.has(id as (typeof collateralTypeOptions)[number]['id'])
  );
}

export function deriveCollateralRunTitle(
  input: Record<string, unknown> | undefined
): string | null {
  const companyName = typeof input?.companyName === 'string' ? input.companyName.trim() : '';
  if (companyName) return companyName;
  const callTitle = typeof input?.callTitle === 'string' ? input.callTitle.trim() : '';
  if (callTitle) return callTitle;
  return null;
}

export function createTranscriptArtifacts({
  content,
  callTitle,
}: {
  content: string;
  callTitle?: string | undefined;
}): WorkflowArtifactDraft[] {
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

export function formatPainPointsDocument(points: CollateralPainPoint[]): string {
  if (points.length === 0) return 'No pain points extracted.';

  return points
    .map(
      (point, index) =>
        `## ${index + 1}. ${point.context}\n\n- Severity: ${point.severity}\n- Quote: "${point.quote}"`
    )
    .join('\n\n');
}

export function createPainPointArtifacts({
  points,
  companyName,
  runTitle,
}: {
  points: CollateralPainPoint[];
  companyName?: string | null | undefined;
  runTitle?: string | null | undefined;
}): WorkflowArtifactDraft[] {
  return [
    {
      kind: 'pain-points',
      title: `Pain Points — ${companyName || runTitle || 'Call'}`,
      content: formatPainPointsDocument(points),
      status: 'approved',
      version: 1,
    },
  ];
}
