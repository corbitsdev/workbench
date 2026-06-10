import { describe, expect, it } from 'bun:test';
import { buildCollateralSystemPrompt } from './prompts';

describe('buildCollateralSystemPrompt', () => {
  it('gives the one-pager a full sales structure, not a generic problem/evidence doc', () => {
    const prompt = buildCollateralSystemPrompt('one-pager');
    expect(prompt).toMatch(/sales one-pager/i);
    expect(prompt).toMatch(/value proposition/i);
    expect(prompt).toMatch(/differentiated capabilities/i);
    expect(prompt).toMatch(/use cases/i);
    expect(prompt).toMatch(/call to action/i);
    // Must not fall back to the generic short-doc structure.
    expect(prompt).not.toMatch(/Start with the problem, then evidence, then recommended next step/);
  });

  it('gives linkedin-post its own substantive guidance distinct from twitter', () => {
    const linkedin = buildCollateralSystemPrompt('linkedin-post');
    expect(linkedin).toMatch(/LinkedIn post/i);
    expect(linkedin).toMatch(/150-250 words/);
    // The flattening "under 20 words each" cap should not apply to LinkedIn.
    expect(linkedin).not.toMatch(/under 20 words each/);
  });

  it('keeps twitter and founder-pov on the tighter short-social structure', () => {
    const twitter = buildCollateralSystemPrompt('twitter-post');
    expect(twitter).toMatch(/under 20 words each/);
  });

  it('still emits the shared ruleset for every kind', () => {
    for (const kind of ['one-pager', 'linkedin-post', 'twitter-post', 'email', 'battlecard']) {
      expect(buildCollateralSystemPrompt(kind)).toMatch(/<ruleset>/);
    }
  });
});
