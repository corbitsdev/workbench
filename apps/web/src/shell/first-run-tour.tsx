// A one-time guided tour of the shell, shown the first time a person lands
// here after setup. "Seen" is a localStorage flag keyed by user id (mirrors
// `command-palette-recents.ts`'s defensive access) so a shared browser
// profile never re-shows it for the wrong account, and finishing or
// skipping both mark it seen for good — there is no "remind me later".

import Joyride, { ACTIONS, type CallBackProps, STATUS, type Step } from "react-joyride";
import { useState } from "react";
import { reportError } from "@corbits/error-sink";

const STORAGE_PREFIX = "workbench.first-run-tour-seen";

function hasSeenTour(userId: string): boolean {
  try {
    return window.localStorage.getItem(`${STORAGE_PREFIX}:${userId}`) === "true";
  } catch (error) {
    reportError(error, { operation: "first_run_tour_read" });
    return true; // Storage disabled: never nag with a tour that can't remember itself.
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
    target: '[data-tour="composer"]',
    title: "Talk to your agent",
    content: "Type here to send a message, share files, or @mention another agent.",
    placement: "top",
  },
  {
    target: '[data-tour="settings-button"]',
    title: "Settings",
    content: "Manage providers, credentials, and preferences from here.",
    placement: "top",
  },
];

/**
 * Mounted once from `AppShell`. Renders nothing once the tour has already
 * been seen for this user, so it costs nothing on every later visit.
 */
export function FirstRunTour({ userId }: { readonly userId: string }) {
  const [run, setRun] = useState(() => !hasSeenTour(userId));

  // Dismissing has to unmount Joyride, not just remember the dismissal:
  // a running Joyride keeps two portals appended to `document.body` and
  // an overlay over the app, and those portal containers are managed
  // outside React's tree.
  function handleCallback(data: CallBackProps) {
    // The tooltip's close (X) button fires action "close" without ever
    // moving status to FINISHED or SKIPPED, so it has to be treated as a
    // dismissal in its own right — otherwise closing the tour this way
    // never persists and it replays on the next mount.
    if (
      data.status === STATUS.FINISHED ||
      data.status === STATUS.SKIPPED ||
      data.action === ACTIONS.CLOSE
    ) {
      markTourSeen(userId);
      setRun(false);
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
      // The overlay otherwise swallows every click outside the spotlight —
      // real app chrome (e.g. a roster row's Chat link) is reachable at
      // any point in the shell, tour running or not, so clicks must pass
      // through to it rather than land on the tour's own backdrop.
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
