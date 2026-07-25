import { manifestFromHubToolEntries } from "@workbench/tool-manifest";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-heartbeat/core",
      packageName: "@workbench/tools-heartbeat",
      providerName: null,
      entries: {
        heartbeat_format_brief_title: {
          sideEffect: "read",
        },
        heartbeat_format_brief_document: {
          sideEffect: "read",
        },
        heartbeat_format_brief_notify: {
          sideEffect: "read",
        },
      },
      myraCatalog: null,
      credentialCatalog: null,
    }),
  ],
};
