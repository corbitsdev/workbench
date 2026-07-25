// Native `interchange.tools` entries for @workbench/workflow-last30days-research.
//
// Five credentialed factories (one per provider the wrapped source needs —
// `exa`/`github`/`scrapecreators`/`xai`/`youtube`), each mirroring the
// upstream tool package's own `defineCredentialedToolPackage` call so the
// SAME tenant credential resolves the SAME way. A sixth, keyless factory
// bundles the two public-API sources (`hackernews_search`, `polymarket_odds`)
// that need no credential at all. See `./tools.ts` for why these wrappers
// exist (replacing `nonFatal` deterministic steps with native
// `action` primitives).
//
// Each credentialed factory is built with `defineTool` directly, NOT
// `defineCredentialedToolPackage` (a fix): the credential is resolved
// lazily inside the handler via `createLazySafeCredentialedTool`, so factory
// construction always succeeds and a missing tenant credential degrades to
// the wrapper's own `{ isError: true, error }` envelope instead of the
// sidecar silently dropping the whole package and hard-failing the step.

import { createToolRunner, defineTool } from "@intx/agent";
import { toolCredentialEnvKey } from "@workbench/tool-credentials";
import {
  SAFE_EXA_SEARCH_DEFINITION,
  SAFE_GITHUB_ACTIVITY_DEFINITION,
  SAFE_REDDIT_SEARCH_DEFINITION,
  SAFE_X_SEARCH_DEFINITION,
  SAFE_YOUTUBE_SEARCH_DEFINITION,
  createLazySafeCredentialedTool,
  createSafeExaTools,
  createSafeGitHubTools,
  createSafeKeylessTools,
  createSafeRedditTools,
  createSafeXTools,
  createSafeYouTubeTools,
} from "./tools";

export const last30daysSafeExa = defineTool({
  id: "@workbench/workflow-last30days-research/exa-safe",
  requires: [toolCredentialEnvKey("exa")],
  factory: (env) =>
    createToolRunner([
      createLazySafeCredentialedTool({
        provider: "exa",
        definition: SAFE_EXA_SEARCH_DEFINITION,
        buildSafeTools: createSafeExaTools,
      })(env as unknown as Record<string, unknown>),
    ]),
});

export const last30daysSafeGithub = defineTool({
  id: "@workbench/workflow-last30days-research/github-safe",
  requires: [toolCredentialEnvKey("github")],
  factory: (env) =>
    createToolRunner([
      createLazySafeCredentialedTool({
        provider: "github",
        definition: SAFE_GITHUB_ACTIVITY_DEFINITION,
        buildSafeTools: createSafeGitHubTools,
      })(env as unknown as Record<string, unknown>),
    ]),
});

export const last30daysSafeReddit = defineTool({
  id: "@workbench/workflow-last30days-research/reddit-safe",
  requires: [toolCredentialEnvKey("scrapecreators")],
  factory: (env) =>
    createToolRunner([
      createLazySafeCredentialedTool({
        provider: "scrapecreators",
        definition: SAFE_REDDIT_SEARCH_DEFINITION,
        buildSafeTools: createSafeRedditTools,
      })(env as unknown as Record<string, unknown>),
    ]),
});

export const last30daysSafeX = defineTool({
  id: "@workbench/workflow-last30days-research/x-safe",
  requires: [toolCredentialEnvKey("xai")],
  factory: (env) =>
    createToolRunner([
      createLazySafeCredentialedTool({
        provider: "xai",
        definition: SAFE_X_SEARCH_DEFINITION,
        buildSafeTools: createSafeXTools,
      })(env as unknown as Record<string, unknown>),
    ]),
});

export const last30daysSafeYoutube = defineTool({
  id: "@workbench/workflow-last30days-research/youtube-safe",
  requires: [toolCredentialEnvKey("youtube")],
  factory: (env) =>
    createToolRunner([
      createLazySafeCredentialedTool({
        provider: "youtube",
        definition: SAFE_YOUTUBE_SEARCH_DEFINITION,
        buildSafeTools: createSafeYouTubeTools,
      })(env as unknown as Record<string, unknown>),
    ]),
});

export const last30daysSafeKeyless = defineTool({
  id: "@workbench/workflow-last30days-research/keyless-safe",
  factory: () => createToolRunner(createSafeKeylessTools()),
});
