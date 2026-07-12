import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { hasUnseenChangelog, latestChangelogVersion } from "@workbench/shared";
import { getMePreferences, patchMePreferences } from "../lib/hub-api";
import { usePreferenceSettings } from "./use-preference-settings";

const CHANGELOG_SEEN_KEY = "changelogSeenVersion";
const TOUR_DONE_KEY = "onboardingTourDone";
const MEMBER_PREFERENCES_KEY = ["me", "preferences"] as const;

/** The caller's raw persisted preferences (the open jsonb map), not the
 * registry-derived settings list — this is where `changelogSeenVersion` lives. */
function useMemberPreferences() {
  return useQuery({
    queryKey: MEMBER_PREFERENCES_KEY,
    queryFn: getMePreferences,
    staleTime: 5 * 60_000,
  });
}

/**
 * Whether the "what's new" pop-up should show: the caller has an unseen
 * changelog release and the onboarding tour has finished. Suppressing until
 * the tour is done keeps the two first-run surfaces from competing for the
 * same screen — the tour setting hasn't loaded is treated the same as "not
 * done yet" so the pop-up never races the tour's auto-launch.
 */
export function useShouldShowChangelogPopup(): boolean {
  const preferencesQuery = useMemberPreferences();
  const settingsQuery = usePreferenceSettings();

  if (!preferencesQuery.data || !settingsQuery.data) return false;

  const seenVersion = preferencesQuery.data[CHANGELOG_SEEN_KEY];
  const tourSetting = settingsQuery.data.find((s) => s.key === TOUR_DONE_KEY);
  const tourDone = tourSetting?.value === true;

  return (
    tourDone &&
    hasUnseenChangelog(typeof seenVersion === "string" ? seenVersion : "")
  );
}

/** Stamps the caller's changelog watermark to the latest release. */
export function useMarkChangelogSeen(): () => void {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () =>
      patchMePreferences({ [CHANGELOG_SEEN_KEY]: latestChangelogVersion() }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: MEMBER_PREFERENCES_KEY });
    },
  });
  return () => {
    mutation.mutateAsync().catch(() => {
      // A failed stamp just leaves the pop-up/dialog reachable again next
      // time; no error surface is warranted for a housekeeping write.
    });
  };
}
