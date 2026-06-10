import { describe, expect, it } from 'bun:test';
import {
  buildCollateralRulesBlock,
  buildCollateralSystemPrompt,
  isPublicCollateralKind,
} from './prompts';

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

  it('frames blog as a narrative story, not an analytical doc', () => {
    const blog = buildCollateralSystemPrompt('blog');
    expect(blog).toMatch(/blog post/i);
    expect(blog).toMatch(/narrative arc/i);
    expect(blog).toMatch(/Hook/);
    expect(blog).toMatch(/Lessons/);
    expect(blog).toMatch(/##/);
  });

  it('frames case-study around challenge, solution, and measurable results', () => {
    const caseStudy = buildCollateralSystemPrompt('case-study');
    expect(caseStudy).toMatch(/case study/i);
    expect(caseStudy).toMatch(/Challenge/);
    expect(caseStudy).toMatch(/Solution/);
    expect(caseStudy).toMatch(/Results/);
    expect(caseStudy).toMatch(/metrics/i);
  });

  it('frames objection-handling as a tactical rebuttal reference', () => {
    const guide = buildCollateralSystemPrompt('objection-handling');
    expect(guide).toMatch(/objection-handling guide/i);
    expect(guide).toMatch(/rebuttal/i);
    expect(guide).toMatch(/Proof/);
    expect(guide).toMatch(/Example/);
    expect(guide).toMatch(/tactical tool, not a narrative/i);
  });

  it('frames customer-quotes around verbatim quotes with attribution', () => {
    const quotes = buildCollateralSystemPrompt('customer-quotes');
    expect(quotes).toMatch(/verbatim/i);
    expect(quotes).toMatch(/Quote/);
    expect(quotes).toMatch(/Attribution/);
    expect(quotes).toMatch(/Theme/);
    expect(quotes).toMatch(/No paraphrasing/i);
  });

  it('frames battlecard as competitive positioning, not paid media copy', () => {
    const battlecard = buildCollateralSystemPrompt('battlecard');
    expect(battlecard).toMatch(/competitive battlecard/i);
    expect(battlecard).toMatch(/Their Claim/);
    expect(battlecard).toMatch(/Differentiation/i);
    expect(battlecard).toMatch(/Proof Points/);
    expect(battlecard).toMatch(/not paid media copy/i);
  });

  it('falls back to generic guidance for an unknown kind, interpolating the format', () => {
    const prompt = buildCollateralSystemPrompt('whitepaper');
    expect(prompt).toMatch(/paste-ready GTM collateral/i);
    expect(prompt).toMatch(/whitepaper/);
    // The generic fallback only carries a role, no kind-specific structure section.
    expect(prompt).not.toMatch(/<structure>/);
  });
});

describe('isPublicCollateralKind', () => {
  it('treats published collateral as public', () => {
    expect(isPublicCollateralKind('linkedin-post')).toBe(true);
    expect(isPublicCollateralKind('case-study')).toBe(true);
  });

  it('treats follow-up email and unknown kinds as not public', () => {
    expect(isPublicCollateralKind('email')).toBe(false);
    expect(isPublicCollateralKind('whitepaper')).toBe(false);
  });
});

describe('buildCollateralRulesBlock', () => {
  it('applies PII-stripping rules for public artifacts', () => {
    const rules = buildCollateralRulesBlock('linkedin-post');
    expect(rules).toMatch(/PUBLIC artifact/);
    expect(rules).toMatch(/Strip and generalise/i);
    expect(rules).toMatch(/universal insight/i);
    expect(rules).not.toMatch(/PRIVATE artifact/);
  });

  it('preserves real customer details for private artifacts', () => {
    const rules = buildCollateralRulesBlock('email');
    expect(rules).toMatch(/PRIVATE artifact/);
    expect(rules).toMatch(/first name/i);
    expect(rules).toMatch(/Do not leak details about other customers/i);
    expect(rules).not.toMatch(/PUBLIC artifact/);
  });

  it('always emits style and JSON output contract', () => {
    const rules = buildCollateralRulesBlock('blog');
    expect(rules).toMatch(/No buzzwords/);
    expect(rules).toMatch(/<style>/);
    expect(rules).toMatch(/"title"/);
    expect(rules).toMatch(/"body"/);
  });
});
