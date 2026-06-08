/**
 * Provider registry for non-inference ("other") credentials.
 *
 * Tool names and descriptions are sourced from the actual tool packages.
 * Field specs use the hub API's field naming (`baseURL`, `apiKey`) since
 * that's what CreateTenantCredentialInput accepts.
 *
 * Note: tools packages use `baseUrl` internally; the hub API uses `baseURL`.
 * Fields here use the hub API convention.
 */
import {
  GRANOLA_LIST_NOTES_DEFINITION,
  GRANOLA_GET_NOTE_DEFINITION,
} from '@workbench/tools-granola';
import { EXA_SEARCH_DEFINITION } from '@workbench/tools-exa';
import { FIRECRAWL_DEFINITIONS } from '@workbench/tools-firecrawl';

export type FieldSpec = {
  key: 'apiKey' | 'baseURL';
  label: string;
  type: 'text' | 'password' | 'url';
  required: boolean;
  placeholder?: string;
};

export type ToolMeta = {
  name: string;
  label: string;
  description: string;
};

export type ProviderMeta = {
  name: string;
  label: string;
  description: string;
  fields: FieldSpec[];
  tools: ToolMeta[];
};

const GRANOLA: ProviderMeta = {
  name: 'granola',
  label: 'Granola',
  description: 'Access call notes and transcripts from Granola.',
  // Base URL is owned by @workbench/tools-granola (GRANOLA_DEFAULT_BASE_URL);
  // the credential only needs an API key.
  fields: [
    {
      key: 'apiKey',
      label: 'API key',
      type: 'password',
      required: true,
      placeholder: 'gran_...',
    },
  ],
  tools: [
    {
      name: GRANOLA_LIST_NOTES_DEFINITION.name,
      label: 'List Notes',
      description: GRANOLA_LIST_NOTES_DEFINITION.description,
    },
    {
      name: GRANOLA_GET_NOTE_DEFINITION.name,
      label: 'Get Note',
      description: GRANOLA_GET_NOTE_DEFINITION.description,
    },
  ],
};

const EXA: ProviderMeta = {
  name: 'exa',
  label: 'Exa',
  description: 'Web search via Exa.',
  fields: [
    {
      key: 'apiKey',
      label: 'API key',
      type: 'password',
      required: true,
      placeholder: 'exa-...',
    },
    {
      key: 'baseURL',
      label: 'Base URL (optional)',
      type: 'url',
      required: false,
      placeholder: 'https://api.exa.ai',
    },
  ],
  tools: [
    {
      name: EXA_SEARCH_DEFINITION.name,
      label: 'Search',
      description: EXA_SEARCH_DEFINITION.description,
    },
  ],
};

const FIRECRAWL: ProviderMeta = {
  name: 'firecrawl',
  label: 'Firecrawl',
  description: 'Scrape, crawl, map, search, and extract web data with Firecrawl.',
  fields: [
    {
      key: 'apiKey',
      label: 'API key',
      type: 'password',
      required: true,
      placeholder: 'fc-...',
    },
    {
      key: 'baseURL',
      label: 'Base URL (optional)',
      type: 'url',
      required: false,
      placeholder: 'https://api.firecrawl.dev/v2',
    },
  ],
  tools: FIRECRAWL_DEFINITIONS.map((definition) => ({
    name: definition.name,
    label: definition.name.replace(/^firecrawl_/, '').replace(/_/g, ' '),
    description: definition.description,
  })),
};

export const PROVIDER_REGISTRY: ProviderMeta[] = [GRANOLA, EXA, FIRECRAWL];

export function providerByName(name: string): ProviderMeta | undefined {
  return PROVIDER_REGISTRY.find((p) => p.name === name);
}
