import { describe, expect, it } from 'bun:test';
import { FULL_CATALOG, buildAgentCatalog } from './catalog';

describe('FULL_CATALOG integrity', () => {
  it('has no duplicate provider names', () => {
    const names = FULL_CATALOG.providers.map((p) => p.name);
    expect(names.length).toBe(new Set(names).size);
  });

  it('has no duplicate model canonicalNames', () => {
    const names = FULL_CATALOG.models.map((m) => m.canonicalName);
    expect(names.length).toBe(new Set(names).size);
  });

  it('has no duplicate (model, provider) offering pairs', () => {
    const keys = FULL_CATALOG.offerings.map((o) => `${o.model} ${o.provider}`);
    expect(keys.length).toBe(new Set(keys).size);
  });

  it('every offering provider exists in providers', () => {
    const providerNames = new Set(FULL_CATALOG.providers.map((p) => p.name));
    for (const offering of FULL_CATALOG.offerings) {
      expect(providerNames.has(offering.provider)).toBe(true);
    }
  });

  it('every offering model exists in models', () => {
    const modelNames = new Set(FULL_CATALOG.models.map((m) => m.canonicalName));
    for (const offering of FULL_CATALOG.offerings) {
      expect(modelNames.has(offering.model)).toBe(true);
    }
  });
});

describe('buildAgentCatalog', () => {
  it('returns empty providers/models/offerings for empty templates', () => {
    const result = buildAgentCatalog([]);
    expect(result.providers).toEqual([]);
    expect(result.models).toEqual([]);
    expect(result.offerings).toEqual([]);
  });

  it('produces correct output for a template with a known credential', () => {
    const template = {
      key: 'test-agent',
      credentialRequirements: [
        {
          source: 'tenant',
          providerName: 'openai-compatible',
          name: 'opencode-zen',
        },
      ],
      modelConfig: { defaultModel: 'deepseek-v4-flash' },
    };

    const result = buildAgentCatalog([template]);

    expect(result.providers).toEqual([
      {
        name: 'opencode-zen',
        plugin: 'openai-compatible',
        credentialName: 'opencode-zen',
      },
    ]);
    expect(result.models).toEqual([{ canonicalName: 'deepseek-v4-flash' }]);
    expect(result.offerings).toEqual([{ model: 'deepseek-v4-flash', provider: 'opencode-zen' }]);
  });

  it('deduplicates providers and models across templates sharing the same credential', () => {
    const templates = [
      {
        key: 'agent-a',
        credentialRequirements: [
          {
            source: 'tenant',
            providerName: 'openai-compatible',
            name: 'opencode-zen',
          },
        ],
        modelConfig: { defaultModel: 'deepseek-v4-flash' },
      },
      {
        key: 'agent-b',
        credentialRequirements: [
          {
            source: 'tenant',
            providerName: 'openai-compatible',
            name: 'opencode-zen',
          },
        ],
        modelConfig: { defaultModel: 'deepseek-v4-flash' },
      },
    ];

    const result = buildAgentCatalog(templates);

    expect(result.providers.length).toBe(1);
    expect(result.models.length).toBe(1);
    expect(result.offerings.length).toBe(1);
  });

  it('throws when a template has no tenant inference credential', () => {
    const template = {
      key: 'bad-agent',
      credentialRequirements: [],
      modelConfig: { defaultModel: 'gpt-4o' },
    };

    expect(() => buildAgentCatalog([template])).toThrow(
      'has no tenant inference credential requirement'
    );
  });

  it('throws when a template has no modelConfig.defaultModel', () => {
    const template = {
      key: 'no-model-agent',
      credentialRequirements: [
        {
          source: 'tenant',
          providerName: 'openai-compatible',
          name: 'opencode-zen',
        },
      ],
      modelConfig: {},
    };

    expect(() => buildAgentCatalog([template])).toThrow('must declare modelConfig.defaultModel');
  });
});
