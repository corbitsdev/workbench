// Myra's deploy source, pinned to what this hub can actually install
// today.
//
// `@corbits/myra` (agents/myra) is `private: true`
// and unpublished, so `WorkflowDefinitionRegistrySource` (the `registry`
// variant) has no external npm registry to resolve it from yet — that is
// its job. The package also exports builder functions
// (`buildAssistantWorkflow`), not a default-exported `WorkflowDefinition`,
// so pointing a git `asset` "source" install at the real workspace
// package would fail the source-tree installer's shape checks too.
//
// The one variant that installs cleanly today, entirely over stock
// routes and with no hub or seed change, is the same shape
// `the deleted onboarding package's `seedTenant` and the e2e harness already push:
// the built definition rendered as the two-file source package
// `@corbits/workflows`' `renderWorkflowSourceTree` emits, published as a
// `tarball` inside a stock `package-registry` asset via `PUT
// /api/tenants/:id/assets/:assetId/tarballs/:filename` — a route that
// takes raw tarball bytes over plain `fetch`, no git protocol, no
// system git binary, so it is the only variant reachable from a browser
// SPA like `apps/web`. `myra-deploy.ts` drives it.
import { type } from "arktype";

export const MyraSourceConfig = type({
  assetKind: "'package-registry'",
  assetName: "string > 0",
  displayName: "string > 0",
  packageName: "string > 0",
  packageVersion: "string > 0",
  entryPath: "string > 0",
});
export type MyraSourceConfig = typeof MyraSourceConfig.infer;

const parsed = MyraSourceConfig({
  assetKind: "package-registry",
  // Distinct from `SETUP_AGENT_ASSET_NAME` ("assistant", a `workflow`-kind
  // asset `seedTenant` owns): this is a `package-registry`-kind asset,
  // a different asset namespace, so it never collides with a seeded
  // tenant's own asset.
  assetName: "myra-deploy-source",
  displayName: "Myra",
  // The rendered package's own name — never `@corbits/myra`
  // itself, which names the real, un-deployable workspace package this
  // module explicitly does not source from (see the module doc above).
  packageName: "@workbench-onboarding/myra",
  packageVersion: "0.0.0",
  entryPath: "./workflow.js",
});
if (parsed instanceof type.errors) {
  throw new Error(`invalid MYRA_SOURCE_CONFIG literal: ${parsed.summary}`);
}
export const MYRA_SOURCE_CONFIG: MyraSourceConfig = parsed;
