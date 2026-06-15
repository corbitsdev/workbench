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

  it('fans out to social, X, and Reddit sources', () => {
    for (const tool of [
      'x_search',
      'reddit_search',
      'reddit_subreddit_search',
      'scrapecreators_tiktok',
      'scrapecreators_instagram',
      'scrapecreators_threads',
      'scrapecreators_pinterest',
      'youtube_search',
      'bluesky_search',
      'web_search',
    ]) {
      expect(LARRY_SKILL_CONTENT).toContain(tool);
    }
  });

  it('instructs the agent to degrade gracefully when a source fails', () => {
    expect(LARRY_SKILL_CONTENT).toContain('never abort the report because one source failed');
  });

  it('names all four queryType modes', () => {
    expect(LARRY_SKILL_CONTENT).toContain('GENERAL');
    expect(LARRY_SKILL_CONTENT).toContain('NEWS');
    expect(LARRY_SKILL_CONTENT).toContain('COMPARISON');
    expect(LARRY_SKILL_CONTENT).toContain('RECOMMENDATIONS');
  });

  it('instructs ELI5 rewrite behavior', () => {
    expect(LARRY_SKILL_CONTENT).toContain('ELI5');
  });

  it('requires bestTakes to be woven into prose, not a separate section', () => {
    expect(LARRY_SKILL_CONTENT).toContain('bestTakes');
    expect(LARRY_SKILL_CONTENT).toContain('Do NOT create a separate');
  });

  it('requires data: brief on write_artifact call', () => {
    expect(LARRY_SKILL_CONTENT).toContain('data: brief');
  });

  it('prohibits em-dashes', () => {
    expect(LARRY_SKILL_CONTENT).toContain('No em-dashes');
  });

  it('describes the structured brief shape from last30days_core_report', () => {
    expect(LARRY_SKILL_CONTENT).toContain('clusters');
    expect(LARRY_SKILL_CONTENT).toContain('bestTakes');
    expect(LARRY_SKILL_CONTENT).toContain('citations');
    expect(LARRY_SKILL_CONTENT).toContain('stats');
  });

  it('specifies COMPARISON contract structure', () => {
    expect(LARRY_SKILL_CONTENT).toContain('Quick verdict');
    expect(LARRY_SKILL_CONTENT).toContain('Head-to-head');
    expect(LARRY_SKILL_CONTENT).toContain('Bottom line');
  });

  it('specifies RECOMMENDATIONS contract leads with the winner', () => {
    expect(LARRY_SKILL_CONTENT).toContain('Signal-weighted winner');
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
