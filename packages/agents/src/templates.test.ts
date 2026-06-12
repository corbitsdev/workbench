import { describe, expect, it } from 'bun:test';
import { AGENT_TEMPLATES } from './templates';
import { BOBBY_DEPLOY_DESCRIPTOR } from './bobby/definition';

describe('AGENT_TEMPLATES', () => {
  const inferenceProviderNames = new Set(['openai-compatible']);
  const knownToolProviderNames = new Set([
    'exa',
    'firecrawl',
    'granola',
    'reddit',
    'scrapecreators',
    'xai',
  ]);

  it('contains all eight templates', () => {
    const keys = AGENT_TEMPLATES.map((t) => t.key).sort();
    expect(keys).toEqual(['bobby', 'freddy', 'hammy', 'lincoln', 'loop', 'myra', 'oat', 'walter']);
  });

  it('registers Bobby with the browser toolset and the browserbase credential provider', () => {
    const bobby = AGENT_TEMPLATES.find((t) => t.key === 'bobby');
    expect(bobby).toBeDefined();
    expect(bobby?.capabilities.tools).toContain('browser_create_session');
    expect(BOBBY_DEPLOY_DESCRIPTOR.credentialProviderNames).toContain('browserbase');
  });

  it('every template has a non-empty name, systemPrompt, and credentialRequirements', () => {
    for (const template of AGENT_TEMPLATES) {
      expect(template.name.length).toBeGreaterThan(0);
      expect(template.systemPrompt.length).toBeGreaterThan(0);
      expect(template.credentialRequirements.length).toBeGreaterThan(0);
      expect(Array.isArray(template.capabilities.tools)).toBe(true);
    }
  });

  it('only declares inference providers as launch-time credential requirements', () => {
    for (const template of AGENT_TEMPLATES) {
      for (const requirement of template.credentialRequirements) {
        expect(inferenceProviderNames.has(requirement.providerName)).toBe(true);
        expect(knownToolProviderNames.has(requirement.providerName)).toBe(false);
      }
    }
  });

  it('does not bake dynamic per-workbench grants into any template', () => {
    for (const template of AGENT_TEMPLATES) {
      for (const grant of template.grantRequirements) {
        expect(grant.resource.startsWith('tenant:')).toBe(false);
      }
    }
  });

  it('keeps Myra static grants (mail_send) without the deliver grant', () => {
    const myra = AGENT_TEMPLATES.find((t) => t.key === 'myra');
    expect(myra).toBeDefined();
    const resources = myra?.grantRequirements.map((g) => g.resource) ?? [];
    expect(resources).toContain('tool:mail_send');
  });

  it('Myra capabilities include async mail tools but not mail_wait', () => {
    const myra = AGENT_TEMPLATES.find((t) => t.key === 'myra');
    expect(myra).toBeDefined();
    const tools = myra?.capabilities.tools ?? [];
    expect(tools).toContain('mail_send');
    expect(tools).toContain('mail_reply');
    expect(tools).toContain('mail_search');
    expect(tools).toContain('mail_read');
    expect(tools).not.toContain('mail_wait');
  });

  it('every specialist agent has a mail_reply grant requirement', () => {
    const specialists = AGENT_TEMPLATES.filter((t) => t.key !== 'myra');
    for (const template of specialists) {
      const resources = template.grantRequirements.map((g) => g.resource);
      expect(resources).toContain('tool:mail_reply');
    }
  });

  it('every specialist agent exposes mail_reply as an enabled tool', () => {
    const specialists = AGENT_TEMPLATES.filter((t) => t.key !== 'myra');
    for (const template of specialists) {
      expect(template.capabilities.tools).toContain('mail_reply');
    }
  });
});
