import { Button, EmptyState, PageShell } from "@corbits/react-ui";
import { Compass } from "@corbits/icons";

import { Link } from "../navigation";

export function NotFoundPage() {
  return (
    <PageShell width="full" className="page-fill">
      <EmptyState
        icon={<Compass />}
        title="Page not found"
        description="This page doesn't exist."
        action={
          <Button asChild variant="outline">
            <Link to="/">Back to Myra</Link>
          </Button>
        }
      />
    </PageShell>
  );
}
