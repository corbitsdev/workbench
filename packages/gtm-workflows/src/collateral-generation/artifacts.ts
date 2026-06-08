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
  { id: 'pain-points-linkedin-post', label: 'Pain Points LinkedIn Post' },
  { id: 'pain-points-twitter-post', label: 'Pain Points Twitter Post' },
  { id: 'pain-points-blog', label: 'Pain Points Blog' },
  { id: 'founder-pov-post', label: 'Founder POV Post' },
  { id: 'follow-up-email', label: 'Follow-up Email' },
  { id: 'sales-one-pager', label: 'Sales One-Pager' },
  { id: 'battlecard', label: 'Battlecard' },
  { id: 'case-study-draft', label: 'Case Study Draft' },
  { id: 'objection-handling-doc', label: 'Objection Handling Doc' },
  { id: 'customer-quote-pulls', label: 'Customer Quote Pulls' },
] as const;

const defaultCollateralTypeIds = [
  'follow-up-email',
  'pain-points-linkedin-post',
  'sales-one-pager',
  'battlecard',
] as const;

export function selectCollateralTypeIds(requested: string[] | undefined): string[] {
  const allowed = new Set(collateralTypeOptions.map((option) => option.id));
  const selected = requested?.filter((id) =>
    allowed.has(id as (typeof collateralTypeOptions)[number]['id'])
  );
  return selected && selected.length > 0 ? selected : [...defaultCollateralTypeIds];
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
