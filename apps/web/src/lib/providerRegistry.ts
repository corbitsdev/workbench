/**
 * Provider registry for non-inference ("other") credentials.
 *
 * Tool names and descriptions are inlined here rather than imported from tool
 * packages — those packages depend on @intx/agent which uses node:path and
 * cannot be bundled for the browser.
 *
 * Field specs use the hub API's field naming (`baseURL`, `apiKey`) since
 * that's what CreateTenantCredentialInput accepts.
 *
 * Note: tools packages use `baseUrl` internally; the hub API uses `baseURL`.
 * Fields here use the hub API convention.
 */

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
      name: 'granola_list_notes',
      label: 'List Notes',
      description: 'List recent notes from Granola.',
    },
    {
      name: 'granola_get_note',
      label: 'Get Note',
      description: 'Get the full content of a Granola note by ID.',
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
      name: 'exa_search',
      label: 'Search',
      description: 'Search the web via Exa.',
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
  tools: [
    { name: 'firecrawl_scrape', label: 'scrape', description: 'Scrape a URL to markdown.' },
    { name: 'firecrawl_map', label: 'map', description: 'Map all URLs from a domain.' },
    { name: 'firecrawl_search', label: 'search', description: 'Search the web via Firecrawl.' },
    { name: 'firecrawl_crawl_start', label: 'crawl start', description: 'Start a crawl job.' },
    { name: 'firecrawl_crawl_status', label: 'crawl status', description: 'Get crawl job status.' },
    { name: 'firecrawl_crawl_active', label: 'crawl active', description: 'List active crawl pages.' },
    { name: 'firecrawl_crawl_errors', label: 'crawl errors', description: 'List crawl errors.' },
    { name: 'firecrawl_crawl_cancel', label: 'crawl cancel', description: 'Cancel a crawl job.' },
    { name: 'firecrawl_crawl_params_preview', label: 'crawl params preview', description: 'Preview crawl params.' },
    { name: 'firecrawl_batch_scrape_start', label: 'batch scrape start', description: 'Start a batch scrape job.' },
    { name: 'firecrawl_batch_scrape_status', label: 'batch scrape status', description: 'Get batch scrape status.' },
    { name: 'firecrawl_batch_scrape_errors', label: 'batch scrape errors', description: 'List batch scrape errors.' },
    { name: 'firecrawl_batch_scrape_cancel', label: 'batch scrape cancel', description: 'Cancel a batch scrape job.' },
    { name: 'firecrawl_extract_start', label: 'extract start', description: 'Start an extraction job.' },
    { name: 'firecrawl_extract_status', label: 'extract status', description: 'Get extraction status.' },
    { name: 'firecrawl_monitor_create', label: 'monitor create', description: 'Create a monitor.' },
    { name: 'firecrawl_monitor_get', label: 'monitor get', description: 'Get a monitor.' },
    { name: 'firecrawl_monitor_update', label: 'monitor update', description: 'Update a monitor.' },
    { name: 'firecrawl_monitor_delete', label: 'monitor delete', description: 'Delete a monitor.' },
    { name: 'firecrawl_monitor_list', label: 'monitor list', description: 'List monitors.' },
    { name: 'firecrawl_monitor_run', label: 'monitor run', description: 'Run a monitor.' },
    { name: 'firecrawl_monitor_check', label: 'monitor check', description: 'Check monitor status.' },
    { name: 'firecrawl_parse', label: 'parse', description: 'Parse a document.' },
  ],
};

export const PROVIDER_REGISTRY: ProviderMeta[] = [GRANOLA, EXA, FIRECRAWL];

export function providerByName(name: string): ProviderMeta | undefined {
  return PROVIDER_REGISTRY.find((p) => p.name === name);
}
