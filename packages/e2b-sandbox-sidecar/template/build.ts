// Restructured from the private repo faremeter/interchange-e2b-provisioner
// (github.com/faremeter/interchange-e2b-provisioner) at commit c1e3182. We
// now own this code; it is not a vendored path.

import { Template, defaultBuildLogger } from "e2b";

import { createSidecarTemplate } from "./definition";

const apiKey = process.env["E2B_API_KEY"];
if (apiKey === undefined || !apiKey.startsWith("e2b_")) {
  throw new Error("E2B_API_KEY is required to build the template");
}

const templateName =
  process.env["E2B_TEMPLATE_NAME"] ?? "interchange-sidecar";
const template = createSidecarTemplate();

const build = await Template.build(template, templateName, {
  apiKey,
  cpuCount: 2,
  memoryMB: 2_048,
  onBuildLogs: defaultBuildLogger(),
});

process.stdout.write(
  `Built E2B template ${build.name} (${build.templateId})\nE2B_TEMPLATE=${build.templateId}\n`,
);
