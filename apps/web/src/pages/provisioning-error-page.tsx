// Shown when the first-login hook's provisioning call fails outright.
// A signed-in user with zero orgs and a failed provisioning attempt has
// nothing useful to do anywhere else in the app, so this replaces the
// whole shell rather than a toast a user could miss or dismiss past.

import { Button, EmptyState, PageShell } from "@corbits/react-ui";
import { CircleAlert } from "lucide-react";

export function ProvisioningErrorPage({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry: () => void;
}) {
  return (
    <PageShell className="page-fill">
      <EmptyState
        icon={<CircleAlert />}
        title="Couldn't set up your workbench"
        description={message}
        action={
          <Button variant="outline" onClick={onRetry}>
            Try again
          </Button>
        }
      />
    </PageShell>
  );
}
