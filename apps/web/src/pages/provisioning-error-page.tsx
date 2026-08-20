// Shown when the first-login hook's provisioning call fails outright.
// A signed-in user with zero benches and a failed provisioning attempt has
// nothing useful to do anywhere else in the app, so this replaces the
// whole shell rather than a toast a user could miss or dismiss past.

import { Button, EmptyState, PageShell } from "@corbits/react-ui";
import { WarningCircle } from "@corbits/icons";

export function ProvisioningErrorPage({
  message,
  refId,
  onRetry,
}: {
  readonly message: string;
  readonly refId?: string | undefined;
  readonly onRetry: () => void;
}) {
  return (
    <PageShell width="full" className="page-fill">
      <EmptyState
        icon={<WarningCircle />}
        title="Couldn't set up your workbench"
        description={
          refId === undefined ? (
            message
          ) : (
            <>
              {message}
              <br />
              <span className="onboarding-error-refid">Reference: {refId}</span>
            </>
          )
        }
        action={
          <Button variant="outline" onClick={onRetry}>
            Try again
          </Button>
        }
      />
    </PageShell>
  );
}
