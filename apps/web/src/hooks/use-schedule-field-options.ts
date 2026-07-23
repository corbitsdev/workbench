import { useQuery } from "@tanstack/react-query";
import { type } from "arktype";
import {
  ScheduleFieldOptionsResponseSchema,
  type ScheduleFieldOption,
} from "@workbench/shared";
import { api } from "../lib/api";

/**
 * Live options for a schedule intake field whose `optionsSource` names a
 * hub-resolved source (CL-4279), e.g. a Sumble organization list a workflow
 * author cannot enumerate statically. Gated with `enabled` so it only fires
 * once the field is actually rendered as a select; a 5-minute staleTime keeps
 * it out of the request-on-every-keystroke path.
 */
export function useScheduleFieldOptions(sourceId: string | undefined) {
  return useQuery<ScheduleFieldOption[]>({
    queryKey: ["schedule-field-options", sourceId ?? null],
    queryFn: async () => {
      const raw = await api<unknown>(
        "GET",
        `/schedule-field-options/${encodeURIComponent(sourceId as string)}`,
      );
      const parsed = ScheduleFieldOptionsResponseSchema(raw);
      if (parsed instanceof type.errors) {
        throw new Error(
          `Unexpected schedule-field-options response: ${parsed.summary}`,
        );
      }
      return parsed.options;
    },
    enabled: sourceId !== undefined && sourceId.length > 0,
    staleTime: 5 * 60_000,
  });
}
