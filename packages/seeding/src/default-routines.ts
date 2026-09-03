// Leftover `@corbits/routines` wrapper rows from earlier seed passes.
// Native `ScheduleTrigger` (digest) and deployed automations
// (last-30-days-research in `DEFAULT_WORKFLOWS`) no longer get a
// routine row. Re-seed still DELETEs a pristine leftover whose
// `presetKey` is a retired preset; a member-touched row and any
// pre-`presetKey` legacy row stay.
import { type } from "arktype";
import { HubApiError, parseAs, type ApiCall } from "@corbits/hub-api-client";

const RoutineListItem = type({
  id: "string",
  name: "string",
  presetKey: "string | null",
  createdAt: "string",
  updatedAt: "string",
});

const RETIRED_ROUTINE_PRESET_KEYS = new Set([
  "workbench-digest",
  "last-30-days-research",
]);

/**
 * Deletes routine rows whose `presetKey` is a retired preset — but only
 * pristine ones, never patched since they were planted (`updatedAt`
 * still equals `createdAt`; any member PATCH, and any recorded fire
 * failure, moves `updatedAt`). A touched row is the member's and is
 * kept, as is any pre-`presetKey` legacy row (there is no honest way to
 * tell it apart from a person-authored routine).
 */
export async function pruneDroppedPresetRoutines(
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

  for (const routine of existing) {
    if (
      routine.presetKey === null ||
      !RETIRED_ROUTINE_PRESET_KEYS.has(routine.presetKey)
    ) {
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
    if (deleted.status === 204) {
      log(`routine "${routine.name}" retired (its preset no longer ships)`);
      continue;
    }
    if (deleted.status === 404) {
      log(`routine "${routine.name}" already retired`);
      continue;
    }
    throw new HubApiError(
      `the hub rejected deleting the retired preset routine "${routine.name}" with status ${deleted.status}: ${JSON.stringify(deleted.data)}`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }
}
