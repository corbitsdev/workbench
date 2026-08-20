// Placeholders for the slug-addressed detail screens (CL-6412 routes them;
// the screens themselves are their own tickets). Each renders the slug it
// was routed for and a way back to its roster, so the route is real and
// testable before the page behind it exists. A path whose last segment
// isn't a slug has no entity to show and renders the not-found screen —
// the same one an unknown path gets.

import { Button, EmptyState, PageShell } from "@corbits/react-ui";
import { FlowArrow, Lightning, Robot, SquaresFour } from "@corbits/icons";
import type { ReactNode } from "react";

import { Link } from "../navigation";
import {
  AGENTS_PATH_PREFIX,
  PLUGINS_PATH_PREFIX,
  ROUTINES_PATH_PREFIX,
  SKILLS_PATH_PREFIX,
  detailSlugFromPath,
} from "../path-ids";
import { StageTopBar } from "../shell/stage-top-bar";
import { NotFoundPage } from "./not-found-page";

function DetailPlaceholder({
  path,
  prefix,
  entity,
  rosterLabel,
  icon,
}: {
  readonly path: string;
  readonly prefix: string;
  readonly entity: string;
  readonly rosterLabel: string;
  readonly icon: ReactNode;
}) {
  const slug = detailSlugFromPath(path, prefix);
  if (slug === null) return <NotFoundPage />;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar title={entity} subtitle={slug} />
      <PageShell width="full" className="page-fill">
        <EmptyState
          icon={icon}
          title={slug}
          description={`This ${entity.toLowerCase()} page is still being built.`}
          action={
            <Button asChild variant="outline">
              <Link to={prefix}>{`Back to ${rosterLabel}`}</Link>
            </Button>
          }
        />
      </PageShell>
    </div>
  );
}

export function AgentDetailPlaceholder({ path }: { readonly path: string }) {
  return (
    <DetailPlaceholder
      path={path}
      prefix={AGENTS_PATH_PREFIX}
      entity="Agent"
      rosterLabel="Agents"
      icon={<Robot />}
    />
  );
}

export function SkillDetailPlaceholder({ path }: { readonly path: string }) {
  return (
    <DetailPlaceholder
      path={path}
      prefix={SKILLS_PATH_PREFIX}
      entity="Skill"
      rosterLabel="Skills"
      icon={<Lightning />}
    />
  );
}

export function PluginDetailPlaceholder({ path }: { readonly path: string }) {
  return (
    <DetailPlaceholder
      path={path}
      prefix={PLUGINS_PATH_PREFIX}
      entity="Plugin"
      rosterLabel="Plugins"
      icon={<SquaresFour />}
    />
  );
}

export function RoutineDetailPlaceholder({ path }: { readonly path: string }) {
  return (
    <DetailPlaceholder
      path={path}
      prefix={ROUTINES_PATH_PREFIX}
      entity="Routine"
      rosterLabel="Routines"
      icon={<FlowArrow />}
    />
  );
}
