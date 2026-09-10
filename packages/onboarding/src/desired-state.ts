// CL-7584: the per-tenant onboarding contract. The desired state —
// which workflows, tool packages, and skills every real tenant should
// have — is DATA here, a plain const composed BY REFERENCE over the
// existing single-source constants (`DEFAULT_WORKFLOWS`,
// `REQUIRED_SEED_TOOL_PACKAGES`, `DEFAULT_SKILLS`). It is not a hub
// table, not a migration, and never seeded from hub boot: adding a core
// workflow later is an edit to `@corbits/seeding`'s constants, which
// this document mirrors, nothing more.
//
// `reconcileTenantDesiredState` is the one installer: it reads the
// tenant's real state against this document and installs ONLY the
// absent pins. Convergence has three triggers — a tenant-create
// observation, a background drain over a pending credential, and a
// revisit probe (`POST /api/onboarding/provision`) — all of which call
// this one function, so there is exactly one place installation happens
// and exactly one definition of "already done".

import { type } from "arktype";
import { AssetWithOriginResponse, ModelInfo } from "@intx/types";
import {
  DEFAULT_SKILLS,
  DEFAULT_WORKFLOWS,
  fetchRegistryTarballSource,
  installRegistryTarball,
  isCorbitsToolsRegistrySeeded,
  isLiveDeploymentStatus,
  publishCorbitsToolsRegistry,
  REQUIRED_SEED_TOOL_PACKAGES,
  seedTenant,
  type DefaultWorkflow,
  type ModelSource,
  type SeedTenantArgs,
  type ToolRegistryPublisher,
  type WorkflowPusher,
} from "@corbits/seeding";
import {
  isSidecarUnavailableError,
  parseAs,
  type ApiCall,
} from "@corbits/hub-api-client";

export type WorkflowPin = {
  readonly assetName: string;
  readonly displayName: string;
  readonly version: string;
  readonly definition: DefaultWorkflow["buildJson"];
};

export type ToolPackagePin = {
  readonly name: string;
  readonly version: string;
  readonly source:
    | { readonly kind: "workspace-pack" }
    | { readonly kind: "tarball-url"; readonly url: string; readonly integrity: string };
};

export type SkillPin = {
  readonly name: string;
  readonly description: string;
  readonly body: string;
};

export type TenantDesiredState = {
  readonly stateId: string;
  readonly workflows: readonly WorkflowPin[];
  readonly toolPackages: readonly ToolPackagePin[];
  readonly skills: readonly SkillPin[];
};

const WORKFLOW_PIN_VERSION = "1.0.0";
const TOOL_PACKAGE_VERSION = "1.0.0";

/**
 * What every real tenant should have. Myra first (CL-7074); growing the
 * core set later is a data edit upstream, never code here.
 */
export const TENANT_DESIRED_STATE: TenantDesiredState = {
  stateId: "tenant-desired-state-1",
  workflows: DEFAULT_WORKFLOWS.map((workflow) => ({
    assetName: workflow.assetName,
    displayName: workflow.displayName,
    version: WORKFLOW_PIN_VERSION,
    definition: workflow.buildJson,
  })),
  toolPackages: REQUIRED_SEED_TOOL_PACKAGES.map((name) => ({
    name,
    version: TOOL_PACKAGE_VERSION,
    source: { kind: "workspace-pack" as const },
  })),
  skills: DEFAULT_SKILLS.map((skill) => ({ ...skill })),
};

export type PinState = "present" | "pending" | "blocked";

export type DesiredStateStatus = {
  readonly tenantId: string;
  readonly stateId: string;
  readonly ready: boolean;
  readonly workflows: Readonly<Record<string, PinState>>;
  readonly tools: PinState;
  readonly skills: Readonly<Record<string, PinState>>;
};

const WorkflowDeploymentStatus = type({
  definitionAssetId: "string",
  status: "string",
});

/** Which of `pins`' asset names already carry an active deployment on
 * this tenant. The same asset-then-deployment lookup `seedTenant` and
 * `isFullySeeded` perform; parameterized over the doc's pins so the
 * desired-state reader never re-derives it. Read-only. */
