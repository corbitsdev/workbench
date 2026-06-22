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
});
