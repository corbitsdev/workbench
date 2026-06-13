import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { LARRY_SKILL_CONTENT } from './skill';

describe('LARRY_SKILL_CONTENT', () => {
  it('is a non-empty string', () => {
    expect(typeof LARRY_SKILL_CONTENT).toBe('string');
    expect(LARRY_SKILL_CONTENT.length).toBeGreaterThan(0);
  });

  it('references last30days_core_report', () => {
    expect(LARRY_SKILL_CONTENT).toContain('last30days_core_report');
  });

  it('references write_artifact', () => {
    expect(LARRY_SKILL_CONTENT).toContain('write_artifact');
  });

  it('contains stats block pattern', () => {
    expect(LARRY_SKILL_CONTENT).toContain('**[N] sources');
  });

  it('contains engine footer pattern', () => {
    expect(LARRY_SKILL_CONTENT).toContain('Research by last30days');
  });
});

describe('LARRY_SKILL_CONTENT sync with SKILL.md', () => {
  it('skill.ts content matches SKILL.md', () => {
    const skillMd = readFileSync(join(import.meta.dir, 'SKILL.md'), 'utf-8');
    const normalize = (s: string) =>
      s
        .split('\n')
        .map((l) => l.trimEnd())
        .join('\n')
        .trim();
    expect(normalize(LARRY_SKILL_CONTENT)).toEqual(normalize(skillMd));
  });
});
