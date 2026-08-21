// Placeholders for the slug-addressed detail screens (CL-6412 routes them;
// the screens themselves are their own tickets). Each renders the slug it
// was routed for and a way back to its roster, so the route is real and
// testable before the page behind it exists.

import { Button, EmptyState, PageShell } from "@corbits/react-ui";
import { SquaresFour } from "@corbits/icons";
import type { Slug } from "@corbits/slug";
import type { ReactNode } from "react";

import { Link } from "../navigation";
import { PLUGINS_PATH_PREFIX } from "../path-ids";
import { StageTopBar } from "../shell/stage-top-bar";

function DetailPlaceholder({
  slug,
  entity,
  rosterLabel,
  rosterPath,
  icon,
}: {
  readonly slug: Slug;
  readonly entity: string;
  readonly rosterLabel: string;
  readonly rosterPath: string;
  readonly icon: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        crumbs={[{ label: rosterLabel, href: rosterPath }, { label: slug }]}
      />
      <PageShell width="full" className="page-fill">
        <EmptyState
          icon={icon}
          title={slug}
          description={`This ${entity.toLowerCase()} page is still being built.`}
          action={
            <Button asChild variant="outline">
              <Link to={rosterPath}>{`Back to ${rosterLabel}`}</Link>
            </Button>
          }
        />
      </PageShell>
    </div>
  );
}

export function PluginDetailPlaceholder({ slug }: { readonly slug: Slug }) {
  return (
    <DetailPlaceholder
      slug={slug}
      entity="Plugin"
      rosterLabel="Plugins"
      rosterPath={PLUGINS_PATH_PREFIX}
      icon={<SquaresFour />}
    />
  );
}
