/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MessageFeedback } from './MessageFeedback';

afterEach(cleanup);

describe('MessageFeedback', () => {
  it('renders thumbs up and thumbs down buttons', () => {
    const onRate = mock(async () => {});
    render(<MessageFeedback subjectId="tp-1" subjectKind="turn_part" onRate={onRate} />);
    expect(screen.getByRole('button', { name: 'Thumbs up' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Thumbs down' })).toBeTruthy();
  });

  it('calls onRate with 1 when thumbs up is clicked', async () => {
    const onRate = mock(async () => {});
    render(<MessageFeedback subjectId="tp-1" subjectKind="turn_part" onRate={onRate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Thumbs up' }));
    await waitFor(() => expect(onRate).toHaveBeenCalledWith('tp-1', 'turn_part', 1));
  });

  it('calls onRate with -1 when thumbs down is clicked', async () => {
    const onRate = mock(async () => {});
    render(<MessageFeedback subjectId="step-1" subjectKind="workflow_step" onRate={onRate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Thumbs down' }));
    await waitFor(() => expect(onRate).toHaveBeenCalledWith('step-1', 'workflow_step', -1));
  });

  it('marks the thumbs up button as pressed after a successful rating', async () => {
    const onRate = mock(async () => {});
    render(<MessageFeedback subjectId="tp-1" subjectKind="turn_part" onRate={onRate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Thumbs up' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Thumbs up' }).getAttribute('aria-pressed')).toBe(
        'true'
      )
    );
  });

  it('does not set rating when onRate rejects', async () => {
    const onRate = mock(async () => {
      throw new Error('network error');
    });
    render(<MessageFeedback subjectId="tp-1" subjectKind="turn_part" onRate={onRate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Thumbs up' }));
    await waitFor(() => expect(screen.getByText('Failed to save')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Thumbs up' }).getAttribute('aria-pressed')).toBe(
      'false'
    );
  });

  it('shows a saved thumbs-up rating from the server on mount', () => {
    const onRate = mock(async () => {});
    render(
      <MessageFeedback subjectId="tp-1" subjectKind="turn_part" savedRating={1} onRate={onRate} />
    );
    expect(screen.getByRole('button', { name: 'Thumbs up' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
    expect(screen.getByRole('button', { name: 'Thumbs down' }).getAttribute('aria-pressed')).toBe(
      'false'
    );
  });

  it('reverts to savedRating when onRate rejects', async () => {
    const onRate = mock(async () => {
      throw new Error('network error');
    });
    render(
      <MessageFeedback subjectId="tp-1" subjectKind="turn_part" savedRating={1} onRate={onRate} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Thumbs down' }));
    await waitFor(() => expect(screen.getByText('Failed to save')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Thumbs up' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
  });

  it('switches from thumbs up to thumbs down when toggled', async () => {
    const onRate = mock(async () => {});
    render(<MessageFeedback subjectId="tp-1" subjectKind="turn_part" onRate={onRate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Thumbs up' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Thumbs up' }).getAttribute('aria-pressed')).toBe(
        'true'
      )
    );
    fireEvent.click(screen.getByRole('button', { name: 'Thumbs down' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Thumbs down' }).getAttribute('aria-pressed')).toBe(
        'true'
      )
    );
    expect(screen.getByRole('button', { name: 'Thumbs up' }).getAttribute('aria-pressed')).toBe(
      'false'
    );
  });
});
