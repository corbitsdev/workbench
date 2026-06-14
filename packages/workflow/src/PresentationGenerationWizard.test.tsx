/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';
import { PresentationGenerationWizard } from './PresentationGenerationWizard';
import type { PresentationSourceData } from './PresentationGenerationWizard';

afterEach(cleanup);

mock.module('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  motion: {
    div: ({ children, className }: { children: React.ReactNode; className?: string }) =>
      React.createElement('div', { className }, children),
    form: ({
      children,
      className,
      onSubmit,
    }: {
      children: React.ReactNode;
      className?: string;
      onSubmit?: React.FormEventHandler;
    }) => React.createElement('form', { className, onSubmit }, children),
  },
}));

function makeMutation<T>(result: T) {
  return {
    isPending: false,
    mutateAsync: mock(async () => result),
  };
}

function makeProps(overrides: Partial<Parameters<typeof PresentationGenerationWizard>[0]> = {}) {
  return {
    onCreated: mock(() => {}),
    onClose: mock(() => {}),
    tenantId: 'tenant-1',
    createWorkflow: makeMutation({
      id: 'wf-1',
      status: 'pending',
      kind: 'presentation-generation',
    }),
    submitStep: makeMutation({ status: 'ok' }),
    geraltInstances: { isLoading: false, data: [{ id: 'inst-1', agentName: 'Geralt' }] },
    gammaTemplates: {
      isLoading: false,
      isError: false,
      data: [
        { gammaId: 'tmpl-1', name: 'Sales Deck', description: 'A sales template' },
        { gammaId: 'tmpl-2', name: 'Investor Pitch', description: null },
      ],
    },
    renderRecentPicker: mock(
      ({ onSelect }: { onSelect: (d: PresentationSourceData) => void; isLoading: boolean }) =>
        React.createElement(
          'button',
          {
            type: 'button',
            onClick: () => onSelect({ source: 'paste', transcript: 'recent transcript' }),
          },
          'Pick recent'
        )
    ),
    ...overrides,
  };
}

function submitForm() {
  const form = document.querySelector('form');
  if (!form) throw new Error('No form found');
  fireEvent.submit(form);
}

async function advanceToStep(targetText: string | RegExp, fn: () => void) {
  await act(async () => {
    fn();
  });
  await waitFor(() => expect(screen.queryByText(targetText, { exact: false })).not.toBeNull());
}

