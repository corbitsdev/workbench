import { describe, expect, it } from 'bun:test';
import { AGENT_TEMPLATES } from './templates';

describe('AGENT_TEMPLATES', () => {
  const inferenceProviderNames = new Set(['anthropic', 'openai-compatible']);
  const knownToolProviderNames = new Set([
    'exa',
    'firecrawl',
    'granola',
    'reddit',
    'scrapecreators',
    'xai',
  ]);

  it('contains all ten templates', () => {
    const keys = AGENT_TEMPLATES.map((t) => t.key).sort();
    expect(keys).toEqual([
      'fannie',
      'freddie',
      'freddy',
      'hammy',
      'larry',
      'lincoln',
      'loop',
      'myra',
      'oat',
      'walter',
    ]);
  });

  it('registers Freddie as deployable Opus-backed Fable prompt agent', () => {
    const freddie = AGENT_TEMPLATES.find((t) => t.key === 'freddie');
    expect(freddie).toBeDefined();
    expect(freddie?.name).toBe('Freddie');
    expect(freddie?.modelConfig).toEqual({ defaultModel: 'claude-opus-4-8' });
    expect(freddie?.capabilities.tools).toContain('mail_reply');
    expect(freddie?.capabilities.tools).not.toContain('mail_send');
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

  it('drops the mail_send static grant (mail tools removed) and never bakes in the deliver grant', () => {
    const myra = AGENT_TEMPLATES.find((t) => t.key === 'myra');
    expect(myra).toBeDefined();
    const resources = myra?.grantRequirements.map((g) => g.resource) ?? [];
    expect(resources).not.toContain('tool:mail_send');
    // The dynamic per-workbench tenant:<id> deliver grant is computed at launch,
    // never seeded into the static definition.
    expect(resources.some((r) => r.startsWith('tenant:'))).toBe(false);
  });

  it('Myra capabilities carry the read-only domain tools and no mail tools', () => {
    const myra = AGENT_TEMPLATES.find((t) => t.key === 'myra');
    expect(myra).toBeDefined();
    const tools = myra?.capabilities.tools ?? [];
    expect(tools.some((t) => t.startsWith('mail_'))).toBe(false);
    expect(tools).toContain('@workbench/tools-granola/granola:granola_list_notes');
    expect(tools).toContain('@workbench/tools-linear/linear:linear_list_issues');
    expect(tools).toContain('@workbench/tools-attio/attio:attio_query_records');
  });

  it('every dispatch-capable specialist has mail_search and mail_reply grants', () => {
    // A specialist that can reply to a dispatcher MUST be able to search for
    // the message ref first — granting mail_reply without mail_search leaves
    // "never construct a ref from scratch" impossible to obey, which produced
    // fabricated recipient addresses (CL-1808).
    const specialists = AGENT_TEMPLATES.filter((t) => t.key !== 'myra');
    for (const template of specialists) {
      const resources = template.grantRequirements.map((g) => g.resource);
      expect(resources).toContain('tool:mail_search');
      expect(resources).toContain('tool:mail_reply');
    }
  });

  it('every dispatch-capable specialist exposes mail_search and mail_reply as enabled tools', () => {
    const specialists = AGENT_TEMPLATES.filter((t) => t.key !== 'myra');
    for (const template of specialists) {
      expect(template.capabilities.tools).toContain('mail_search');
      expect(template.capabilities.tools).toContain('mail_reply');
    }
  });

  it('no template exposes mail_reply without mail_search (search-then-reply must be followable)', () => {
    for (const template of AGENT_TEMPLATES) {
      const tools = template.capabilities.tools;
      if (tools.includes('mail_reply')) {
        expect(tools).toContain('mail_search');
      }
    }
  });
});
