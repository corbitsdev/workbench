// "Seen" is a localStorage flag keyed by user id, so a shared browser
// profile never re-shows it as "new" for the wrong account. No "remind me
// later" — finishing or skipping both mark it seen.

import Joyride, { ACTIONS, type CallBackProps, STATUS, type Step } from "react-joyride";
import { reportError } from "@corbits/error-sink";
import { closeFirstRunTour, useFirstRunTourOpen } from "./first-run-tour-store";

const STORAGE_PREFIX = "workbench.first-run-tour-seen";

/** Used only to label the menu item that opens the tour ("Take the tour" vs
 * "Replay tour") — no longer gates whether the tour runs. */
export function hasSeenTour(userId: string): boolean {
  try {
    return window.localStorage.getItem(`${STORAGE_PREFIX}:${userId}`) === "true";
  } catch (error) {
    reportError(error, { operation: "first_run_tour_read" });
    return true; // Storage disabled: default to the less presumptuous label.
  }
}

function markTourSeen(userId: string): void {
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}:${userId}`, "true");
  } catch (error) {
    reportError(error, { operation: "first_run_tour_write" });
    // Storage disabled or full — the tour just replays next visit.
  }
}

const STEPS: readonly Step[] = [
  {
    target: '[data-tour="sidebar-list"]',
    title: "Your workbenches",
    content: "Every conversation with Myra and your agents lives here.",
    placement: "right",
    disableBeacon: true,
  },
  {
    target: '[data-tour="new-workbench-button"]',
    title: "Start something new",
    content: "Spin up a new workbench whenever you need a fresh conversation.",
    placement: "bottom",
  },
  {
    target: '[data-tour="settings-button"]',
    title: "Settings",
    content: "Manage providers, credentials, and preferences from here.",
    placement: "top",
  },
];

// Renders nothing until `openFirstRunTour` is called — never on its own,
// so landing on `/` never drops this overlay unprompted.
export function FirstRunTour({ userId }: { readonly userId: string }) {
  const run = useFirstRunTourOpen();

  // Must unmount Joyride, not just remember the dismissal — its portal
  // containers are managed outside React's tree.
  function handleCallback(data: CallBackProps) {
    // The close (X) button fires action "close" without moving status to
    // FINISHED or SKIPPED, so it must be treated as dismissal here too.
    if (
      data.status === STATUS.FINISHED ||
      data.status === STATUS.SKIPPED ||
      data.action === ACTIONS.CLOSE
    ) {
      markTourSeen(userId);
      closeFirstRunTour();
    }
  }

  if (!run) return null;

  return (
    <Joyride
      steps={STEPS as Step[]}
      run={run}
      continuous
      showSkipButton
      disableOverlayClose
      // Without this, the overlay swallows clicks outside the spotlight —
      // real app chrome must stay reachable while the tour runs.
      spotlightClicks
      spotlightPadding={6}
      callback={handleCallback}
      styles={{
        options: {
          arrowColor: "var(--card)",
          backgroundColor: "var(--card)",
          textColor: "var(--foreground)",
          overlayColor: "color-mix(in srgb, var(--foreground) 45%, transparent)",
          primaryColor: "var(--shell-accent)",
          zIndex: 10000,
        },
      }}
    />
  );
}
