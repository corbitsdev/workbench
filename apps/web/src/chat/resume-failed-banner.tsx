// A failed catch-up fetch must not leave the workbench looking idle —
// never a silent `.catch(() => undefined)`.
import { Button } from "@corbits/react-ui";
import { WarningCircle } from "@/lib/icons";
import { CHAT_STRINGS } from "./strings";

export function ResumeFailedBanner({
  refId,
  onRetry,
}: {
  readonly refId: string;
  readonly onRetry: () => void;
}) {
  return (
    <div className="chat-resume-failed-banner" role="alert">
      <WarningCircle aria-hidden="true" />
      <span className="chat-resume-failed-banner-text">
        {CHAT_STRINGS.resumeFailedNotice(refId)}
      </span>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        {CHAT_STRINGS.resumeFailedRetryAction}
      </Button>
    </div>
  );
}
