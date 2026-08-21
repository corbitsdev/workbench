// The quiet half of CL-6462's landing: once Myra is up, the person is in
// a conversation and the remaining seeded workflows finish behind them.
// That is worth a single dismissible line and nothing more — never a
// blocking screen, never a count.
//
// It costs a request only for someone who just connected a provider:
// `markSetupInProgress` leaves a session flag on the way out of
// onboarding, and this note is the only thing that reads it, polling
// until the bench reports everything live and then clearing the flag for
// good. Every other page load does nothing at all.

import { Button } from "@corbits/react-ui";
import { X } from "@corbits/icons";
import { useEffect, useState } from "react";

import { fetchAgentReadiness } from "../onboarding";

const SETUP_IN_PROGRESS_KEY = "workbench.setup-in-progress";
const SETUP_POLL_MS = 15_000;

function readFlag(): boolean {
  try {
    return sessionStorage.getItem(SETUP_IN_PROGRESS_KEY) !== null;
  } catch {
    return false;
  }
}

function clearFlag(): void {
  try {
    sessionStorage.removeItem(SETUP_IN_PROGRESS_KEY);
  } catch {
    // A browser that refuses session storage simply never shows the note.
  }
}

/** Called on the way out of onboarding when the bench still has agents
 * coming online, so the note knows there is something to watch. */
export function markSetupInProgress(): void {
  try {
    sessionStorage.setItem(SETUP_IN_PROGRESS_KEY, "1");
  } catch {
    // Same as above: no storage, no note. Nothing else depends on it.
  }
}

export function SetupProgressNote() {
  const [visible, setVisible] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!readFlag()) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = () => {
      void fetchAgentReadiness().then((readiness) => {
        if (cancelled) return;
        if (readiness.kind === "ready") {
          clearFlag();
          setVisible(false);
          return;
        }
        setVisible(readiness.kind === "chat-ready");
        timer = setTimeout(poll, SETUP_POLL_MS);
      });
    };
    poll();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);

  if (!visible || dismissed) return null;

  return (
    <div className="setup-progress-note" role="status">
      <p className="setup-progress-note-text">
        Your workbench is still setting up in the background. Nothing to wait
        for — keep going.
      </p>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
      >
        <X aria-hidden />
      </Button>
    </div>
  );
}
