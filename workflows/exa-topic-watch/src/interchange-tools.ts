// Native `interchange.tools` entry for @workbench/tools-exa-topic-watch.
// Stateless (a pure field rename), so the factory touches no env keys and
// resolves no credential.

import { createToolRunner, defineTool } from "@intx/agent";
import { createExaTopicWatchTools } from "./tools";

export const exaTopicWatch = defineTool({
  id: "@workbench/tools-exa-topic-watch/core",
  factory: () => createToolRunner(createExaTopicWatchTools()),
});
