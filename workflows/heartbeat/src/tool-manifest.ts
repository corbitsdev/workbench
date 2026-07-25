import { manifestFromHubToolEntries } from "@workbench/tool-manifest";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/workflow-heartbeat/core",
      packageName: "@workbench/workflow-heartbeat",
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
        heartbeat_intake_source: {
          sideEffect: "read",
        },
      },
      myraCatalog: null,
      credentialCatalog: null,
    }),
  ],
};
