import { createSSHSignature } from "@intx/crypto";
import type { GCPolicy } from "@workbench/storage-isogit";
import type { ToolPackageManifest } from "@intx/types/tool-packages";

import { createRepoStore } from "./repo-store";
import type {
  AuthorizeFn,
  KindHandler,
  RepoId,
  RepoKind,
  RepoStore,
} from "./repo-store";
import {
  agentStateKindHandler,
  agentStateAuthorize,
  AGENT_STATE_DEPLOY_REF,
  type AgentStateHubPrincipal,
  type AgentStateSidecarPrincipal,
} from "./agent-state-kind";
import { skillKindHandler, skillAuthorize } from "./skill-kind";
import {
  packageRegistryKindHandler,
  packageRegistryAuthorize,
} from "./package-registry-kind";
import { workflowKindHandler, workflowAuthorize } from "./workflow-kind";
import {
  workflowRunKindHandler,
  workflowRunAuthorize,
  type WorkflowRunSupervisorPrincipal,
} from "./workflow-run-kind";

// WORKBENCH-LOCAL (CL-4231): a registered kind pairs the substrate's
// `KindHandler` (directoryPrefix + validatePush + onRefUpdated) with the
// `authorize` function `createAgentRepoStore` used to dispatch by a
// hardcoded switch. Bundling both here lets `handlers` (below) be the
// single seam a caller extends to register a whole new asset kind —
// content validation and access control together — without editing this
// file's switch statement per addition.
export type RegisteredKindHandler = {
  handler: KindHandler;
  authorize: AuthorizeFn;
};

const BUILT_IN_KIND_HANDLERS: Readonly<
  Record<RepoKind, RegisteredKindHandler>
> = {
  "agent-state": {
    handler: agentStateKindHandler,
    authorize: agentStateAuthorize,
  },
  skill: { handler: skillKindHandler, authorize: skillAuthorize },
  "package-registry": {
    handler: packageRegistryKindHandler,
    authorize: packageRegistryAuthorize,
  },
  workflow: { handler: workflowKindHandler, authorize: workflowAuthorize },
  "workflow-run": {
    handler: workflowRunKindHandler,
    authorize: workflowRunAuthorize,
  },
};

export type DeployContent = {
  systemPrompt: string;
  /**
   * Optional. When present, written to
   * `deploy/tool-packages-manifest.json` so the sidecar's loader can
   * materialize the pinned tool-package closure on apply.
   */
  toolPackageManifest?: ToolPackageManifest;
  /**
   * Optional. `assetId` → workspace-relative mount path for every
   * asset id referenced by a `kind: "asset"` entry in
   * `toolPackageManifest`. When present, written to
   * `deploy/asset-mounts.json`; the sidecar's loader reads it back via
   * `readDeployTree` and resolves asset-sourced tarballs against it.
   * Empty maps and absent values produce no file on disk — both shapes
   * read back as an empty mount table.
   */
  assetMounts?: ReadonlyMap<string, string>;
};

