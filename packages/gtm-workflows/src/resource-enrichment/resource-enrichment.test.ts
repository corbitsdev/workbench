import { describe, expect, it } from 'bun:test';
import {
  CSV_EXPORT_ARTIFACT_KIND,
  PARSED_RESOURCE_ARTIFACT_KIND,
  SELECTION_ARTIFACT_KIND,
  buildSelectionArtifactContent,
  createSelectionArtifactDraft,
  parseSelectionArtifactContent,
  resourceEnrichmentWorkflow,
  setSelectionChosen,
} from './index';

const sampleFields = {
  Title: ['t1', 't2', 't3'],
  Description: ['d1', 'd2'],
};

describe('selection artifact content', () => {
  it('round-trips through build and parse', () => {
    const raw = buildSelectionArtifactContent({
      label: 'Row 1',
      imageLink: 'https://example.com/row-1.png',
      fields: sampleFields,
      chosen: null,
    });
    const parsed = parseSelectionArtifactContent(raw);
    expect(parsed.label).toBe('Row 1');
    expect(parsed.imageLink).toBe('https://example.com/row-1.png');
    expect(parsed.fields.Title).toEqual(['t1', 't2', 't3']);
    expect(parsed.chosen).toBeNull();
  });

  it('rejects malformed JSON', () => {
    expect(() => parseSelectionArtifactContent('not json')).toThrow();
  });

  it('rejects content missing required fields', () => {
    expect(() => parseSelectionArtifactContent(JSON.stringify({ label: 'x' }))).toThrow();
  });

  it('builds a draft of selection kind with chosen null', () => {
    const draft = createSelectionArtifactDraft({ label: 'Row 1', fields: sampleFields });
    expect(draft.kind).toBe(SELECTION_ARTIFACT_KIND);
    expect(draft.title).toBe('Row 1');
    const parsed = parseSelectionArtifactContent(draft.content);
    expect(parsed.chosen).toBeNull();
  });
});

describe('setSelectionChosen', () => {
  it('writes chosen indices into the content', () => {
    const raw = buildSelectionArtifactContent({
      label: 'Row 1',
      imageLink: 'https://example.com/row-1.png',
      fields: sampleFields,
      chosen: null,
    });
    const updated = setSelectionChosen(raw, { Title: 1, Description: 0 });
    expect(parseSelectionArtifactContent(updated).chosen).toEqual({ Title: 1, Description: 0 });
  });

  it('rejects an unknown field', () => {
    const raw = buildSelectionArtifactContent({
      label: 'Row 1',
      imageLink: 'https://example.com/row-1.png',
      fields: sampleFields,
      chosen: null,
    });
    expect(() => setSelectionChosen(raw, { Missing: 0 })).toThrow();
  });

  it('rejects an out-of-range index', () => {
    const raw = buildSelectionArtifactContent({
      label: 'Row 1',
      imageLink: 'https://example.com/row-1.png',
      fields: sampleFields,
      chosen: null,
    });
    expect(() => setSelectionChosen(raw, { Description: 5 })).toThrow();
  });
});

describe('resourceEnrichmentWorkflow base definition', () => {
  it('declares the four resource-enrichment steps in order', () => {
    expect(resourceEnrichmentWorkflow.kind).toBe('resource-enrichment');
    expect(resourceEnrichmentWorkflow.steps.map((s) => s.name)).toEqual([
      'intake',
      'enrich',
      'review',
      'export',
    ]);
  });

  it('maps lifecycle statuses to steps and throws on unknown', () => {
    const derive = resourceEnrichmentWorkflow.deriveCurrentStep;
    if (!derive) throw new Error('deriveCurrentStep missing');
    expect(derive('pending')).toBe('intake');
    expect(derive('running')).toBe('enrich');
    expect(derive('generating')).toBe('enrich');
    expect(derive('reviewing')).toBe('review');
    expect(derive('done')).toBe('export');
    expect(() => derive('bogus')).toThrow();
  });

  it('derives step completion from artifacts by kind', () => {
    const serialize = resourceEnrichmentWorkflow.serializeStepState;
    if (!serialize) throw new Error('serializeStepState missing');
    const chosenSelection = buildSelectionArtifactContent({
      label: 'Row 1',
      fields: sampleFields,
      chosen: { Title: 0, Description: 0 },
    });
    const state = serialize({
      status: 'reviewing',
      input: {},
      painPoints: [],
      artifacts: [
        { kind: PARSED_RESOURCE_ARTIFACT_KIND, status: 'approved' },
        { kind: SELECTION_ARTIFACT_KIND, status: 'draft', content: chosenSelection },
      ],
    });
    expect(state.intake.completed).toBe(true);
    expect(state.enrich.completed).toBe(true);
    expect(state.review.completed).toBe(true);
    expect(state.export.completed).toBe(false);
  });

  it('exposes the csv-export kind constant', () => {
    expect(CSV_EXPORT_ARTIFACT_KIND).toBe('csv-export');
  });
});
