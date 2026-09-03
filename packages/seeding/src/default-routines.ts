// Preset Routine rows every real tenant starts with, planted after
// `seedTenant`'s own workflow-deploy loop (see seed.ts's `seedTenant`,
// which calls `ensureDefaultRoutines` last). Deploying a workflow only
// makes it launchable; a run-now-only utility still needs a `routine`
// row before it shows up in the Routines picker (CL-6201).
//
// workbench-digest is not a preset here: its cadence is the native
// `ScheduleTrigger` on the frozen definition (CL-4455), so a wrapper
// row would be a second schedule. A previously-planted pristine
// "Daily digest" row is retired by `pruneDroppedPresetRoutines`.
//
// Every remaining preset is created DISABLED (`enabled: false`): a
// scheduled preset must never start firing just because a bench was
// minted. A disabled routine's "Run now" still works (the run-now
// route never checks `enabled` — see `packages/routines/src/routes.ts`),
// so a preset is inspectable and runnable the moment it's seeded.
//
// Idempotent by a stable `presetKey` (each preset's own `assetName`),
// enforced server-side by `@corbits/routines`' `createRoutineIfAbsent`
// (a real `INSERT ... ON CONFLICT DO NOTHING`, unique per
// `(tenantId, presetKey)` — see packages/routines/src/store.ts and
// migrations.ts' 0005). The list-then-skip check below is only a fast
// path that avoids a redundant deploy lookup and API round trip on the
// common case; it is never the thing that prevents a duplicate. Two
// overlapping `ensureDefaultRoutines` calls (e.g. two "finish setup"
// requests racing, as `pending-seed.ts` explicitly allows) can both
// pass this check and both POST — the server-side conflict target is
// what guarantees exactly one row and one "Created routine" notice.
import { AssetWithOriginResponse } from "@intx/types";
import { type } from "arktype";
import { HubApiError, parseAs, type ApiCall } from "@corbits/hub-api-client";

const WorkflowDeploymentListItem = type({
  id: "string",
  definitionAssetId: "string",
  status: "string",
});

const RoutineListItem = type({
  id: "string",
  name: "string",
  enabled: "boolean",
  deliveryWorkbenchId: "string | null",
  presetKey: "string | null",
  createdAt: "string",
  updatedAt: "string",
});

/**
 * A preset's schedule — the same wire shape `@corbits/routines`'
 * `RoutineTrigger` accepts on `POST /routines`, spelled out locally so
 * this package never depends on `@corbits/routines` just to describe
 * data it hands the hub over HTTP. `null` is the manual, run-now-only
 * shape: last-30-days-research needs a fresh topic every run, so it is
 * never sensibly put on a fixed cadence.
 */
export type DefaultRoutineTrigger = {
  readonly kind: "daily";
  readonly hour: number;
  readonly minute: number;
} | null;

export type DefaultRoutinePreset = {
  /** Unique within a tenant's routines; the idempotency key a re-seed
   * matches an existing row against. */
  readonly name: string;
  /** The `DEFAULT_WORKFLOWS` asset name whose deployed definition this
   * preset targets. */
  readonly assetName: string;
  readonly trigger: DefaultRoutineTrigger;
  /** Rendered verbatim into the launch's trigger mail — see
   * `@corbits/routines`' `renderRoutineInput`. Empty for a preset with
   * nothing honest to pre-fill. */
  readonly input: Record<string, unknown>;
};

export const DEFAULT_ROUTINE_PRESETS: readonly DefaultRoutinePreset[] = [
  {
    name: "Last 30 days research",
    assetName: "last-30-days-research",
    trigger: null,
    // No starter topic: the workflow's own system prompt refuses to
    // invent one and replies with one plain sentence instead — an
    // honest teaching moment, not a broken run, if this fires with no
    // topic set.
    input: {},
  },
];

/**
 * Resolves an already-deployed default workflow to the stable
 * `definitionAssetId` `POST /routines` now requires — the workflow
 * asset's own id, not a `workflow_definition` row id. `/workflows/
 * definitions` (vendored `@intx/hub-api`) never exposes an asset id, so
 * this instead finds the asset by name (`/assets?kind=workflow`, the
 * same lookup `ensureWorkflowAsset` in `seed.ts` uses) and confirms a
 * live deployment exists for it (`/workflows/deployments`, matching
 * `ensureDeployment`'s own check) before handing the asset id back.
 */
