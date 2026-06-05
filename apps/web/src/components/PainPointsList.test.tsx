/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { togglePainPointSelection } from './pain-point-selection';
import { getSeverityColor } from './PainPointsList';
import type { PainPoint, SeverityLevel } from './PainPointsList';

afterEach(() => {
  cleanup();
});

// framer-motion is not compatible with Happy DOM; replace motion.div with a plain div
mock.module('framer-motion', () => ({
  motion: {
    div: ({ children, className }: { children: React.ReactNode; className?: string }) =>
      React.createElement('div', { className }, children),
  },
}));

describe('PainPointsList types', () => {
  it('accepts PainPoint with all required fields', () => {
    const point: PainPoint = {
      id: '1',
      context: 'Need for faster deployment',
      quote: 'We spend too much time deploying',
      severity: 'high',
    };
    expect(point.id).toBe('1');
    expect(point.context).toBe('Need for faster deployment');
  });

  it('accepts PainPoint without severity', () => {
    const point: PainPoint = {
      id: '1',
      context: 'Need for faster deployment',
      quote: 'We spend too much time deploying',
    };
    expect(point.severity).toBeUndefined();
  });

  it('validates severity levels', () => {
    const severities: SeverityLevel[] = ['low', 'medium', 'high', 'critical'];
    severities.forEach((level) => {
      expect(['low', 'medium', 'high', 'critical']).toContain(level);
    });
  });

  it('maps every severity to a non-empty color class', () => {
    const severities: SeverityLevel[] = ['low', 'medium', 'high', 'critical'];
    severities.forEach((level) => {
      expect(getSeverityColor(level).length).toBeGreaterThan(0);
    });
  });

  it('renders the medium badge with a high-contrast color, not invisible cream', () => {
    // Regression for CL-1222: medium used bg-cream-deep, which is near-invisible
    // against the dark workflow surface and read as a missing badge.
    const medium = getSeverityColor('medium');
    expect(medium).not.toContain('cream');
    expect(medium).toBe('bg-yellow-100 text-yellow-800');
  });

  it('handles empty pain points array', () => {
    const points: PainPoint[] = [];
    expect(points.length).toBe(0);
  });

  it('supports loading state prop', () => {
    interface PainPointsListProps {
      points: PainPoint[];
      selectedIds: Set<string>;
      onToggle: (id: string) => void;
      isLoading?: boolean;
      analyzeCompleted?: boolean;
    }
    const props: PainPointsListProps = {
      points: [],
      selectedIds: new Set(),
      onToggle: () => {},
      isLoading: true,
      analyzeCompleted: false,
    };
    expect(props.isLoading).toBe(true);
    expect(props.analyzeCompleted).toBe(false);
  });

  it('supports analyzeCompleted state when empty', () => {
    interface PainPointsListProps {
      points: PainPoint[];
      selectedIds: Set<string>;
      onToggle: (id: string) => void;
      isLoading?: boolean;
      analyzeCompleted?: boolean;
    }
    const props: PainPointsListProps = {
      points: [],
      selectedIds: new Set(),
      onToggle: () => {},
      isLoading: false,
      analyzeCompleted: true,
    };
    expect(props.analyzeCompleted).toBe(true);
    expect(props.points.length).toBe(0);
  });

  it('toggles a pain point selection once per interaction', () => {
    const selected = togglePainPointSelection(new Set<string>(), 'point-1');
    expect(selected.has('point-1')).toBe(true);

    const deselected = togglePainPointSelection(selected, 'point-1');
    expect(deselected.has('point-1')).toBe(false);
  });

  it('returns a new set and only updates the targeted id', () => {
    const initial = new Set<string>(['point-2']);
    const next = togglePainPointSelection(initial, 'point-1');

    expect(next).not.toBe(initial);
    expect(initial.has('point-1')).toBe(false);
    expect(initial.has('point-2')).toBe(true);
    expect(next.has('point-1')).toBe(true);
    expect(next.has('point-2')).toBe(true);
  });
});

describe('PainPointsList interactions', () => {
  const point: PainPoint = {
    id: 'pp-1',
    context: 'Slow deployments',
    quote: 'We spend too much time deploying',
  };

  function renderWithState(initialSelected: Set<string> = new Set()) {
    const selected = { current: new Set(initialSelected) };
    const onToggle = mock((id: string) => {
      selected.current = togglePainPointSelection(selected.current, id);
    });

    const { rerender } = render(
      React.createElement(
        // Dynamic import resolved at test time after mock.module above
        require('./PainPointsList').default,
        { points: [point], selectedIds: selected.current, onToggle }
      )
    );

    return { selected, onToggle, rerender };
  }

  it('clicking the checkbox toggles selection exactly once', async () => {
    const user = userEvent.setup();
    const { onToggle } = renderWithState();

    await user.click(screen.getByRole('checkbox'));

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith('pp-1');
  });

  it('clicking the label toggles selection exactly once', async () => {
    const user = userEvent.setup();
    const { onToggle } = renderWithState();

    await user.click(screen.getByText('Slow deployments'));

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith('pp-1');
  });

  it('no double-toggle: label click does not fire onToggle twice', async () => {
    const user = userEvent.setup();
    const { onToggle } = renderWithState();

    // Simulates the PR #14 regression: label click was firing onChange on the
    // checkbox AND a synthetic click on the input, causing two toggle calls.
    await user.click(screen.getByLabelText('Select pain point: Slow deployments'));

    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
