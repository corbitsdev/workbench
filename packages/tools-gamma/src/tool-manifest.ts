import { manifestFromHubToolEntries } from "@workbench/tool-manifest";
import { GAMMA_HUB_TOOLS } from "./index";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-gamma/gamma",
      packageName: "@workbench/tools-gamma",
      providerName: "gamma",
      entries: GAMMA_HUB_TOOLS,
      myraCatalog: null,
      credentialCatalog: {
        label: "Gamma",
      },
    }),
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-gamma/gamma-templates",
      packageName: "@workbench/tools-gamma",
      providerName: null,
      entries: {
        gamma_list_templates: {
          sideEffect: "read",
        },
      },
      myraCatalog: null,
      credentialCatalog: null,
    }),
  ],
};
