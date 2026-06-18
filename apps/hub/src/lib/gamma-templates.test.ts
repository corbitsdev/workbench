import { describe, expect, it } from 'bun:test';
import { configToRow } from './gamma-templates';

describe('configToRow', () => {
  const BASE = {
    templateId: 'tpl-1',
    version: 1,
    name: 'Sales Deck',
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };

  it('returns a well-formed row when config is valid', () => {
    const row = configToRow(
      BASE.templateId,
      BASE.version,
      BASE.name,
      {
        gammaId: 'g-abc',
        systemPrompt: 'You are a deck generator.',
      },
      BASE.createdAt
    );

    expect(row.id).toBe('tpl-1');
    expect(row.gammaId).toBe('g-abc');
    expect(row.systemPrompt).toBe('You are a deck generator.');
    expect(row.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('throws when gammaId is missing from config', () => {
    expect(() =>
      configToRow(
        BASE.templateId,
        BASE.version,
        BASE.name,
        {
          systemPrompt: 'A prompt',
        },
        BASE.createdAt
      )
    ).toThrow('gammaId must be a non-empty string');
  });

  it('throws when gammaId is an empty string', () => {
    expect(() =>
      configToRow(
        BASE.templateId,
        BASE.version,
        BASE.name,
        {
          gammaId: '',
          systemPrompt: 'A prompt',
        },
        BASE.createdAt
      )
    ).toThrow('gammaId must be a non-empty string');
  });

  it('throws when gammaId is not a string', () => {
    expect(() =>
      configToRow(
        BASE.templateId,
        BASE.version,
        BASE.name,
        {
          gammaId: 42,
          systemPrompt: 'A prompt',
        },
        BASE.createdAt
      )
    ).toThrow('gammaId must be a non-empty string');
  });

  it('throws when systemPrompt is missing from config', () => {
    expect(() =>
      configToRow(
        BASE.templateId,
        BASE.version,
        BASE.name,
        {
          gammaId: 'g-abc',
        },
        BASE.createdAt
      )
    ).toThrow('systemPrompt must be a non-empty string');
  });

  it('throws when systemPrompt is an empty string', () => {
    expect(() =>
      configToRow(
        BASE.templateId,
        BASE.version,
        BASE.name,
        {
          gammaId: 'g-abc',
          systemPrompt: '',
        },
        BASE.createdAt
      )
    ).toThrow('systemPrompt must be a non-empty string');
  });
});
