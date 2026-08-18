// Preset Routine rows every real tenant starts with, planted after
// `seedTenant`'s own workflow-deploy loop (see seed.ts's `seedTenant`,
// which calls `ensureDefaultRoutines` last). Deploying a workflow only
// makes it launchable; nothing shows up in the Routines picker until a
// `routine` row actually references its deployed definition — CL-6201
// is exactly that gap: every default workflow deployed, zero routine
// rows ever created.
//
// Every preset is created DISABLED (`enabled: false`): a scheduled
// preset must never start firing just because a bench was minted. A
// disabled routine's "Run now" still works (the run-now route never
// checks `enabled` — see `packages/routines/src/routes.ts`), so a
// preset is inspectable and runnable the moment it's seeded, exactly
// what CL-6201 asks of the previously-stranded last-30-days-research
// definition.
//
// Idempotent by name, the same convention `seed.ts`'s own
// `ensureCatalogOffering`/`ensureWorkflowAsset` use: a re-seed lists
// existing routines first and skips any preset already present, never
// creating a duplicate.
import { paginatedSchema } from "@intx/types";
import { type } from "arktype";
import { CliError } from "./errors";
import { parseAs, type ApiCall } from "./hub";

const WorkflowDefinitionListItem = type({
  id: "string",
  name: "string",
  status: "string",
});

const RoutineListItem = type({
  id: "string",
  name: "string",
  enabled: "boolean",
  deliveryChannelId: "string | null",
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
    name: "Daily digest",
    assetName: "channel-digest",
    trigger: { kind: "daily", hour: 9, minute: 0 },
    input: {
      summary:
        "Daily digest — nothing computed yet; edit this routine's input.",
    },
  },
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

async function resolveDeployedDefinitionId(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
  assetName: string,
): Promise<string | undefined> {
  const listed = await api(
    "GET",
    `/api/tenants/${tenantId}/workflows/definitions`,
    undefined,
    cookies,
  );
  const page = parseAs(
    paginatedSchema(WorkflowDefinitionListItem),
    listed.data,
    "workflow definitions response",
  );
  return page.data.find(
    (definition) =>
      definition.name === assetName && definition.status === "deployed",
  )?.id;
}

/**
 * Plants `DEFAULT_ROUTINE_PRESETS` for one already-seeded tenant: every
 * preset whose workflow is deployed and not already present (by name)
 * gets a routine row, created enabled (the store's own default) and
 * immediately disabled. Every preset after the first reuses the first
 * preset's own delivery channel — "the workbench's own channel" is
 * whichever space the delivery-precedence chain
 * (`namedChannelId ?? homeChannelId ?? provisionedSpace?.channelId ??
 * null`, `packages/routines/src/routes.ts`) resolves the first preset
 * to, since no channel is named and no run-scoped home channel exists
 * at seed time — never a second channel per preset.
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

  let sharedDeliveryChannelId =
    existing.find((routine) => routine.deliveryChannelId !== null)
      ?.deliveryChannelId ?? undefined;

  for (const preset of DEFAULT_ROUTINE_PRESETS) {
    const already = existing.find((routine) => routine.name === preset.name);
    if (already !== undefined) {
      log(`routine "${preset.name}" already exists (skipped)`);
      continue;
    }

    const definitionId = await resolveDeployedDefinitionId(
      api,
      cookies,
      tenantId,
      preset.assetName,
    );
    if (definitionId === undefined) {
      log(
        `routine "${preset.name}" skipped: no deployed definition named ` +
          `"${preset.assetName}"`,
      );
      continue;
    }

    const body: Record<string, unknown> = {
      name: preset.name,
      definitionId,
      trigger: preset.trigger,
      scope: "bench",
      input: preset.input,
    };
    if (sharedDeliveryChannelId !== undefined) {
      body.deliveryChannelId = sharedDeliveryChannelId;
    }

    const created = await api(
      "POST",
      `/api/tenants/${tenantId}/routines`,
      body,
      cookies,
    );
    if (created.status !== 201) {
      throw new CliError(
        `the hub rejected creation of the default routine "${preset.name}" with status ${created.status}: ${JSON.stringify(created.data)}`,
        "check the hub logs for the underlying failure, then re-run: workbench seed",
      );
    }
    const row = parseAs(RoutineListItem, created.data, "routine response");

    if (
      sharedDeliveryChannelId === undefined &&
      row.deliveryChannelId !== null
    ) {
      sharedDeliveryChannelId = row.deliveryChannelId;
    }

    const disabled = await api(
      "PATCH",
      `/api/tenants/${tenantId}/routines/${row.id}`,
      { enabled: false },
      cookies,
    );
    if (disabled.status !== 200) {
      throw new CliError(
        `the hub rejected disabling the freshly-seeded routine "${preset.name}" with status ${disabled.status}: ${JSON.stringify(disabled.data)}`,
        "check the hub logs for the underlying failure, then re-run: workbench seed",
      );
    }

    log(`seeded routine "${preset.name}" (disabled)`);
  }
}
