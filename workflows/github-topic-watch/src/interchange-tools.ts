// Native `interchange.tools` entry for @workbench/tools-github-topic-watch.
// Stateless (a pure field rename + a fixed literal), so the factory touches
// no env keys and resolves no credential.

import { createToolRunner, defineTool } from "@intx/agent";
import { createGithubTopicWatchTools } from "./tools";

export const githubTopicWatch = defineTool({
  id: "@workbench/tools-github-topic-watch/core",
  factory: () => createToolRunner(createGithubTopicWatchTools()),
});
