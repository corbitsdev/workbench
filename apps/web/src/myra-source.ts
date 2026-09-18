// The stock deploy route requires a `workflow`-kind asset, and a
// `workflow` asset only takes its code by git push — the one variant it
// can anchor from a browser.
import { type } from "arktype";

export const MyraSourceConfig = type({
  assetKind: "'workflow'",
  assetName: "string > 0",
  displayName: "string > 0",
  packageName: "string > 0",
  entryPath: "string > 0",
});
export type MyraSourceConfig = typeof MyraSourceConfig.infer;

const parsed = MyraSourceConfig({
  assetKind: "workflow",
  assetName: "myra-deploy-source",
  displayName: "Myra",
  packageName: "@workbench-onboarding/myra",
  entryPath: "./workflow.js",
});
if (parsed instanceof type.errors) {
  throw new Error(`invalid MYRA_SOURCE_CONFIG literal: ${parsed.summary}`);
}
export const MYRA_SOURCE_CONFIG: MyraSourceConfig = parsed;
