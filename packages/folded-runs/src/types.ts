// Shared dependency and result shapes for the folded-run machinery.
// Every side effect that touches a real host — the database, the
// session service, the sidecar router, the event-collector
// registry — arrives as an injected port; this package never imports
// a hub or a host-specific package such as `@corbits/chat`.
import type { DB } from "@intx/db";
import type {
  CredentialBinding,
  CredentialCipher,
  GrantEffect,
} from "@intx/types";
import type { ToolPackagePin } from "@intx/types/tool-packages";
import type {
  AssetService,
  EventCollectorRegistry,
  SessionService,
  SidecarRouter,
} from "@intx/hub-sessions";

/**
 * One grant a pinned tool package contributes to a folded run's
 * deploy-time `config.grants`. Usually a `tool:<qualifiedId>` / `invoke`
 * pair: `resource` already prefixed (`tool:<factory.id>:<definition.name>`,
 * the exact shape the workflow child's authz gate matches against — see
 * `vendor/intx/tool-packaging/src/loader.ts`'s `applyNamespacePrefix`
 * and `vendor/intx/inference/src/authz-extension.ts`'s `beforeTool`) and
 * `effect` the tool's static approval floor (`@intx/agent`'s
 * `toolApprovalEffect`: `"ask"` for a tool declared `approval: "ask"`,
 * `"allow"` otherwise). A pinned package whose HTTP surface itself gates
 * on `requireGrant("<resource>", "<action>")` — `@corbits/memory-tools`
 * pinning `@corbits/memory`'s `memory`/`add` and `memory`/`search`, e.g.
 * (CL-6296) — contributes that resource/action pair directly instead,
 * which is why `action` is a plain string rather than fixed to `"invoke"`.
 */
export type PinnedToolGrantDeclaration = {
  readonly resource: string;
  readonly action: string;
  readonly effect: GrantEffect;
};

/**
 * Derives the `tool:` grant declarations a folded run's pinned tool
 * packages need at deploy time. `deployAtHead` calls this with the
 * launch's `toolPackagePins` and folds the result into
 * `HarnessConfig.grants`, the array the sidecar writes verbatim to
 * `state/grants.json` (the file the spawned child's `authorize` closure
 * actually reads — see `apps/sidecar/src/workflow-host-wiring/index.ts`'s
 * "Grants bridge" write and `vendor/intx/workflow-host/src/supervisor/credentials.ts`'s
 * `assembleCredentialsSnapshot`). Without this, a pinned tool package's
 * calls fail closed with "No matching grants" — the deploy-time
 * capability walk (`vendor/intx/workflow-deploy/src/capability-walk.ts`)
 * only derives `tool:` grants for inline tool factories, never for
 * `toolPackagePins`.
 *
 * The composition root (`apps/hub`) supplies the real implementation,
 * built from `@corbits/tool-registry-publish`'s
 * `describeCorbitsToolPackages()` — `folded-runs` never imports that
 * package itself, so this package stays ignorant of which tool
 * packages exist.
 */
export type ToolGrantsForPins = (
  pins: readonly ToolPackagePin[],
) => readonly PinnedToolGrantDeclaration[];

/**
 * Derives the extra `@corbits/mcp-tools` credential bindings a folded run's
 * launch needs for its tenant's connected MCP servers. `mcp-tools`' handles
 * are dynamic (one `mcp:<slug>` per tenant-connected server, unknown at
 * package-publish time), so its `package.json` declares no static
 * `interchange.credentials` entry the deploy-time capability walk
 * (`vendor/intx/workflow-deploy/src/capability-walk.ts`) could turn into a
 * binding — without this port, `env.credentials.resolve("mcp:<slug>")`
 * always throws "not connected" even when the tenant's credential exists.
 * `deployAtHead` calls this whenever `@corbits/mcp-tools` is among a
 * launch's `toolPackagePins`, mirroring `ToolGrantsForPins`'s reason for
 * living here rather than in the capability walk.
 *
 * The composition root (`apps/hub`) supplies the real implementation, built
 * from `@corbits/connections`' `listMcpServerConnections` — `folded-runs`
 * never imports that package itself.
 */
export type McpCredentialBindingsFor = (
  tenantId: string,
) => Promise<readonly CredentialBinding[]>;

export type FoldedRunsDeps = {
  db: DB["db"];
  sessionService: SessionService;
  assetService: AssetService;
  sidecarRouter: SidecarRouter;
  eventCollectors: EventCollectorRegistry;
  /**
   * Decrypts credential secrets when a launch resolves inference sources
   * against the tenant catalog (`resolveDefinitionSources`, called from
   * `deployAtHead`). Optional: omitted, `resolveDefinitionSources` falls
   * back to a noop cipher that returns a stored secret unchanged — correct
   * only when the secret was itself written unencrypted. The composition
   * root (`apps/hub`) must supply the same real cipher its credential
   * write route encrypts with, or every folded-run launch (workbench hosts,
   * invited agents, routines, tasks) decrypts nothing and hands the raw
   * ciphertext to the provider as its API key.
   */
  credentialCipher?: CredentialCipher;
  /**
   * The hub's hex-encoded Ed25519 signing public key — the same value the
   * sidecar router is created with. `deployAtHead` deploys a folded run
   * as an explicit single-step workflow (so it can declare the step's
   * `triggers: "unbounded"` budget) and that deploy carries the hub key.
   */
  hubPublicKey: string;
  /** See `ToolGrantsForPins`'s own doc. */
  toolGrantsForPins: ToolGrantsForPins;
  /**
   * See `McpCredentialBindingsFor`'s own doc. Optional: a caller that never
   * pins `@corbits/mcp-tools` (every launcher besides the hub's real chat
   * composition today) has no need to supply it.
   */
  mcpCredentialBindingsFor?: McpCredentialBindingsFor;
};

export type SentFoldedMail = {
  readonly id: string;
  readonly createdAt: string;
};

export type ListedFoldedMailItem = {
  readonly id: string;
  readonly createdAt: string;
  readonly mail: unknown;
};

export type ListedFoldedMail = {
  readonly items: readonly ListedFoldedMailItem[];
  readonly nextCursor?: string;
};
