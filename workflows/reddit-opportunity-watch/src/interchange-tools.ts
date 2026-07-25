// Native `interchange.tools` entry for @workbench/workflow-reddit-opportunity-watch.
// Stateless (a pure field rename), so the factory touches no env keys and
// resolves no credential.

import { createToolRunner, defineTool } from "@intx/agent";
import { createRedditOpportunityWatchTools } from "./tools";

export const redditOpportunityWatch = defineTool({
  id: "@workbench/workflow-reddit-opportunity-watch/core",
  factory: () => createToolRunner(createRedditOpportunityWatchTools()),
});
