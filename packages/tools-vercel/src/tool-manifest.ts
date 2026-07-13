import { manifestFromHubToolEntries } from "@workbench/tool-manifest";
import { VERCEL_HUB_TOOLS } from "./index";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-vercel/deploy-artifact",
      packageName: "@workbench/tools-vercel",
      providerName: null,
      entries: {
        vercel_deploy_artifact: {
          sideEffect: "write",
        },
      },
      myraCatalog: null,
      credentialCatalog: null,
    }),
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-vercel/vercel",
      packageName: "@workbench/tools-vercel",
      providerName: "vercel",
      entries: VERCEL_HUB_TOOLS,
      myraCatalog: {
        catalogPackage: "vercel",
        summary: "Vercel — projects, deployments, and static/artifact deploys.",
        tags: ["vercel", "deploy", "deployment", "hosting", "projects"],
      },
      credentialCatalog: {
        label: "Vercel",
      },
    }),
  ],
};
