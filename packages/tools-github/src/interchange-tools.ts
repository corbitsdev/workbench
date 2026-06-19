import { defineCredentialedToolPackage } from '@workbench/tool-credentials/factory';
import { GITHUB_HUB_TOOLS } from './index';

export const github = defineCredentialedToolPackage({
  id: '@workbench/tools-github/github',
  provider: 'github',
  entries: GITHUB_HUB_TOOLS,
});
