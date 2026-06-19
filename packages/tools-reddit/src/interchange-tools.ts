import { defineCredentialedToolPackage } from '@workbench/tool-credentials/factory';
import { REDDIT_HUB_TOOLS } from './index';

export const reddit = defineCredentialedToolPackage({
  id: '@workbench/tools-reddit/reddit',
  provider: 'scrapecreators',
  entries: REDDIT_HUB_TOOLS,
});