export async function seededWorkflowNames(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
  pins: readonly { assetName: string }[],
): Promise<{ deployed: string[]; pending: string[] }> {
  const assetsResponse = await api(
    "GET",
    `/api/tenants/${tenantId}/assets?kind=workflow&inherited=false`,
    undefined,
    cookies,
  );
  const assets = parseAs(
    AssetWithOriginResponse.array(),
    assetsResponse.data,
    "assets response",
  );

  const deploymentsResponse = await api(
    "GET",
    `/api/tenants/${tenantId}/workflows/deployments`,
    undefined,
    cookies,
  );
  const deployments = parseAs(
    WorkflowDeploymentStatus.array(),
    deploymentsResponse.data,
    "deployments response",
  );

  const deployed: string[] = [];
  const pending: string[] = [];
  for (const pin of pins) {
    const asset = assets.find((a) => a.name === pin.assetName);
    const isDeployed =
      asset !== undefined &&
      deployments.some(
        (d) =>
          d.definitionAssetId === asset.id && isLiveDeploymentStatus(d.status),
      );
    (isDeployed ? deployed : pending).push(pin.assetName);
  }
  return { deployed, pending };
}

async function readToolsState(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
): Promise<PinState> {
  try {
    return (await isCorbitsToolsRegistrySeeded(api, cookies, tenantId))
      ? "present"
      : "pending";
  } catch (cause) {
    if (isSidecarUnavailableError(cause)) return "blocked";
    throw cause;
  }
}

async function readSkillState(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
  skill: SkillPin,
): Promise<PinState> {
  try {
    const existing = await api(
      "GET",
      `/api/tenants/${tenantId}/skills/${encodeURIComponent(skill.name)}`,
      undefined,
      cookies,
    );
    if (existing.status === 200) return "present";
    // A 502-class response (or a thrown sidecar-unavailable error) is
    // the sidecar-unavailable class: blocked, not pending.
    return existing.status >= 500 ? "blocked" : "pending";
  } catch (cause) {
    if (isSidecarUnavailableError(cause)) return "blocked";
    throw cause;
  }
}

/**
 * Reads the tenant's real state against the desired-state document,
 * native reads only — never creates, deploys, or publishes anything.
 */
export async function readTenantDesiredStateStatus(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
): Promise<DesiredStateStatus> {
  const { deployed } = await seededWorkflowNames(
    api,
    cookies,
    tenantId,
    TENANT_DESIRED_STATE.workflows,
  );
  const workflows: Record<string, PinState> = {};
  for (const pin of TENANT_DESIRED_STATE.workflows) {
    workflows[pin.assetName] = deployed.includes(pin.assetName)
      ? "present"
      : "pending";
  }
  const tools = await readToolsState(api, cookies, tenantId);
  const skills: Record<string, PinState> = {};
  for (const skill of TENANT_DESIRED_STATE.skills) {
    skills[skill.name] = await readSkillState(api, cookies, tenantId, skill);
  }
  const ready =
    tools === "present" &&
    Object.values(workflows).every((s) => s === "present") &&
    Object.values(skills).every((s) => s === "present");
  return {
    tenantId,
    stateId: TENANT_DESIRED_STATE.stateId,
    ready,
    workflows,
    tools,
    skills,
  };
}

export type DesiredStateStep = {
  readonly name: string;
  readonly label: string;
  readonly status: PinState;
};

/** Labeled, doc-ordered step list for a waiting surface (the
 * onboarding page's finishing-setup view), derived from a status read
 * plus the doc's own labels. */
