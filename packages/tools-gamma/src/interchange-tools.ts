import { defineCredentialedToolPackage } from '@workbench/tool-credentials/factory';
import { GAMMA_HUB_TOOLS } from './index';

export const gamma = defineCredentialedToolPackage({
  id: '@workbench/tools-gamma/gamma',
  provider: 'gamma',
  entries: GAMMA_HUB_TOOLS,
});
