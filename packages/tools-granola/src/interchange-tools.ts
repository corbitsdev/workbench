import { defineCredentialedToolPackage } from '@workbench/tool-credentials/factory';
import { GRANOLA_HUB_TOOLS } from './index';

export const granola = defineCredentialedToolPackage({
  id: '@workbench/tools-granola/granola',
  provider: 'granola',
  entries: GRANOLA_HUB_TOOLS,
});
