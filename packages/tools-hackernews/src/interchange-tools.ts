// Native `interchange.tools` entry for @workbench/tools-hackernews.
//
// The sidecar loader imports this module from the materialized tarball
// and wires every exported AnnotatedToolFactory into the reactor. Each
// factory is namespaced by `defineTool`'s id; `createToolRunner` adapts
// the package's AgentTool[] into the ToolBundle dispatch contract.
//
// HackerNews is keyless (public Algolia API), so the factory touches no
// env keys beyond BaseEnv and declares no `requires`.

import { createToolRunner, defineTool } from '@intx/agent';
import { createHackerNewsTools } from './tools';

export const hackernews = defineTool({
  id: '@workbench/tools-hackernews/hackernews',
  factory: () => createToolRunner(createHackerNewsTools()),
});
