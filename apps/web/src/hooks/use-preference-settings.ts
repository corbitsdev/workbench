import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AvailableBriefSource, PreferenceSetting } from "@workbench/shared";
import {
  getMeBriefSources,
  getMePreferenceSettings,
  patchMePreferences,
} from "../lib/hub-api";

const PREFERENCE_SETTINGS_KEY = ["me", "preference-settings"] as const;
const BRIEF_SOURCES_KEY = ["me", "brief-sources"] as const;

type PreferenceValue = boolean | string | number;

/** Loads the registry-driven settings with the caller's resolved values. */
export function usePreferenceSettings() {
  return useQuery({
    queryKey: PREFERENCE_SETTINGS_KEY,
    queryFn: getMePreferenceSettings,
    staleTime: 5 * 60_000,
  });
}

/** Loads the morning-brief sources the caller can toggle — catalog sources
 * with a credential configured for their tenant, each resolved against their
 * stored enablement. Unconfigured sources are absent from the result. */
export function useBriefSources() {
  return useQuery({
    queryKey: BRIEF_SOURCES_KEY,
    queryFn: getMeBriefSources,
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

type UpdateBriefSourceVars = { key: string; enabled: boolean };
type UpdateBriefSourceContext = { previous: AvailableBriefSource[] | undefined };

/** Toggles one brief source's enablement, keyed by its preference key (see
 * `briefSourcePreferenceKey`), optimistically against the brief-sources
 * cache. */
export function useUpdateBriefSource() {
  const queryClient = useQueryClient();
  return useMutation<
    AvailableBriefSource[],
    Error,
    UpdateBriefSourceVars,
    UpdateBriefSourceContext
  >({
    mutationFn: async ({ key, enabled }) => {
      await patchMePreferences({ [`briefSource:${key}`]: enabled });
      return getMeBriefSources();
    },
    onMutate: async ({ key, enabled }) => {
      await queryClient.cancelQueries({ queryKey: BRIEF_SOURCES_KEY });
      const previous = queryClient.getQueryData<AvailableBriefSource[]>(
        BRIEF_SOURCES_KEY,
      );
      if (previous) {
        queryClient.setQueryData<AvailableBriefSource[]>(
          BRIEF_SOURCES_KEY,
          previous.map((s) => (s.key === key ? { ...s, enabled } : s)),
        );
      }
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(BRIEF_SOURCES_KEY, context.previous);
      }
    },
    onSuccess: (sources) => {
      queryClient.setQueryData(BRIEF_SOURCES_KEY, sources);
    },
  });
}
