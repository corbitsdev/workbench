import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PreferenceSetting } from "@workbench/shared";
import { getMePreferenceSettings, patchMePreferences } from "../lib/hub-api";

const PREFERENCE_SETTINGS_KEY = ["me", "preference-settings"] as const;

type PreferenceValue = boolean | string | number;

/** Loads the registry-driven settings with the caller's resolved values. */
export function usePreferenceSettings() {
  return useQuery({
    queryKey: PREFERENCE_SETTINGS_KEY,
    queryFn: getMePreferenceSettings,
    staleTime: 5 * 60_000,
  });
}

type UpdateVars = { key: string; value: PreferenceValue };
type UpdateContext = { previous: PreferenceSetting[] | undefined };

/**
 * Optimistically writes a single preference: the cache updates immediately, the
 * PATCH persists it, and a failed write rolls the cache back to its prior value.
 */
export function useUpdatePreference() {
  const queryClient = useQueryClient();
  return useMutation<PreferenceSetting[], Error, UpdateVars, UpdateContext>({
    mutationFn: async ({ key, value }) => {
      await patchMePreferences({ [key]: value });
      return getMePreferenceSettings();
    },
    onMutate: async ({ key, value }) => {
      await queryClient.cancelQueries({ queryKey: PREFERENCE_SETTINGS_KEY });
      const previous = queryClient.getQueryData<PreferenceSetting[]>(
        PREFERENCE_SETTINGS_KEY,
      );
      if (previous) {
        queryClient.setQueryData<PreferenceSetting[]>(
          PREFERENCE_SETTINGS_KEY,
          previous.map((s) => (s.key === key ? { ...s, value } : s)),
        );
      }
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(PREFERENCE_SETTINGS_KEY, context.previous);
      }
    },
    onSuccess: (settings) => {
      queryClient.setQueryData(PREFERENCE_SETTINGS_KEY, settings);
    },
  });
}
