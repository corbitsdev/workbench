import {
  defineCredentialedToolPackage,
  defineHubBackedToolPackage,
} from "@workbench/tool-credentials/factory";
import { VERCEL_DEPLOY_ARTIFACT_DEFINITION, VERCEL_HUB_TOOLS } from "./index";

export const vercel = defineCredentialedToolPackage({
  id: "@workbench/tools-vercel/vercel",
  provider: "vercel",
  entries: VERCEL_HUB_TOOLS,
});

export const vercelDeployArtifact = defineHubBackedToolPackage({
  id: "@workbench/tools-vercel/deploy-artifact",
  definitions: [VERCEL_DEPLOY_ARTIFACT_DEFINITION],
});
