// Landing point for a session the first-login hook just provisioned a
// personal org for. The real stepper (welcome, invite teammates, first
// workflow) is CL-5295's job; this page only confirms the org exists
// and gets out of the way.

import { Button, EmptyState, PageShell } from "@corbits/react-ui";
import { PartyPopper } from "lucide-react";

import { Link } from "../navigation";

export function OnboardingPage() {
  return (
    <PageShell className="page-fill">
      <EmptyState
        icon={<PartyPopper />}
        title="Your workbench is ready"
        description="We've set up a personal org for you with the default workflows deployed."
        action={
          <Button asChild>
            <Link to="/">Go to your workbench</Link>
          </Button>
        }
      />
    </PageShell>
  );
}
