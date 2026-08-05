import { Button, EmptyState, PageShell } from "@corbits/react-ui";
import { Compass } from "lucide-react";

import { Link } from "../navigation";

export function NotFoundPage({ path }: { readonly path: string }) {
  return (
    <PageShell className="page-fill">
      <EmptyState
        icon={<Compass />}
        title="Page not found"
        description={`Nothing lives at ${path}.`}
        action={
          <Button asChild variant="outline">
            <Link to="/">Back to home</Link>
          </Button>
        }
      />
    </PageShell>
  );
}
