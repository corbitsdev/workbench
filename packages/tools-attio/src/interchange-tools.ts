import { defineCredentialedToolPackage } from '@workbench/tool-credentials/factory';
import { ATTIO_HUB_TOOLS } from './index';

export const attio = defineCredentialedToolPackage({
  id: '@workbench/tools-attio/attio',
  provider: 'attio',
  entries: ATTIO_HUB_TOOLS,
});
