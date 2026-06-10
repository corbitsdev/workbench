import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildPersonalAgentSystemPrompt } from './personal-agent/prompt';
import { buildLoopAgentSystemPrompt } from './loop/prompt';
import { buildGranolaSystemPrompt } from './granola/prompt';
import { buildFirecrawlSystemPrompt } from './firecrawl/prompt';
import { buildWalterSystemPrompt } from './walter/prompt';
import { buildHammySystemPrompt } from './hammy-the-humanizer/prompt';
import { HAMMY_SKILL_CONTENT } from './hammy-the-humanizer/skill';

const format = { xml: true };

describe('agent system prompts', () => {
  it('personal agent includes the humanizer section', () => {
    const prompt = buildPersonalAgentSystemPrompt('Myra', format);
    expect(prompt).toContain('No emojis unless explicitly requested');
  });

  it('loop agent includes the humanizer section', () => {
    const prompt = buildLoopAgentSystemPrompt('Loop', format);
    expect(prompt).toContain('No emojis unless explicitly requested');
  });

  it('granola agent includes the humanizer section', () => {
    const prompt = buildGranolaSystemPrompt('Granola', format);
    expect(prompt).toContain('No emojis unless explicitly requested');
  });

  it('firecrawl agent includes the humanizer section', () => {
    const prompt = buildFirecrawlSystemPrompt('Firecrawl', format);
    expect(prompt).toContain('No emojis unless explicitly requested');
  });

  it('walter agent focuses on traditional writing and artifacts', () => {
    const prompt = buildWalterSystemPrompt('Walter', format);
    expect(prompt).toContain('Walter is a writer and editor');
    expect(prompt).toContain('essays, articles, memos, narratives, letters, speeches, scripts');
    expect(prompt).toContain('If tools are available to create files');
    expect(prompt).toContain('No emojis unless explicitly requested');
  });

  it('hammy agent is scoped to humanize and score only', () => {
    const prompt = buildHammySystemPrompt('Hammy', format);
    expect(prompt).toContain('Hammy is a humanizer');
    expect(prompt).toContain('Humanize');
    expect(prompt).toContain('Score');
    expect(prompt).not.toContain('writer and editor');
  });
});

describe('HAMMY_SKILL_CONTENT sync with SKILL.md', () => {
  it('skill.ts content matches SKILL.md', () => {
    const skillMd = readFileSync(
      join(import.meta.dir, 'hammy-the-humanizer/SKILL.md'),
      'utf-8'
    );
    const normalize = (s: string) =>
      s
        .split('\n')
        .map((l) => l.trimEnd())
        .join('\n')
        .trim();
    expect(normalize(HAMMY_SKILL_CONTENT)).toEqual(normalize(skillMd));
  });
});