export type AgentRepoStore = {
  /**
   * Write deploy content into the agent's hub-side repo and commit on
   * refs/heads/deploy. Creates the repo if it doesn't exist.
   *
   * The caller is responsible for serializing calls per agent.
   */
  writeDeployTree(
    agentId: string,
    content: DeployContent,
  ): Promise<{ commitSha: string }>;

  /**
   * Produce a packfile from the agent's current deploy ref.
   */
  createDeployPack(
    agentId: string,
  ): Promise<{ pack: Uint8Array; commitSha: string; ref: string }>;

  /**
   * Receive and store an agent-state pack from a sidecar. Indexes the
   * pack objects and updates the ref without materializing a working
   * tree.
   *
   * `repoId.kind` must be `"agent-state"`. The `repoId.id` is used as
   * the agent address internally. Stamps an
   * `AgentStateSidecarPrincipal` so the agent-state kind handler
   * authorizes the receivePack as a per-agent sidecar write.
   */
  receiveAgentStatePack(
    repoId: RepoId,
    pack: Uint8Array,
    ref: string,
    commitSha: string,
  ): Promise<void>;

  /**
   * Receive and store a workflow-run pack from a sidecar. Indexes the
   * pack objects and updates the ref without materializing a working
   * tree.
   *
   * `repoId.kind` must be `"workflow-run"`. Stamps a
   * `WorkflowRunSupervisorPrincipal` whose `deploymentId` equals
   * `repoId.id`; the workflow-run kind handler denies sidecar-kind
   * writes by design, so the supervisor branch is the correct path for
   * sidecar-originated run-event commits (the supervisor lives on the
   * sidecar and is the actual signer of the run events).
   */
  receiveWorkflowRunPack(
    repoId: RepoId,
    pack: Uint8Array,
    ref: string,
    commitSha: string,
  ): Promise<void>;

  /** Resolve the current deploy ref SHA, or null if no deploy exists. */
  getDeployRef(agentId: string): Promise<string | null>;

  /** Raw 32-byte Ed25519 public key used to sign deploy commits. */
  getSigningPublicKey(): Uint8Array;

  /**
   * Underlying kind-keyed substrate. Exposed so callers that need to
   * operate on non-agent-state kinds (e.g. the asset service writing
   * skill repos) can share the same on-disk root and signing key
   * without spinning up a parallel RepoStore.
   */
  readonly repoStore: RepoStore;

  /**
   * WORKBENCH-LOCAL (CL-4231): every kind this store has a registered
   * handler for — the five built-ins plus any caller-supplied `handlers`
   * entries. `asset-service.ts` validates `createAsset`/row-mapping
   * against this set instead of a hardcoded allowlist, so a registered
   * kind passes and an unregistered one still fails loudly.
   */
  readonly registeredKinds: ReadonlySet<RepoKind>;
};