export function desiredStateSteps(status: DesiredStateStatus): readonly DesiredStateStep[] {
  return [
    ...TENANT_DESIRED_STATE.workflows.map((pin) => ({
      name: pin.assetName,
      label: pin.displayName,
      status: status.workflows[pin.assetName] ?? "pending",
    })),
    ...TENANT_DESIRED_STATE.toolPackages.map((pin) => ({
      name: pin.name,
      label: pin.name,
      status: status.tools,
    })),
    ...TENANT_DESIRED_STATE.skills.map((pin) => ({
      name: pin.name,
      label: pin.name,
      status: status.skills[pin.name] ?? "pending",
    })),
  ];
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

export type ReconcilePinStatus =
  | "present"
  | "installed"
  | "reinstalled"
  | "blocked"
  | "failed";

export type ReconcilePin = {
  readonly name: string;
  readonly kind: "tool-package" | "skill" | "workflow";
  readonly status: ReconcilePinStatus;
};

export type ReconcileReport = {
  readonly tenantId: string;
  readonly ready: boolean;
  readonly pins: readonly ReconcilePin[];
};

export type ReconcileArgs = {
  api: ApiCall;
  cookies: string[];
  hubUrl: string;
  tenant: {
    tenantId: string;
    principalId?: string;
    domain?: string;
  };
  model: ModelSource;
  pushWorkflow: WorkflowPusher;
  /** Defaults to the real `publishCorbitsToolsRegistry`. */
  publishToolRegistry?: ToolRegistryPublisher;
  /** Test seam standing in for the deploy step, the same way
   * `ensureSeeded` accepts one. */
  seedTenantFn?: (args: SeedTenantArgs) => ReturnType<typeof seedTenant>;
  log: (line: string) => void;
};

/**
 * The `ModelSource` a workflow deployment's rendered definition names:
 * the tenant's top-priority resolved catalog offering (inherited
 * included). `undefined` when the tenant has no offerings — nothing is
 * launchable, and the caller reports the workflow pins blocked rather
 * than throwing.
 */
export async function resolveTenantModelSource(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
): Promise<ModelSource | undefined> {
  const response = await api(
    "GET",
    `/api/tenants/${tenantId}/models`,
    undefined,
    cookies,
  );
  const models = parseAs(
    ModelInfo.array(),
    response.data,
    "resolved catalog response",
  );
  let best: { provider: string; model: string; priority: number } | undefined;
  for (const model of models) {
    for (const offering of model.offerings) {
      if (
        best === undefined ||
        offering.priority < best.priority
      ) {
        best = {
          provider: offering.plugin,
          model: model.canonicalName,
          priority: offering.priority,
        };
      }
    }
  }
  return best === undefined ? undefined : { provider: best.provider, model: best.model };
}

/**
 * Installs ONLY the absent pins, tools first, then skills + grants +
 * workflows together through `seedTenant`. Safe to re-run: with every
 * pin present this is READS ONLY — `seedTenant` is never entered, the
 * publish is gated on the registry not already seeded, and a tarball
 * already published under its name@version is skipped (immutable).
 * Sidecar-unavailable (502-class) pins report `blocked` without
 * throwing — the same class `ensureSeeded` treats as pending; any other
 * failure reports `failed` and is safe to re-run.
 */
export async function reconcileTenantDesiredState(
  args: ReconcileArgs,
): Promise<ReconcileReport> {
  const { api, cookies, tenantId } = { ...args, tenantId: args.tenant.tenantId };
  const log = args.log;
  const status = await readTenantDesiredStateStatus(api, cookies, tenantId);
  const pins: ReconcilePin[] = [];
  let sawFailure = false;
  let sawBlocked = false;

  // Tools first: a workflow cannot launch without its tool-package pins
  // resolvable, so a publish failure must not be hidden behind a later
  // deploy success.
  if (status.tools === "present") {
    for (const pin of TENANT_DESIRED_STATE.toolPackages) {
      pins.push({ name: pin.name, kind: "tool-package", status: "present" });
    }
  } else {
    try {
      const workspacePacks = TENANT_DESIRED_STATE.toolPackages.filter(
        (pin) => pin.source.kind === "workspace-pack",
      );
      if (workspacePacks.length > 0) {
        const publish = args.publishToolRegistry ?? publishCorbitsToolsRegistry;
        await publish({
          api,
          cookies,
          hubUrl: args.hubUrl,
          tenantId,
          log,
        });
        for (const pin of workspacePacks) {
          pins.push({ name: pin.name, kind: "tool-package", status: "installed" });
        }
      }
      const tarballPins = TENANT_DESIRED_STATE.toolPackages.filter(
        (pin) => pin.source.kind === "tarball-url",
      );
      for (const pin of tarballPins) {
        const source = pin.source;
        if (source.kind !== "tarball-url") continue;
        const outcome = await installRegistryTarball({
          api,
          cookies,
          hubUrl: args.hubUrl,
          tenantId,
          name: pin.name,
          version: pin.version,
          fetchSource: () =>
            fetchRegistryTarballSource({
              url: source.url,
              integrity: source.integrity,
            }),
          log,
        });
        pins.push({
          name: pin.name,
          kind: "tool-package",
          status: outcome === "installed" ? "installed" : "present",
        });
      }
    } catch (cause) {
      if (isSidecarUnavailableError(cause)) {
        sawBlocked = true;
        for (const pin of TENANT_DESIRED_STATE.toolPackages) {
          if (pins.some((p) => p.name === pin.name)) continue;
          pins.push({ name: pin.name, kind: "tool-package", status: "blocked" });
        }
        log(
          `tool-package publish for tenant ${tenantId} is blocked (sidecar unavailable); reporting without failing`,
        );
      } else {
        sawFailure = true;
        for (const pin of TENANT_DESIRED_STATE.toolPackages) {
          if (pins.some((p) => p.name === pin.name)) continue;
          pins.push({ name: pin.name, kind: "tool-package", status: "failed" });
        }
        log(
          `tool-package publish for tenant ${tenantId} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
  }

  // Skills + grants + workflows together, via the one seeder. Entered
  // only when at least one workflow OR skill pin is pending; with all
  // present this whole function stays read-only.
  const workflowPending = Object.values(status.workflows).some(
    (s) => s !== "present",
  );
  const skillPending = Object.values(status.skills).some((s) => s !== "present");
  const workflowsBlocked = Object.values(status.workflows).some(
    (s) => s === "blocked",
  );

  if (!workflowPending && !skillPending) {
    for (const pin of TENANT_DESIRED_STATE.workflows) {
      pins.push({ name: pin.assetName, kind: "workflow", status: "present" });
    }
    for (const pin of TENANT_DESIRED_STATE.skills) {
      pins.push({ name: pin.name, kind: "skill", status: "present" });
    }
  } else {
    const model = args.model;
    const seedWorkflows = DEFAULT_WORKFLOWS.filter((workflow) =>
      TENANT_DESIRED_STATE.workflows.some((pin) => pin.assetName === workflow.assetName),
    );
    try {
      if (model === undefined) {
        throw new Error(
          `tenant ${tenantId} has no catalog offerings to deploy against`,
        );
      }
      await (args.seedTenantFn ?? seedTenant)({
        api,
        cookies,
        hubUrl: args.hubUrl,
        tenant: {
          tenantId,
          principalId: args.tenant.principalId ?? "",
          domain: args.tenant.domain ?? "",
        },
        model,
        pushWorkflow: args.pushWorkflow,
        log,
        workflows: seedWorkflows,
        confirmDeployments: false,
      });
      for (const pin of TENANT_DESIRED_STATE.workflows) {
        pins.push({ name: pin.assetName, kind: "workflow", status: "installed" });
      }
      for (const pin of TENANT_DESIRED_STATE.skills) {
        pins.push({ name: pin.name, kind: "skill", status: "installed" });
      }
    } catch (cause) {
      if (isSidecarUnavailableError(cause) || model === undefined) {
        sawBlocked = true;
        for (const pin of TENANT_DESIRED_STATE.workflows) {
          pins.push({ name: pin.assetName, kind: "workflow", status: "blocked" });
        }
        for (const pin of TENANT_DESIRED_STATE.skills) {
          if (pins.some((p) => p.name === pin.name)) continue;
          pins.push({ name: pin.name, kind: "skill", status: "blocked" });
        }
        log(
          `workflow deployment for tenant ${tenantId} is blocked (${model === undefined ? "no catalog offerings" : "sidecar unavailable"}); reporting without failing`,
        );
      } else {
        sawFailure = true;
        for (const pin of TENANT_DESIRED_STATE.workflows) {
          if (status.workflows[pin.assetName] === "present") {
            pins.push({ name: pin.assetName, kind: "workflow", status: "present" });
          } else {
            pins.push({ name: pin.assetName, kind: "workflow", status: "failed" });
          }
        }
        for (const pin of TENANT_DESIRED_STATE.skills) {
          if (pins.some((p) => p.name === pin.name)) continue;
          pins.push({ name: pin.name, kind: "skill", status: status.skills[pin.name] === "present" ? "present" : "failed" });
        }
        log(
          `workflow deployment for tenant ${tenantId} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
  }

  void workflowsBlocked;
  return {
    tenantId,
    ready: !sawFailure && !sawBlocked,
    pins,
  };
}
