// Replaces the whole shell, not a toast — a user with zero benches and a
// failed provisioning attempt has nothing useful to do elsewhere.

import { Button, EmptyState, PageShell } from "@corbits/react-ui";
import { WarningCircle } from "@/lib/icons";

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
