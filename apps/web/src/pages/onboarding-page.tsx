// Landing point for a session the first-login hook just provisioned a
// personal bench for. The real stepper — welcome, invite teammates,
// first workflow — is a separate, larger piece of product work; this is
// a placeholder screen that only confirms the bench exists and gets out
// of the way.

import { Button, EmptyState, PageShell } from "@corbits/react-ui";
import { PartyPopper } from "lucide-react";

import { Link } from "../navigation";

export function OnboardingPage() {
  return (
    <PageShell width="full" className="page-fill">
      <EmptyState
        icon={<PartyPopper />}
        title="Your workbench is ready"
        description="We've set up a personal bench for you with the default workflows deployed."
        action={
          <Button asChild>
            <Link to="/">Go to your workbench</Link>
          </Button>
        }
      />
    </PageShell>
  );
}
