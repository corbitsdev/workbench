// Native `interchange.tools` entry for @workbench/tools-firecrawl-url-watch.
// Stateless (a pure field rename), so the factory touches no env keys and
// resolves no credential.

import { createToolRunner, defineTool } from "@intx/agent";
import { createFirecrawlUrlWatchTools } from "./tools";

export const firecrawlUrlWatch = defineTool({
  id: "@workbench/tools-firecrawl-url-watch/core",
  factory: () => createToolRunner(createFirecrawlUrlWatchTools()),
});
