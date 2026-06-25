import { type } from "arktype";

// The canonical ArtifactKind union, kept for documentation. NOT used to gate
// the artifact parse: ArtifactBody renders a superset of these (legacy/variant
// kinds like 'follow-up-email', 'linkedin', 'sales-one-pager') via its default
// branch, so validating `kind` against this union would silently drop
// renderable artifacts. The boundary parser must not be stricter than the
// renderer — `kind` is validated only as a string below.
export const artifactKindSchema = type(
  "'email' | 'linkedin-post' | 'twitter-post' | 'blog' | 'founder-pov-post' | 'one-pager' | 'case-study' | 'objection-handling' | 'customer-quotes' | 'battlecard' | 'pain-points' | 'call-transcript' | 'presentation'",
);

export const painPointSchema = type({
  id: "string",
  context: "string",
  quote: "string",
  "severity?": "'low' | 'medium' | 'high' | 'critical'",
  "selected?": "boolean",
});

export const workflowArtifactSchema = type({
  id: "string",
  kind: "string",
  title: "string",
  content: "string",
  status: "string",
  "source?": "unknown",
});

export type ParsedPainPoint = typeof painPointSchema.infer;
export type ParsedWorkflowArtifact = typeof workflowArtifactSchema.infer;

// Parse an unknown list, dropping items that fail validation rather than
// throwing — a single malformed item must not blank the whole panel.
export function parsePainPoints(value: unknown): ParsedPainPoint[] {
  if (!Array.isArray(value)) return [];
  const valid: ParsedPainPoint[] = [];
  for (const item of value) {
    const result = painPointSchema(item);
    if (result instanceof type.errors) continue;
    valid.push(result);
  }
  return valid;
}

export function parseWorkflowArtifacts(
  value: unknown,
): ParsedWorkflowArtifact[] {
  if (!Array.isArray(value)) return [];
  const valid: ParsedWorkflowArtifact[] = [];
  for (const item of value) {
    const result = workflowArtifactSchema(item);
    if (result instanceof type.errors) continue;
    valid.push(result);
  }
  return valid;
}