export function createAgentRepoStore(config: {
  dataDir: string;
  signingKey: { privateKey: Uint8Array; publicKey: Uint8Array };
  /**
   * Optional write-path GC policy for the agent-state repos this store
   * owns. Scoped to the `agent-state` kind; the other kinds the
   * underlying substrate services are left untouched.
   */
  gc?: GCPolicy;
  /**
   * WORKBENCH-LOCAL (CL-4231): additional kind handlers, MERGED with the
   * five built-ins (agent-state, skill, package-registry, workflow,
   * workflow-run) rather than replacing them. This is the seam that
   * opens the closed asset-kind set from the caller side without
   * touching the `interchange/` submodule (`RepoKind` itself stays the
   * closed `@intx/types/sidecar` enum; the widened local `RepoKind` in
   * `./repo-store/types.ts` is what lets a custom kind typecheck here).
   * A caller-supplied kind that collides with a built-in name throws at
   * construction time — a typo must never silently shadow a built-in
   * handler.
   */
  handlers?: Readonly<Record<string, RegisteredKindHandler>>;
}): AgentRepoStore {
  const { dataDir, signingKey, gc } = config;

  const extraHandlers = config.handlers ?? {};
  // WORKBENCH-LOCAL (CL-4231): both the kind name AND the directoryPrefix
  // must be unique across built-ins and caller-supplied handlers. A name
  // collision would silently shadow a built-in handler's authorize logic;
  // a directoryPrefix collision is subtler but just as dangerous — two
  // kinds writing under the same on-disk prefix would silently overwrite
  // each other's repos with no error at all. Both must throw loudly at
  // construction time rather than corrupt data at runtime.
  const prefixToKind = new Map<string, string>();
  for (const [kind, entry] of Object.entries(BUILT_IN_KIND_HANDLERS)) {
    prefixToKind.set(entry.handler.directoryPrefix, kind);
  }
  for (const [kind, entry] of Object.entries(extraHandlers)) {
    if (kind in BUILT_IN_KIND_HANDLERS) {
      throw new Error(
        `createAgentRepoStore: handler kind ${JSON.stringify(kind)} collides with a built-in kind`,
      );
    }
    const existingKind = prefixToKind.get(entry.handler.directoryPrefix);
    if (existingKind !== undefined) {
      throw new Error(
        `createAgentRepoStore: handler kind ${JSON.stringify(kind)} has directoryPrefix ${JSON.stringify(entry.handler.directoryPrefix)} which collides with kind ${JSON.stringify(existingKind)}`,
      );
    }
    prefixToKind.set(entry.handler.directoryPrefix, kind);
  }
  const registered: Record<string, RegisteredKindHandler> = {
    ...BUILT_IN_KIND_HANDLERS,
    ...extraHandlers,
  };
  const registeredKinds = new Set<RepoKind>(Object.keys(registered));

  const authorize: AuthorizeFn = (principal, incomingRepoId, ref, action) => {
    const entry = registered[incomingRepoId.kind];
    if (entry === undefined) {
      return {
        allowed: false,
        reason: `no authorize registered for kind: ${incomingRepoId.kind}`,
      };
    }
    return entry.authorize(principal, incomingRepoId, ref, action);
  };

  // The substrate's signingCallback bridges the agent-repo store's
  // raw Ed25519 keypair to the storage layer's per-payload SSHSIG
  // signer. Skill asset genesis commits and agent-state deploy
  // commits both flow through this signer so that signed commits
  // round-trip through the smart-HTTP layer and verify under
  // `git log --show-signature` and `git verify-commit`.
  const signer = async (payload: string) =>
    createSSHSignature(payload, signingKey.privateKey, signingKey.publicKey);

  const store = createRepoStore({
    dataDir,
    signingKey,
    handlers: Object.fromEntries(
      Object.entries(registered).map(([kind, entry]) => [kind, entry.handler]),
    ),
    authorize,
    signingCallback: () => signer,
    ...(gc === undefined ? {} : { gc: { kinds: ["agent-state"], ...gc } }),
  });

  const hub: AgentStateHubPrincipal = { kind: "hub" };

  function repoId(agentId: string): RepoId {
    return { kind: "agent-state", id: agentId };
  }

  return {
    async writeDeployTree(agentId, content) {
      const id = repoId(agentId);
      const files: Record<string, string> = {
        "deploy/prompt.md": content.systemPrompt,
      };
      if (content.toolPackageManifest !== undefined) {
        files["deploy/tool-packages-manifest.json"] = JSON.stringify(
          content.toolPackageManifest,
          null,
          2,
        );
      }
      if (content.assetMounts !== undefined && content.assetMounts.size > 0) {
        files["deploy/asset-mounts.json"] = JSON.stringify(
          { assetMounts: Object.fromEntries(content.assetMounts) },
          null,
          2,
        );
      }
      return store.writeTree(hub, id, AGENT_STATE_DEPLOY_REF, {
        files,
        clearPrefix: "deploy/",
        message: "Update deploy tree",
      });
    },

    async createDeployPack(agentId) {
      return store.createPack(hub, repoId(agentId), AGENT_STATE_DEPLOY_REF);
    },

    async receiveAgentStatePack(incomingRepoId, pack, ref, commitSha) {
      if (incomingRepoId.kind !== "agent-state") {
        throw new Error(
          `AgentRepoStore.receiveAgentStatePack requires repoId.kind === "agent-state", got ${JSON.stringify(incomingRepoId.kind)}`,
        );
      }
      const agentId = incomingRepoId.id;
      const id = repoId(agentId);
      const principal: AgentStateSidecarPrincipal = {
        kind: "sidecar",
        agentId,
      };
      const expectedOldSha = await store.resolveRef(principal, id, ref);
      await store.receivePack(
        principal,
        id,
        ref,
        pack,
        commitSha,
        expectedOldSha,
      );
    },

    async receiveWorkflowRunPack(incomingRepoId, pack, ref, commitSha) {
      if (incomingRepoId.kind !== "workflow-run") {
        throw new Error(
          `AgentRepoStore.receiveWorkflowRunPack requires repoId.kind === "workflow-run", got ${JSON.stringify(incomingRepoId.kind)}`,
        );
      }
      const principal: WorkflowRunSupervisorPrincipal = {
        kind: "supervisor",
        deploymentId: incomingRepoId.id,
      };
      const expectedOldSha = await store.resolveRef(hub, incomingRepoId, ref);
      await store.receivePack(
        principal,
        incomingRepoId,
        ref,
        pack,
        commitSha,
        expectedOldSha,
      );
    },

    async getDeployRef(agentId) {
      return store.resolveRef(hub, repoId(agentId), AGENT_STATE_DEPLOY_REF);
    },

    getSigningPublicKey() {
      return signingKey.publicKey;
    },

    repoStore: store,
    registeredKinds,
  };
}