async function resolveDeployedDefinitionAssetId(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
  assetName: string,
): Promise<string | undefined> {
  const listedAssets = await api(
    "GET",
    `/api/tenants/${tenantId}/assets?kind=workflow&inherited=false`,
    undefined,
    cookies,
  );
  const assets = parseAs(
    AssetWithOriginResponse.array(),
    listedAssets.data,
    "assets response",
  );
  const asset = assets.find((a) => a.name === assetName);
  if (asset === undefined) return undefined;

  const listedDeployments = await api(
    "GET",
    `/api/tenants/${tenantId}/workflows/deployments`,
    undefined,
    cookies,
  );
  const deployments = parseAs(
    WorkflowDeploymentListItem.array(),
    listedDeployments.data,
    "deployments response",
  );
  // Mirrors `isLiveDeploymentStatus` in `seed.ts` — duplicated locally
  // rather than imported to avoid a circular import (`seed.ts` imports
  // `ensureDefaultRoutines` from this file).
  const isLiveDeploymentStatus = (status: string): boolean =>
    status === "deployed" || status === "pending";
  const isDeployed = deployments.some(
    (d) => d.definitionAssetId === asset.id && isLiveDeploymentStatus(d.status),
  );
  return isDeployed ? asset.id : undefined;
}

/**
 * Reconciles `DEFAULT_ROUTINE_PRESETS` for one already-seeded tenant:
 * every preset whose workflow is deployed and not already present (by
 * `presetKey`, falling back to name for rows planted before the key
 * existed) gets a routine row, born disabled server-side. A preset the
 * member deleted stays deleted (the hub answers 204 and no row is
 * re-created), and a routine for a preset that no longer ships is
 * deleted only while pristine — never patched since it was planted
 * (`updatedAt` still equals `createdAt`); a member-touched row is the
 * member's and is kept. Existing rows are never updated to a preset's
 * current shape: once planted, the schedule, input, and name belong to
 * the bench, and a moved preset only shapes freshly-planted rows.
 * Every preset after the first reuses the first preset's own delivery
 * workbench — "the workbench's own workbench" is whichever space the
 * delivery-precedence chain
 * (`namedWorkbenchId ?? homeWorkbenchId ?? provisionedSpace?.workbenchId ??
 * null`, `packages/routines/src/routes.ts`) resolves the first preset
 * to, since no workbench is named and no run-scoped home workbench exists
 * at seed time — never a second workbench per preset.
 */
