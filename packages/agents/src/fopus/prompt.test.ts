import { describe, expect, it } from 'bun:test';
import { FOPUS_DEPLOY_PROMPT } from './prompt';

describe('FOPus prompt', () => {
  it('uses the public Claude Fable 5 system prompt content', () => {
    expect(FOPUS_DEPLOY_PROMPT).toContain('# Claude Fable 5 -- Complete System Prompt');
    expect(FOPUS_DEPLOY_PROMPT).toContain('Claude should never use `voice_note` blocks');
    expect(FOPUS_DEPLOY_PROMPT).toContain('This iteration of Claude is Claude Fable 5');
  });
});
