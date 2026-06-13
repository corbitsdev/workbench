import { describe, expect, it } from 'bun:test';
import {
  BOBBY_CAPABILITIES,
  BOBBY_DEPLOY_DESCRIPTOR,
  BOBBY_GRANT_REQUIREMENTS,
} from './definition';
import { buildBobbySystemPrompt } from './prompt';

describe('bobby agent definition', () => {
  it('grants mail_search alongside mail_reply so search-then-reply is followable', () => {
    const resources = BOBBY_GRANT_REQUIREMENTS.map((g) => g.resource);
    expect(resources).toContain('tool:mail_search');
    expect(resources).toContain('tool:mail_reply');
  });

  it('exposes mail_search and mail_reply as enabled tools', () => {
    expect(BOBBY_CAPABILITIES.tools).toContain('mail_search');
    expect(BOBBY_CAPABILITIES.tools).toContain('mail_reply');
  });

  it('keeps the full browser toolset', () => {
    expect(BOBBY_CAPABILITIES.tools).toContain('browser_create_session');
    expect(BOBBY_CAPABILITIES.tools).toContain('browser_close_session');
  });

  it('derives deploy descriptor tool lists from the capabilities', () => {
    expect(BOBBY_DEPLOY_DESCRIPTOR.defaultTools).toEqual([...BOBBY_CAPABILITIES.tools]);
    expect(BOBBY_DEPLOY_DESCRIPTOR.requiredTools).toEqual([...BOBBY_CAPABILITIES.tools]);
  });

  it('includes the dispatch messaging protocol in the system prompt', () => {
    const prompt = buildBobbySystemPrompt('Bobby', { xml: true });
    // The shared section teaches search-then-reply; without it a dispatched
    // Bobby has the tool but not the protocol.
    expect(prompt).toContain('mail_search');
    expect(prompt.toLowerCase()).toContain('ins_');
  });
});
