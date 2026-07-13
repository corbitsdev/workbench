import { manifestFromHubToolEntries } from "@workbench/tool-manifest";
import { DISPATCH_HUB_TOOLS } from "./index";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-dispatch/dispatch",
      packageName: "@workbench/tools-dispatch",
      providerName: null,
      entries: DISPATCH_HUB_TOOLS,
      myraCatalog: null,
      credentialCatalog: null,
    }),
  ],
};
