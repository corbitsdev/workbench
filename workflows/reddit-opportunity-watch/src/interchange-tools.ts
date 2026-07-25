// Native `interchange.tools` entry for @workbench/tools-reddit-opportunity-watch.
// Stateless (a pure field rename), so the factory touches no env keys and
// resolves no credential.

import { createToolRunner, defineTool } from "@intx/agent";
import { createRedditOpportunityWatchTools } from "./tools";

export const redditOpportunityWatch = defineTool({
  id: "@workbench/tools-reddit-opportunity-watch/core",
  factory: () => createToolRunner(createRedditOpportunityWatchTools()),
});
