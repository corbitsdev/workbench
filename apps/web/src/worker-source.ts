// The stock deploy route requires a `workflow`-kind asset, and a
// `workflow` asset only takes its code by git push — the one variant it
// can anchor from a browser.
import { type } from "arktype";

export const WorkerSourceConfig = type({
  assetKind: "'workflow'",
  assetName: "string > 0",
  displayName: "string > 0",
  packageName: "string > 0",
  entryPath: "string > 0",
});
export type WorkerSourceConfig = typeof WorkerSourceConfig.infer;

const parsed = WorkerSourceConfig({
  assetKind: "workflow",
  assetName: "worker-deploy-source",
  displayName: "New worker",
  packageName: "@workbench/worker",
  entryPath: "./workflow.js",
});
if (parsed instanceof type.errors) {
  throw new Error(`invalid WORKER_SOURCE_CONFIG literal: ${parsed.summary}`);
}
export const WORKER_SOURCE_CONFIG: WorkerSourceConfig = parsed;
