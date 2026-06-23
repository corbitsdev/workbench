// Native `interchange.tools` entry for @workbench/tools-polymarket.
// Keyless (public Polymarket API), so the factory touches no env keys.

import { createToolRunner, defineTool } from '@intx/agent';
import { createPolymarketTools } from './tools';

export const polymarket = defineTool({
  id: '@workbench/tools-polymarket/polymarket',
  factory: () => createToolRunner(createPolymarketTools()),
});
