import { describe, expect, it } from 'bun:test';
import { AGENT_TEMPLATES } from './templates';

describe('AGENT_TEMPLATES', () => {
  it('contains all seven templates', () => {
    const keys = AGENT_TEMPLATES.map((t) => t.key).sort();
    expect(keys).toEqual(['freddy', 'hammy', 'lincoln', 'loop', 'myra', 'oat', 'walter']);
  });

  it('every template has a non-empty name, systemPrompt, and credentialRequirements', () => {
    for (const template of AGENT_TEMPLATES) {
      expect(template.name.length).toBeGreaterThan(0);
      expect(template.systemPrompt.length).toBeGreaterThan(0);
      expect(template.credentialRequirements.length).toBeGreaterThan(0);
      expect(Array.isArray(template.capabilities.tools)).toBe(true);
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
});
