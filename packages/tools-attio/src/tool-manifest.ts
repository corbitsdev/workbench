import { manifestFromHubToolEntries } from "@workbench/tool-manifest";
import { ATTIO_HUB_TOOLS } from "./index";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-attio/attio",
      packageName: "@workbench/tools-attio",
      providerName: "attio",
      entries: ATTIO_HUB_TOOLS,
      myraCatalog: {
        catalogPackage: "attio",
        summary: "Attio CRM — companies, people, deals, tasks, and notes.",
        tags: [
          "crm",
          "attio",
          "companies",
          "people",
          "deals",
          "contacts",
          "tasks",
        ],
      },
      credentialCatalog: {
        label: "Attio",
      },
    }),
  ],
};
