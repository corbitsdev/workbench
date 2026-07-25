import { manifestFromHubToolEntries } from "@workbench/tool-manifest";
import {
  SAFE_EXA_SEARCH_DEFINITION,
  SAFE_GITHUB_ACTIVITY_DEFINITION,
  SAFE_HACKERNEWS_SEARCH_DEFINITION,
  SAFE_POLYMARKET_ODDS_DEFINITION,
  SAFE_REDDIT_SEARCH_DEFINITION,
  SAFE_X_SEARCH_DEFINITION,
  SAFE_YOUTUBE_SEARCH_DEFINITION,
} from "./tools";

const PACKAGE_NAME = "@workbench/workflow-last30days-research";

// Every credentialed factory below declares `providerName: null` even though
// its runtime `interchange-tools.ts` factory genuinely requires a tenant
// credential (exa/github/scrapecreators/xai/youtube). This is NOT keyless —
// it works around a real, load-time-enforced invariant:
// `derivePackageProviders` (`@workbench/tool-manifest`) throws if any two
// factories sharing one `packageName` declare different providers, because
// `PACKAGE_PROVIDERS_TABLE` is keyed by package name (one provider per
// pinned npm package). This package wraps FIVE different providers, so it
// cannot itself claim any of them in the manifest.
//
// The actual credential authorization instead rides on the SIBLING upstream
// package each wrapper's workflow step also declares in `effect.requires`
// (see `SAFE_SOURCE_HANDLERS`/`sourceStep` in `../index.ts`): declaring both
// the wrapper's canonical name AND the real tool's canonical name (e.g.
// `last30days_safe_exa_search` + `exa_search`) makes the deploy's capability
// walk (`toolPackagesForCapabilities`) ALSO pin `@workbench/tools-exa` —
// whose own manifest legitimately declares `providerName: "exa"` — so the
// step's credential-route allow-list includes "exa" via that sibling pin.
// The sidecar's per-package `requires: [toolCredentialEnvKey(provider)]`
// (set in `../interchange-tools.ts`, unrelated to this manifest) still runs
// for real and receives the credential once it is allowed.
export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: `${PACKAGE_NAME}/exa-safe`,
      packageName: PACKAGE_NAME,
      providerName: null,
      entries: {
        [SAFE_EXA_SEARCH_DEFINITION.name]: { sideEffect: "read" },
      },
      myraCatalog: null,
      credentialCatalog: null,
    }),
    manifestFromHubToolEntries({
      factoryId: `${PACKAGE_NAME}/github-safe`,
      packageName: PACKAGE_NAME,
      providerName: null,
      entries: {
        [SAFE_GITHUB_ACTIVITY_DEFINITION.name]: { sideEffect: "read" },
      },
      myraCatalog: null,
      credentialCatalog: null,
    }),
    manifestFromHubToolEntries({
      factoryId: `${PACKAGE_NAME}/reddit-safe`,
      packageName: PACKAGE_NAME,
      providerName: null,
      entries: {
        [SAFE_REDDIT_SEARCH_DEFINITION.name]: { sideEffect: "read" },
      },
      myraCatalog: null,
      credentialCatalog: null,
    }),
    manifestFromHubToolEntries({
      factoryId: `${PACKAGE_NAME}/x-safe`,
      packageName: PACKAGE_NAME,
      providerName: null,
      entries: {
        [SAFE_X_SEARCH_DEFINITION.name]: { sideEffect: "read" },
      },
      myraCatalog: null,
      credentialCatalog: null,
    }),
    manifestFromHubToolEntries({
      factoryId: `${PACKAGE_NAME}/youtube-safe`,
      packageName: PACKAGE_NAME,
      providerName: null,
      entries: {
        [SAFE_YOUTUBE_SEARCH_DEFINITION.name]: { sideEffect: "read" },
      },
      myraCatalog: null,
      credentialCatalog: null,
    }),
    manifestFromHubToolEntries({
      factoryId: `${PACKAGE_NAME}/keyless-safe`,
      packageName: PACKAGE_NAME,
      providerName: null,
      entries: {
        [SAFE_HACKERNEWS_SEARCH_DEFINITION.name]: { sideEffect: "read" },
        [SAFE_POLYMARKET_ODDS_DEFINITION.name]: { sideEffect: "read" },
      },
      myraCatalog: null,
      credentialCatalog: null,
    }),
  ],
};
