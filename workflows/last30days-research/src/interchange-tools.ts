// Native `interchange.tools` entries for @workbench/workflow-last30days-research.
//
// Five credentialed factories (one per provider the wrapped source needs —
// `exa`/`github`/`scrapecreators`/`xai`/`youtube`), each mirroring the
// upstream tool package's own `defineCredentialedToolPackage` call so the
// SAME tenant credential resolves the SAME way. A sixth, keyless factory
// bundles the two public-API sources (`hackernews_search`, `polymarket_odds`)
// that need no credential at all. See `./tools.ts` for why these wrappers
// exist (CL-4464: replacing `nonFatal` deterministic steps with native
// `action` primitives).

import { createToolRunner, defineTool } from "@intx/agent";
import { defineCredentialedToolPackage } from "@workbench/tool-credentials/factory";
import {
  SAFE_EXA_SEARCH_DEFINITION,
  SAFE_GITHUB_ACTIVITY_DEFINITION,
  SAFE_REDDIT_SEARCH_DEFINITION,
  SAFE_X_SEARCH_DEFINITION,
  SAFE_YOUTUBE_SEARCH_DEFINITION,
  createSafeExaTools,
  createSafeGitHubTools,
  createSafeKeylessTools,
  createSafeRedditTools,
  createSafeXTools,
  createSafeYouTubeTools,
} from "./tools";

export const last30daysSafeExa = defineCredentialedToolPackage({
  id: "@workbench/workflow-last30days-research/exa-safe",
  provider: "exa",
  entries: {
    [SAFE_EXA_SEARCH_DEFINITION.name]: {
      sideEffect: "read",
      createTools: createSafeExaTools,
    },
  },
});

export const last30daysSafeGithub = defineCredentialedToolPackage({
  id: "@workbench/workflow-last30days-research/github-safe",
  provider: "github",
  entries: {
    [SAFE_GITHUB_ACTIVITY_DEFINITION.name]: {
      sideEffect: "read",
      createTools: createSafeGitHubTools,
    },
  },
});

export const last30daysSafeReddit = defineCredentialedToolPackage({
  id: "@workbench/workflow-last30days-research/reddit-safe",
  provider: "scrapecreators",
  entries: {
    [SAFE_REDDIT_SEARCH_DEFINITION.name]: {
      sideEffect: "read",
      createTools: createSafeRedditTools,
    },
  },
});

export const last30daysSafeX = defineCredentialedToolPackage({
  id: "@workbench/workflow-last30days-research/x-safe",
  provider: "xai",
  entries: {
    [SAFE_X_SEARCH_DEFINITION.name]: {
      sideEffect: "read",
      createTools: createSafeXTools,
    },
  },
});

export const last30daysSafeYoutube = defineCredentialedToolPackage({
  id: "@workbench/workflow-last30days-research/youtube-safe",
  provider: "youtube",
  entries: {
    [SAFE_YOUTUBE_SEARCH_DEFINITION.name]: {
      sideEffect: "read",
      createTools: createSafeYouTubeTools,
    },
  },
});

export const last30daysSafeKeyless = defineTool({
  id: "@workbench/workflow-last30days-research/keyless-safe",
  factory: () => createToolRunner(createSafeKeylessTools()),
});
