import { describe, expect, it } from 'bun:test';
import { serializePainPoint, serializeArtifact } from './workflow';
import type { PainPointRow, ArtifactRow } from './workflow';

describe('serializePainPoint', () => {
  it('maps DB fields to the API shape and renames sessionId to workflowId', () => {
    const created = new Date('2024-01-02T03:04:05.000Z');
    const row = {
      id: 'pp-1',
      sessionId: 'wf-1',
      severity: 'high',
      context: 'Manual entry',
      quote: 'It takes hours',
      selected: true,
      createdAt: created,
    } as unknown as PainPointRow;

    const out = serializePainPoint(row);

    expect(out).toEqual({
      id: 'pp-1',
      workflowId: 'wf-1',
      severity: 'high',
      context: 'Manual entry',
      quote: 'It takes hours',
      selected: true,
      createdAt: '2024-01-02T03:04:05.000Z',
    });
  });

  it('passes through a string createdAt unchanged', () => {
    const row = {
      id: 'pp-2',
      sessionId: 'wf-2',
      severity: 'low',
      context: 'c',
      quote: 'q',
      selected: false,
      createdAt: '2024-05-05T00:00:00.000Z',
    } as unknown as PainPointRow;

    expect(serializePainPoint(row).createdAt).toBe('2024-05-05T00:00:00.000Z');
  });
});

describe('serializeArtifact', () => {
  it('maps DB fields, defaults nullable refs to null, and ISO-formats dates', () => {
    const created = new Date('2024-01-02T03:04:05.000Z');
    const updated = new Date('2024-02-03T04:05:06.000Z');
    const row = {
      id: 'a-1',
      sessionId: 'wf-1',
      parentId: null,
      painPointId: null,
      kind: 'one-pager',
      title: 'Title',
      content: 'Body',
      status: 'draft',
      version: 1,
      createdAt: created,
      updatedAt: updated,
    } as unknown as ArtifactRow;

    const out = serializeArtifact(row);

    expect(out).toEqual({
      id: 'a-1',
      sessionId: 'wf-1',
      parentId: null,
      painPointId: null,
      kind: 'one-pager',
      title: 'Title',
      content: 'Body',
      status: 'draft',
      version: 1,
      createdAt: '2024-01-02T03:04:05.000Z',
      updatedAt: '2024-02-03T04:05:06.000Z',
    });
  });

  it('preserves parentId and painPointId when present', () => {
    const row = {
      id: 'a-2',
      sessionId: 'wf-2',
      parentId: 'a-1',
      painPointId: 'pp-1',
      kind: 'email',
      title: 't',
      content: 'c',
      status: 'approved',
      version: 2,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    } as unknown as ArtifactRow;

    const out = serializeArtifact(row);
    expect(out.parentId).toBe('a-1');
    expect(out.painPointId).toBe('pp-1');
  });
});
