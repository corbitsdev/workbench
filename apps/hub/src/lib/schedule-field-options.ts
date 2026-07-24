import { mapOrganizationListsToOptions } from "@workbench/tools-sumble";
import type { ScheduleFieldOption } from "@workbench/shared";
import type { HubDb } from "../db";
import { runCredentialTool } from "./run-credential-tool";

/**
 * General options-source registry for schedule intake fields (CL-4279): a
 * field's `optionsSource` key names one of these resolvers rather than being
 * hardcoded to any provider. Adding a new live-sourced field means adding one
 * entry here, never touching the schedule-field type or its renderer.
 */
export type ScheduleFieldOptionsResolver = (
  db: HubDb,
  tenantId: string,
  signal: AbortSignal,
) => Promise<ScheduleFieldOption[]>;

async function resolveSumbleOrganizationLists(
  db: HubDb,
  tenantId: string,
  signal: AbortSignal,
): Promise<ScheduleFieldOption[]> {
  const raw = await runCredentialTool(
    db,
    tenantId,
    "sumble_list_organization_lists",
    {},
    signal,
  );
  return mapOrganizationListsToOptions(JSON.parse(raw));
}

export const SCHEDULE_FIELD_OPTIONS_SOURCES: Record<
  string,
  ScheduleFieldOptionsResolver
> = {
  "sumble-organization-lists": resolveSumbleOrganizationLists,
};
