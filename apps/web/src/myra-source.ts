// Myra's deploy source: a `workflow`-kind asset holding the two-file
// codebase `renderWorkflowSourceTree` emits, pushed over the stock git
// smart-HTTP route and deployed as a source tree at that commit. That is
// the one variant the stock deploy route can anchor from a browser: it
// requires a `workflow`-kind asset, and a `workflow` asset only takes its
// code by git push.
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
