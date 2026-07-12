import { useState } from "react";
import { Button } from "@workbench/ui";
import { useSendBriefNow } from "../hooks/use-preference-settings";

type SendState = "idle" | "sent" | "rate_limited";

function isRateLimited(error: unknown): boolean {
  return (
    error instanceof Error &&
    "status" in error &&
    (error as { status?: unknown }).status === 429
  );
}

/** "Send my brief now" — lets a member fire their own morning brief on
 * demand instead of waiting for the daily schedule. The hub allows one
 * manual run per member per 10 minutes; a repeat within the window reads as
 * a friendly notice, never as an error. */
export function SendBriefNowButton() {
  const sendBrief = useSendBriefNow();
  const [state, setState] = useState<SendState>("idle");

  const handleClick = () => {
    setState("idle");
    sendBrief.mutate(undefined, {
      onSuccess: () => setState("sent"),
      onError: (error) => {
        setState(isRateLimited(error) ? "rate_limited" : "idle");
      },
    });
  };

  return (
    <div className="flex items-center gap-3 border-t border-border pt-4">
      <Button
        type="button"
        variant="secondary"
        onClick={handleClick}
        disabled={sendBrief.isPending}
      >
        {sendBrief.isPending ? "Sending…" : "Send my brief now"}
      </Button>
      {state === "sent" && (
        <span className="text-xs text-text-3">
          On its way — check your inbox in a minute.
        </span>
      )}
      {state === "rate_limited" && (
        <span className="text-xs text-text-3">
          You just ran one — try again in a few minutes.
        </span>
      )}
    </div>
  );
}
