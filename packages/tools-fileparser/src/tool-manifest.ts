import {
  hubToolEntriesFromDefinitions,
  manifestFromHubToolEntries,
  type ToolSideEffect,
} from "@workbench/tool-manifest";
import { FILEPARSER_TOOL_DEFINITIONS } from "./definitions";

const SIDE_EFFECTS: Record<string, ToolSideEffect> = {
  parse_file: "read",
};

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-fileparser/fileparser",
      packageName: "@workbench/tools-fileparser",
      providerName: null,
      entries: hubToolEntriesFromDefinitions(
        FILEPARSER_TOOL_DEFINITIONS,
        SIDE_EFFECTS,
      ),
      myraCatalog: {
        catalogPackage: "fileparser",
        summary: "Document parsing — read PDFs, documents, and images as text.",
        tags: ["file", "parse", "pdf", "document", "ocr", "attachment"],
      },
      credentialCatalog: null,
    }),
  ],
};
