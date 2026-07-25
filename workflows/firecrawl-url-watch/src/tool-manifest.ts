import { manifestFromHubToolEntries } from "@workbench/tool-manifest";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-firecrawl-url-watch/core",
      packageName: "@workbench/tools-firecrawl-url-watch",
      providerName: null,
      entries: {
        firecrawl_url_watch_format_document: {
          sideEffect: "read",
        },
      },
      myraCatalog: null,
      credentialCatalog: null,
    }),
  ],
};
