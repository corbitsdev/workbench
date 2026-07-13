import { manifestFromHubToolEntries } from "@workbench/tool-manifest";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-fileparser/fileparser",
      packageName: "@workbench/tools-fileparser",
      providerName: null,
      entries: {
        parse_file: {
          sideEffect: "read",
        },
      },
      myraCatalog: {
        catalogPackage: "fileparser",
        summary: "Document parsing — read PDFs, documents, and images as text.",
        tags: ["file", "parse", "pdf", "document", "ocr", "attachment"],
      },
      credentialCatalog: null,
    }),
  ],
};
