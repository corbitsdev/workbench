/// <reference types="bun" />
import { describe, expect, it } from 'bun:test';
import { getWorkflowUi } from './registry';
import { PresentationNewPane } from './presentation/PresentationNewPane';
import { PresentationSelectedPanel } from './presentation/PresentationSelectedPanel';

describe('workflow UI registry', () => {
  it('resolves the presentation-generation kind to its own package-owned panels', () => {
    const entry = getWorkflowUi('presentation-generation');
    expect(entry.NewPane).toBe(PresentationNewPane);
    expect(entry.SelectedPanel).toBe(PresentationSelectedPanel);
  });

  it('resolves collateral-generation to a distinct entry', () => {
    const collateral = getWorkflowUi('collateral-generation');
    const presentation = getWorkflowUi('presentation-generation');
    expect(collateral.SelectedPanel).not.toBe(presentation.SelectedPanel);
    expect(collateral.NewPane).not.toBe(presentation.NewPane);
  });

  it('throws loudly for an unregistered kind rather than guessing a fallback', () => {
    expect(() => getWorkflowUi('some-future-workflow')).toThrow(
      'No workflow UI registered for kind: some-future-workflow'
    );
  });
});
