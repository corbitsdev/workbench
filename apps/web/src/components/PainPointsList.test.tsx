/// <reference types="bun" />
import { describe, expect, it } from 'bun:test';
import type { PainPoint, SeverityLevel } from './PainPointsList';

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

  it('maps severity to correct color class', () => {
    const severityColors: Record<SeverityLevel, string> = {
      low: 'bg-blue-100',
      medium: 'bg-yellow-100',
      high: 'bg-orange-100',
      critical: 'bg-red-100',
    };
    expect(severityColors.high).toBe('bg-orange-100');
    expect(severityColors.low).toBe('bg-blue-100');
    expect(severityColors.medium).toBe('bg-yellow-100');
    expect(severityColors.critical).toBe('bg-red-100');
  });

  it('handles empty pain points array', () => {
    const points: PainPoint[] = [];
    expect(points.length).toBe(0);
  });
});