describe('PresentationGenerationWizard', () => {
  describe('Template step', () => {
    it('renders the template step with Auto and fetched templates', () => {
      render(<PresentationGenerationWizard {...makeProps()} />);
      expect(screen.getByText('Auto')).toBeDefined();
      expect(screen.getByText('Sales Deck')).toBeDefined();
      expect(screen.getByText('Investor Pitch')).toBeDefined();
    });

    it('shows loading state while templates are fetching', () => {
      render(
        <PresentationGenerationWizard
          {...makeProps({
            gammaTemplates: { isLoading: true, isError: false, data: undefined },
          })}
        />
      );
      expect(screen.getByText('Loading templates…')).toBeDefined();
    });

    it('shows error state when Gamma credential is not configured', () => {
      render(
        <PresentationGenerationWizard
          {...makeProps({
            gammaTemplates: { isLoading: false, isError: true, data: undefined },
          })}
        />
      );
      expect(screen.getByText(/Could not load templates/)).toBeDefined();
    });

    it('selects a template by clicking it', () => {
      render(<PresentationGenerationWizard {...makeProps()} />);
      fireEvent.click(screen.getByText('Sales Deck'));
      const radio = screen
        .getAllByRole('radio')
        .find((el) => el.getAttribute('aria-checked') === 'true');
      expect(radio).toBeDefined();
    });

    it('advances to brief step without calling any mutation', async () => {
      const props = makeProps();
      render(<PresentationGenerationWizard {...props} />);
      await advanceToStep('Describe the presentation goal.', () => submitForm());
      expect(props.createWorkflow.mutateAsync).not.toHaveBeenCalled();
      expect(props.submitStep.mutateAsync).not.toHaveBeenCalled();
    });

    it('selects a template via the Enter key', async () => {
      const props = makeProps();
      render(<PresentationGenerationWizard {...props} />);
      const salesDeckRadio = screen.getByText('Sales Deck').closest('[role="radio"]');
      if (!salesDeckRadio) throw new Error('template radio not found');
      fireEvent.keyDown(salesDeckRadio, { key: 'Enter' });
      expect(salesDeckRadio.getAttribute('aria-checked')).toBe('true');
      await advanceToStep('Describe the presentation goal.', () => submitForm());
      await advanceToStep('Choose the source for this presentation.', () => submitForm());
      expect(props.submitStep.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ templateId: 'tmpl-1' })
      );
    });
  });

  describe('Brief step', () => {
    async function renderAtBrief(props = makeProps()) {
      render(<PresentationGenerationWizard {...props} />);
      await advanceToStep('Describe the presentation goal.', () => submitForm());
      return props;
    }

    it('shows audience, tone, and goal fields', async () => {
      await renderAtBrief();
      expect(screen.getByPlaceholderText('e.g. Enterprise CTOs')).toBeDefined();
      expect(screen.getByText('Formal')).toBeDefined();
      expect(screen.getByPlaceholderText('e.g. Close the deal')).toBeDefined();
    });

    it('shows a Back button that returns to the template step', async () => {
      await renderAtBrief();
      await advanceToStep('Auto', () => fireEvent.click(screen.getByText('Back')));
    });

    it('calls createWorkflow then submitStep with template args on Continue', async () => {
      const props = await renderAtBrief(makeProps());
      fireEvent.change(screen.getByPlaceholderText('e.g. Enterprise CTOs'), {
        target: { value: 'Startup founders' },
      });
      await advanceToStep('Choose the source for this presentation.', () => submitForm());
      expect(props.createWorkflow.mutateAsync).toHaveBeenCalledTimes(1);
      expect(props.submitStep.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          step: 'template',
          workflowId: 'wf-1',
          audience: 'Startup founders',
        })
      );
    });

    it('includes templateId when a specific template is selected from the list', async () => {
      const props = makeProps();
      render(<PresentationGenerationWizard {...props} />);
      fireEvent.click(screen.getByText('Sales Deck'));
      await advanceToStep('Describe the presentation goal.', () => submitForm());
      await advanceToStep('Choose the source for this presentation.', () => submitForm());
      expect(props.submitStep.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ templateId: 'tmpl-1' })
      );
    });

    it('omits templateId when Auto is selected', async () => {
      const props = await renderAtBrief(makeProps());
      await advanceToStep('Choose the source for this presentation.', () => submitForm());
      const calls = (props.submitStep.mutateAsync as ReturnType<typeof mock>).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const call = calls[0]![0] as Record<string, unknown>;
      expect('templateId' in call).toBe(false);
    });

    it('shows error message when createWorkflow fails', async () => {
      await renderAtBrief(
        makeProps({
          createWorkflow: {
            isPending: false,
            mutateAsync: mock(async () => {
              throw new Error('Network error');
            }),
          },
        })
      );
      await act(async () => {
        submitForm();
      });
      await waitFor(() =>
        expect(screen.queryByText('Network error', { exact: false })).not.toBeNull()
      );
    });
  });

  describe('Source step', () => {
    async function renderAtSource(props = makeProps()) {
      render(<PresentationGenerationWizard {...props} />);
      await advanceToStep('Describe the presentation goal.', () => submitForm());
      await advanceToStep('Choose the source for this presentation.', () => submitForm());
      return props;
    }

    it('shows Recent and Paste mode tabs', async () => {
      await renderAtSource();
      expect(screen.getByText('Recent')).toBeDefined();
      expect(screen.getByText('Paste')).toBeDefined();
    });

    it('renders the recent picker via render prop', async () => {
      await renderAtSource();
      expect(screen.getByText('Pick recent')).toBeDefined();
    });

    it('hides the Artifact tab when no artifact picker is provided', async () => {
      await renderAtSource();
      expect(screen.queryByText('Artifact')).toBeNull();
    });

    it('submits source step with a selected artifact', async () => {
      const props = await renderAtSource(
        makeProps({
          renderArtifactPicker: ({ onSelect }) =>
            React.createElement(
              'button',
              {
                type: 'button',
                onClick: () =>
                  onSelect({
                    source: 'artifact',
                    sourceArtifactId: 'art-1',
                    callTitle: 'Acme Pain Points',
                  }),
              },
              'Pick artifact'
            ),
        })
      );
      await act(async () => {
        fireEvent.click(screen.getByText('Artifact'));
      });
      await act(async () => {
        fireEvent.click(screen.getByText('Pick artifact'));
      });
      await waitFor(() =>
        expect(props.submitStep.mutateAsync).toHaveBeenLastCalledWith(
          expect.objectContaining({
            step: 'source',
            transcriptSource: 'artifact',
            sourceArtifactId: 'art-1',
          })
        )
      );
    });

    it('submits source step with paste transcript', async () => {
      const props = await renderAtSource();
      await act(async () => {
        fireEvent.click(screen.getByText('Paste'));
      });
      fireEvent.change(
        screen.getByPlaceholderText('Speaker 1: Thanks for taking the time today...'),
        { target: { value: 'Speaker 1: Here is a long enough transcript to pass validation.' } }
      );
      await act(async () => {
        submitForm();
      });
      await waitFor(() =>
        expect(props.submitStep.mutateAsync).toHaveBeenLastCalledWith(
          expect.objectContaining({ step: 'source', transcriptSource: 'paste' })
        )
      );
    });

    it('rejects paste transcript that is too short', async () => {
      await renderAtSource();
      await act(async () => {
        fireEvent.click(screen.getByText('Paste'));
      });
      fireEvent.change(
        screen.getByPlaceholderText('Speaker 1: Thanks for taking the time today...'),
        { target: { value: 'Too short' } }
      );
      await act(async () => {
        submitForm();
      });
      await waitFor(() =>
        expect(
          screen.queryByText('Paste a transcript of at least a few lines', { exact: false })
        ).not.toBeNull()
      );
    });

    it('advances to generate step via recent picker selection', async () => {
      const props = await renderAtSource();
      await advanceToStep('Pick a running presentation agent session.', () =>
        fireEvent.click(screen.getByText('Pick recent'))
      );
      expect(props.submitStep.mutateAsync).toHaveBeenLastCalledWith(
        expect.objectContaining({
          step: 'source',
          transcriptSource: 'paste',
          transcript: 'recent transcript',
        })
      );
    });

    it('submits a granola source with its id', async () => {
      const props = await renderAtSource(
        makeProps({
          renderRecentPicker: ({ onSelect }) =>
            React.createElement(
              'button',
              {
                type: 'button',
                onClick: () => onSelect({ source: 'granola', granolaId: 'gr-9' }),
              },
              'Pick granola'
            ),
        })
      );
      await advanceToStep('Pick a running presentation agent session.', () =>
        fireEvent.click(screen.getByText('Pick granola'))
      );
      expect(props.submitStep.mutateAsync).toHaveBeenLastCalledWith(
        expect.objectContaining({
          step: 'source',
          transcriptSource: 'granola',
          granolaId: 'gr-9',
        })
      );
    });

    it('rejects an artifact selection with no artifact id', async () => {
      const props = await renderAtSource(
        makeProps({
          renderArtifactPicker: ({ onSelect }) =>
            React.createElement(
              'button',
              { type: 'button', onClick: () => onSelect({ source: 'artifact' }) },
              'Pick artifact'
            ),
        })
      );
      await act(async () => {
        fireEvent.click(screen.getByText('Artifact'));
      });
      await act(async () => {
        fireEvent.click(screen.getByText('Pick artifact'));
      });
      await waitFor(() =>
        expect(
          screen.queryByText('Select an artifact to use as the source', { exact: false })
        ).not.toBeNull()
      );
      expect(props.submitStep.mutateAsync).not.toHaveBeenCalledWith(
        expect.objectContaining({ step: 'source' })
      );
    });

    it('rejects a recent selection that carries no transcript', async () => {
      const props = await renderAtSource(
        makeProps({
          renderRecentPicker: ({ onSelect }) =>
            React.createElement(
              'button',
              { type: 'button', onClick: () => onSelect({ source: 'paste' }) },
              'Pick empty'
            ),
        })
      );
      await act(async () => {
        fireEvent.click(screen.getByText('Pick empty'));
      });
      await waitFor(() =>
        expect(
          screen.queryByText('Paste a transcript of at least a few lines', { exact: false })
        ).not.toBeNull()
      );
      expect(props.submitStep.mutateAsync).not.toHaveBeenCalledWith(
        expect.objectContaining({ step: 'source' })
      );
    });

    it('surfaces an error when saving the source fails', async () => {
      await renderAtSource(
        makeProps({
          submitStep: {
            isPending: false,
            mutateAsync: mock(async (args: { step: string }) => {
              if (args.step === 'source') throw new Error('Source save boom');
              return { status: 'ok' };
            }),
          },
        })
      );
      await act(async () => {
        fireEvent.click(screen.getByText('Pick recent'));
      });
      await waitFor(() =>
        expect(screen.queryByText('Source save boom', { exact: false })).not.toBeNull()
      );
    });
  });

  describe('Generate step', () => {
    async function renderAtGenerate(props = makeProps()) {
      render(<PresentationGenerationWizard {...props} />);
      await advanceToStep('Describe the presentation goal.', () => submitForm());
      await advanceToStep('Choose the source for this presentation.', () => submitForm());
      await advanceToStep('Pick a running presentation agent session.', () =>
        fireEvent.click(screen.getByText('Pick recent'))
      );
      return props;
    }

    it('lists Geralt instances', async () => {
      await renderAtGenerate();
      expect(screen.getByText('Geralt')).toBeDefined();
    });

    it('shows empty state when no instances are running', async () => {
      const props = makeProps({ geraltInstances: { isLoading: false, data: [] } });
      await renderAtGenerate(props);
      expect(
        screen.queryByText('No presentation agents are running.', { exact: false })
      ).not.toBeNull();
    });

    it('calls submitStep generate and invokes onCreated', async () => {
      const props = await renderAtGenerate();
      const label = screen.getByText('Session 1').closest('label');
      if (!label) throw new Error('label not found');
      fireEvent.click(label);
      await act(async () => {
        submitForm();
      });
      await waitFor(() => expect(props.onCreated).toHaveBeenCalledWith('wf-1'));
      expect(props.submitStep.mutateAsync).toHaveBeenLastCalledWith(
        expect.objectContaining({ step: 'generate', agentInstanceId: 'inst-1' })
      );
    });

    it('surfaces an error when dispatching the brief fails', async () => {
      const props = await renderAtGenerate(
        makeProps({
          submitStep: {
            isPending: false,
            mutateAsync: mock(async (args: { step: string }) => {
              if (args.step === 'generate') throw new Error('Dispatch boom');
              return { status: 'ok' };
            }),
          },
        })
      );
      const label = screen.getByText('Session 1').closest('label');
      if (!label) throw new Error('label not found');
      fireEvent.click(label);
      await act(async () => {
        submitForm();
      });
      await waitFor(() =>
        expect(screen.queryByText('Dispatch boom', { exact: false })).not.toBeNull()
      );
      expect(props.onCreated).not.toHaveBeenCalled();
    });
  });

  describe('Close', () => {
    it('calls onClose when the close button is clicked', () => {
      const props = makeProps();
      render(<PresentationGenerationWizard {...props} />);
      fireEvent.click(screen.getByLabelText('Close'));
      expect(props.onClose).toHaveBeenCalledTimes(1);
    });
  });
});
