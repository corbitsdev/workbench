// Native `interchange.tools` entry for @workbench/workflow-reddit-opportunity-scanner
// Wraps `reddit_subreddit_search` so `collect`'s per-search map
// iteration can tolerate one dead subreddit search without poisoning the
// whole curate pool. Declares the same tool-credential env key the wrapped
// package itself declares, so the hub still resolves + injects the
// `scrapecreators` credential when one is configured.

import { createToolRunner, defineTool } from "@intx/agent";
import {
  COLLECT_TOOL_REQUIRES,
  createRedditOpportunityScannerCollectTools,
} from "./collect-tool";

export const redditOpportunityScannerCollect = defineTool({
  id: "@workbench/workflow-reddit-opportunity-scanner/collect",
  requires: COLLECT_TOOL_REQUIRES,
  factory: (env) =>
    createToolRunner(createRedditOpportunityScannerCollectTools(env)),
});
