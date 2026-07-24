import { manifestFromHubToolEntries } from "@workbench/tool-manifest";
import { KNOWLEDGE_ENGINE_HUB_TOOLS } from "./index";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId:
        "@workbench/tools-corbits-knowledge-engine/corbits-knowledge-engine",
      packageName: "@workbench/tools-corbits-knowledge-engine",
      providerName: "corbits-knowledge-engine",
      entries: KNOWLEDGE_ENGINE_HUB_TOOLS,
      myraCatalog: {
        catalogPackage: "corbits-knowledge-engine",
        summary:
          "Corbits Knowledge Engine — search and capture the team's shared knowledge base.",
        tags: ["knowledge", "search", "capture", "memory", "evidence"],
      },
      credentialCatalog: {
        label: "Corbits Knowledge Engine",
        secretLabel: "Service token",
        secondaryField: {
          label: "Engine URL",
          placeholder: "https://knowledge-engine.internal",
          required: true,
        },
      },
    }),
  ],
};
