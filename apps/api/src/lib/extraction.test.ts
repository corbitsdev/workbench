import { describe, expect, it } from 'bun:test';
import { extractPainPoints, extractPainPointsWithLLM } from './extraction';

describe('extractPainPoints', () => {
  it('falls back to keyword extraction when no LLM is configured', async () => {
    const points = await extractPainPoints(
      'wf-1',
      'It is frustrating that everything is manual and slow. We waste so much time.'
    );
    expect(points.length).toBeGreaterThan(0);
    const first = points[0];
    if (!first) throw new Error('Expected at least one pain point');
    expect(first.severity).toBe('high');
    expect(typeof first.context).toBe('string');
    expect(typeof first.quote).toBe('string');
  });

  it('deduplicates similar pain points', async () => {
    const points = await extractPainPoints(
      'wf-1',
      'It is frustrating. It is frustrating. It is frustrating.'
    );
    expect(points.length).toBe(1);
  });

  it('limits to 5 pain points', async () => {
    const longText = Array.from(
      { length: 20 },
      (_, i) =>
        `Line ${i}: it is frustrating and slow and difficult and painful and wasteful and challenging and manual and generic and never works.`
    ).join('\n');
    const points = await extractPainPoints('wf-1', longText);
    expect(points.length).toBeLessThanOrEqual(5);
  });

  it('accepts feedback to refine extraction', async () => {
    const points = await extractPainPoints(
      'wf-1',
      'It is frustrating that everything is manual.',
      'focus on automation'
    );
    expect(points.length).toBeGreaterThan(0);
    const first = points[0];
    if (!first) throw new Error('Expected at least one pain point');
    expect(first.sessionId).toBe('wf-1');
  });
});

describe('extractPainPointsWithLLM', () => {
  it('returns empty array when LLM is not configured', async () => {
    const points = await extractPainPointsWithLLM('wf-1', 'Test transcript', undefined);
    expect(points.length).toBe(0);
  });
});