export async function ensureDefaultRoutines(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
  log: (line: string) => void,
): Promise<void> {
  const listed = await api(
    "GET",
    `/api/tenants/${tenantId}/routines`,
    undefined,
    cookies,
  );
  const existing = parseAs(
    type({ items: RoutineListItem.array() }),
    listed.data,
    "routines response",
  ).items;

  let sharedDeliveryWorkbenchId =
    existing.find((routine) => routine.deliveryWorkbenchId !== null)
      ?.deliveryWorkbenchId ?? undefined;

  await pruneDroppedPresetRoutines(api, cookies, tenantId, existing, log);

  for (const preset of DEFAULT_ROUTINE_PRESETS) {
    const already = existing.find(
      (routine) =>
        routine.presetKey === preset.assetName ||
        (routine.presetKey === null && routine.name === preset.name),
    );
    if (already !== undefined) {
      log(`routine "${preset.name}" already exists (skipped)`);
      continue;
    }

    const definitionAssetId = await resolveDeployedDefinitionAssetId(
      api,
      cookies,
      tenantId,
      preset.assetName,
    );
    if (definitionAssetId === undefined) {
      log(
        `routine "${preset.name}" skipped: no deployed definition named ` +
          `"${preset.assetName}"`,
      );
      continue;
    }

    const body: Record<string, unknown> = {
      name: preset.name,
      definitionAssetId,
      trigger: preset.trigger,
      scope: "bench",
      input: preset.input,
      // The create-if-absent identity — see this file's header comment.
      presetKey: preset.assetName,
    };
    if (sharedDeliveryWorkbenchId !== undefined) {
      body.deliveryWorkbenchId = sharedDeliveryWorkbenchId;
    }

    const created = await api(
      "POST",
      `/api/tenants/${tenantId}/routines`,
      body,
      cookies,
    );
    if (
      created.status === 400 &&
      /deliveryWorkbenchId is required/.test(JSON.stringify(created.data))
    ) {
      // This preset's definition needs somewhere to deliver to, and
      // seeding names no workbench — a person hasn't picked one yet, and
      // seeding must never invent one and name it after the routine
      // (that's exactly the "Daily digest"/"New Workbench" pollution this
      // preset-planting flow used to cause). The routine simply isn't
      // planted until a member creates it by hand and picks a real
      // destination.
      log(
        `routine "${preset.name}" skipped: its workflow needs a delivery ` +
          `workbench and this preset names none — create it by hand and ` +
          `pick one`,
      );
      continue;
    }
    if (
      created.status === 400 &&
      /is required/.test(JSON.stringify(created.data))
    ) {
      // The definition declares a required trigger input this preset has
      // nothing honest to pre-fill (last-30-days-research's "Topic").
      // Seeding must never fabricate a value and must never fail the
      // whole onboarding flow over an optional nicety — the workflow
      // stays deployed and creatable by hand with a real topic.
      log(
        `routine "${preset.name}" skipped: its definition requires input ` +
          `this preset cannot honestly pre-fill (${JSON.stringify(created.data)})`,
      );
      continue;
    }
    // 201: this call genuinely minted the row, born disabled with no
    // notice and no fire. 200: `presetKey` already resolved to an
    // existing row (this preset's own prior seed, or the winner of a
    // race against another overlapping seed call). 204: a member
    // deleted this preset's routine and the hub refused to resurrect
    // it — their choice stands.
    if (created.status === 204) {
      log(`routine "${preset.name}" was removed by a member (respected)`);
      continue;
    }
    if (created.status !== 201 && created.status !== 200) {
      throw new HubApiError(
        `the hub rejected creation of the default routine "${preset.name}" with status ${created.status}: ${JSON.stringify(created.data)}`,
        "check the hub logs for the underlying failure, then re-run: workbench seed",
      );
    }
    const row = parseAs(RoutineListItem, created.data, "routine response");

    if (
      sharedDeliveryWorkbenchId === undefined &&
      row.deliveryWorkbenchId !== null
    ) {
      sharedDeliveryWorkbenchId = row.deliveryWorkbenchId;
    }

    if (created.status === 200) {
      log(`routine "${preset.name}" already exists (skipped)`);
      continue;
    }

    log(`seeded routine "${preset.name}" (disabled)`);
  }
}

/**
 * Deletes routine rows whose `presetKey` no longer names a shipped
 * preset — but only pristine ones, never patched since they were
 * planted (`updatedAt` still equals `createdAt`; any member PATCH, and
 * any recorded fire failure, moves `updatedAt`). A touched row is the
 * member's and is kept, as is any pre-`presetKey` legacy row (there is
 * no honest way to tell it apart from a person-authored routine).
 */
async function pruneDroppedPresetRoutines(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
  existing: readonly (typeof RoutineListItem.infer)[],
  log: (line: string) => void,
): Promise<void> {
  const shippedKeys = new Set(
    DEFAULT_ROUTINE_PRESETS.map((preset) => preset.assetName),
  );
  for (const routine of existing) {
    if (routine.presetKey === null || shippedKeys.has(routine.presetKey)) {
      continue;
    }
    if (routine.updatedAt !== routine.createdAt) {
      log(
        `routine "${routine.name}" outlived its preset but was touched ` +
          `by a member (kept)`,
      );
      continue;
    }
    const deleted = await api(
      "DELETE",
      `/api/tenants/${tenantId}/routines/${routine.id}`,
      undefined,
      cookies,
    );
    if (deleted.status !== 204) {
      throw new HubApiError(
        `the hub rejected deleting the retired preset routine "${routine.name}" with status ${deleted.status}: ${JSON.stringify(deleted.data)}`,
        "check the hub logs for the underlying failure, then re-run: workbench seed",
      );
    }
    log(`routine "${routine.name}" retired (its preset no longer ships)`);
  }
}
