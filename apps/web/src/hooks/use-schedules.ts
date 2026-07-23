import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateScheduledTriggerBody,
  ScheduleRecurrence,
  ScheduledTrigger,
} from "@workbench/shared";
import {
  createMeSchedule,
  deleteMeSchedule,
  listMeSchedules,
  updateMeSchedule,
} from "../lib/hub-api";

const SCHEDULES_KEY = ["me-schedules"] as const;

// The caller's own routine schedules. Server-derived identity means these are
// never tenant-keyed — they belong to the authenticated member.
export function useMeSchedules(options?: { enabled?: boolean }) {
  return useQuery<ScheduledTrigger[]>({
    queryKey: SCHEDULES_KEY,
    enabled: options?.enabled ?? true,
    queryFn: listMeSchedules,
  });
}

export function useCreateSchedule() {
  const queryClient = useQueryClient();
  return useMutation<ScheduledTrigger, Error, CreateScheduledTriggerBody>({
    mutationFn: createMeSchedule,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SCHEDULES_KEY });
    },
  });
}

type UpdateVars = {
  id: string;
  enabled?: boolean;
  recurrence?: ScheduleRecurrence;
  payload?: Record<string, unknown>;
};

// Toggling enablement (or moving the hour / payload) applies optimistically so
// the switch responds instantly, and rolls the cache back on failure.
export function useUpdateSchedule() {
  const queryClient = useQueryClient();
  return useMutation<
    ScheduledTrigger,
    Error,
    UpdateVars,
    { previous: ScheduledTrigger[] | undefined }
  >({
    mutationFn: ({ id, ...patch }) => updateMeSchedule(id, patch),
    onMutate: async ({ id, enabled, recurrence, payload }) => {
      await queryClient.cancelQueries({ queryKey: SCHEDULES_KEY });
      const previous =
        queryClient.getQueryData<ScheduledTrigger[]>(SCHEDULES_KEY);
      if (previous) {
        queryClient.setQueryData<ScheduledTrigger[]>(
          SCHEDULES_KEY,
          previous.map((s) =>
            s.id === id
              ? {
                  ...s,
                  ...(enabled !== undefined ? { enabled } : {}),
                  ...(recurrence !== undefined ? { recurrence } : {}),
                  ...(payload !== undefined ? { triggerPayload: payload } : {}),
                }
              : s,
          ),
        );
      }
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(SCHEDULES_KEY, context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: SCHEDULES_KEY });
    },
  });
}

export function useDeleteSchedule() {
  const queryClient = useQueryClient();
  return useMutation<
    void,
    Error,
    { id: string },
    { previous: ScheduledTrigger[] | undefined }
  >({
    mutationFn: ({ id }) => deleteMeSchedule(id),
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey: SCHEDULES_KEY });
      const previous =
        queryClient.getQueryData<ScheduledTrigger[]>(SCHEDULES_KEY);
      if (previous) {
        queryClient.setQueryData<ScheduledTrigger[]>(
          SCHEDULES_KEY,
          previous.filter((s) => s.id !== id),
        );
      }
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(SCHEDULES_KEY, context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: SCHEDULES_KEY });
    },
  });
}
