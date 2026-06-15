import type { InferSelectModel } from 'drizzle-orm';
import { painPoint, artifact } from '../db/schema';

export type PainPointRow = InferSelectModel<typeof painPoint>;
export type ArtifactRow = InferSelectModel<typeof artifact>;

export function serializePainPoint(p: PainPointRow) {
  return {
    id: p.id,
    workflowId: p.sessionId,
    severity: p.severity,
    context: p.context,
    quote: p.quote,
    selected: p.selected,
    createdAt:
      typeof p.createdAt === 'string'
        ? p.createdAt
        : (p.createdAt?.toISOString?.() ?? new Date().toISOString()),
  };
}

export function serializeArtifact(a: ArtifactRow) {
  return {
    id: a.id,
    sessionId: a.sessionId,
    parentId: a.parentId ?? null,
    painPointId: a.painPointId ?? null,
    kind: a.kind,
    title: a.title,
    content: a.content,
    status: a.status,
    version: a.version,
    createdAt:
      typeof a.createdAt === 'string'
        ? a.createdAt
        : (a.createdAt?.toISOString?.() ?? new Date().toISOString()),
    updatedAt:
      typeof a.updatedAt === 'string'
        ? a.updatedAt
        : (a.updatedAt?.toISOString?.() ?? new Date().toISOString()),
  };
}
