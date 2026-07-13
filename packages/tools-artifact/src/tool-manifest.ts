import { manifestFromHubToolEntries } from "@workbench/tool-manifest";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-artifact/artifact",
      packageName: "@workbench/tools-artifact",
      providerName: null,
      entries: {
        artifact_create: {
          sideEffect: "write",
        },
        artifact_read: {
          sideEffect: "read",
        },
        artifact_read_chunk: {
          sideEffect: "read",
        },
        artifact_write: {
          sideEffect: "write",
        },
        artifact_list: {
          sideEffect: "read",
        },
        artifact_find_by_title: {
          sideEffect: "read",
        },
        artifact_link_file: {
          sideEffect: "write",
        },
        artifact_link_presentation: {
          sideEffect: "write",
        },
        artifact_link_gamma_presentation: {
          sideEffect: "write",
        },
        write_artifact: {
          sideEffect: "write",
        },
        memory_load: {
          sideEffect: "read",
        },
        memory_save: {
          sideEffect: "write",
        },
      },
      myraCatalog: {
        catalogPackage: "artifacts",
        summary:
          "Advanced artifact tools — chunked reads, lookup by title, linking.",
        tags: ["artifact", "deliverable", "chunk", "link", "presentation"],
      },
      credentialCatalog: null,
    }),
  ],
};
