import { defineCredentialedToolPackage } from '@workbench/tool-credentials/factory';
import { FIRECRAWL_HUB_TOOLS } from './index';

export const firecrawl = defineCredentialedToolPackage({
  id: '@workbench/tools-firecrawl/firecrawl',
  provider: 'firecrawl',
  entries: FIRECRAWL_HUB_TOOLS,
});
