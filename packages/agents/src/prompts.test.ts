import { describe, expect, it } from 'bun:test';
import { buildPersonalAgentSystemPrompt } from './personal-agent/prompt';
import { buildLoopAgentSystemPrompt } from './loop/prompt';
import { buildGranolaSystemPrompt } from './granola/prompt';
import { buildFirecrawlSystemPrompt } from './firecrawl/prompt';
import { buildWalterSystemPrompt } from './walter/prompt';

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
});
