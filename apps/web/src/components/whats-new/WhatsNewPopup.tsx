import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { latestChangelogRelease } from "@workbench/shared";
import {
  useMarkChangelogSeen,
  useShouldShowChangelogPopup,
} from "../../hooks/use-changelog";
import { WhatsNewDialog } from "./WhatsNewDialog";

/**
 * A quiet, dismissible bottom-anchored surface announcing the latest release.
 * Mounted once at the app-frame layer (see `router.tsx`'s `AppShell`) so it
 * never renders on unauthenticated routes. Shows only once the onboarding
 * tour is done and the caller hasn't seen the latest changelog version.
 */
export function WhatsNewPopup() {
  const shouldShow = useShouldShowChangelogPopup();
  const markSeen = useMarkChangelogSeen();
  const reduceMotion = useReducedMotion() ?? false;
  const [dismissed, setDismissed] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const release = latestChangelogRelease();

  const visible = shouldShow && !dismissed;

  function handleDismiss() {
    setDismissed(true);
    markSeen();
  }

  return (
    <>
      <AnimatePresence>
        {visible && (
          <motion.div
            role="status"
            aria-label={`New in Workbench ${release.version}`}
            initial={reduceMotion ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? undefined : { opacity: 0, y: 12 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="fixed bottom-4 right-4 z-40 flex w-72 items-start gap-3 rounded-xl border border-border bg-surface p-3.5 shadow-lg"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-text">
                New in Workbench {release.version}
              </p>
              <button
                type="button"
                onClick={() => setDialogOpen(true)}
                className="mt-1 text-xs font-medium text-orange transition-colors hover:text-orange-deep"
              >
                See what's new
              </button>
            </div>
            <button
              type="button"
              onClick={handleDismiss}
              aria-label="Dismiss"
              className="grid h-6 w-6 flex-none place-items-center rounded-[7px] text-text-3 transition-colors hover:bg-page hover:text-text"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="h-3.5 w-3.5"
              >
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {dialogOpen && (
        <WhatsNewDialog
          release={release}
          onClose={() => setDialogOpen(false)}
          onDone={() => {
            setDismissed(true);
            markSeen();
          }}
        />
      )}
    </>
  );
}
