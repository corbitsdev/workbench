import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  PageShell,
  Section,
  Skeleton,
  StatGrid,
  StatTile,
} from "@corbits/react-ui";
import type { ReactNode } from "react";

import { useAPIQuery } from "../api";
import { PrincipalsSchema, ProfileSchema, RunsSchema } from "../api";
import type { APIQuery, PrincipalsPage, Profile, RunsPage } from "../api";
import { Link } from "../navigation";
import { purposeRuns } from "../purpose-runs";
import { SignedOutNotice } from "../query-view";

const SHORTCUTS = [
  {
    to: "/c",
    title: "Channels",
    description: "Talk to an agent in a streaming conversation.",
  },
  {
    to: "/routines",
    title: "Routines",
    description: "Schedule a workflow, or launch one on demand.",
  },
  {
    to: "/library",
    title: "Library",
    description:
      "Browse the documents, exports, and artifacts your workflows produce.",
  },
] as const;

function tileValue(query: APIQuery<{ data: unknown[] }>): ReactNode {
  switch (query.kind) {
    case "loading":
      return <Skeleton className="stat-skeleton" />;
    case "ready":
      return query.data.data.length;
    case "unauthenticated":
    case "error":
      return "unavailable";
  }
}

function workflowTileValue(query: APIQuery<RunsPage>): ReactNode {
  if (query.kind === "ready") return purposeRuns(query.data.data).length;
  return tileValue(query);
}

export function HomePage({
  profile,
  principals,
  runs,
}: {
  readonly profile: APIQuery<Profile>;
  readonly principals: APIQuery<PrincipalsPage>;
  readonly runs: APIQuery<RunsPage>;
}) {
  const greeting =
    profile.kind === "ready" ? `Welcome back, ${profile.data.name}` : "Welcome";
  return (
    <PageShell width="full" className="page-fill">
      {profile.kind === "unauthenticated" ? (
        <SignedOutNotice />
      ) : (
        <>
          <Section
            title={greeting}
            description="A live snapshot of your benches and what is running in them."
          >
            <StatGrid>
              <StatTile label="Benches" value={tileValue(principals)} />
              <StatTile
                label="Active workflows"
                value={workflowTileValue(runs)}
              />
            </StatGrid>
          </Section>
          <Section
            title="Jump in"
            description="The main surfaces of this workbench."
          >
            <div className="card-grid">
              {SHORTCUTS.map((shortcut) => (
                <Link key={shortcut.to} to={shortcut.to} className="card-link">
                  <Card>
                    <CardHeader>
                      <CardTitle>{shortcut.title}</CardTitle>
                      <CardDescription>{shortcut.description}</CardDescription>
                    </CardHeader>
                  </Card>
                </Link>
              ))}
            </div>
          </Section>
        </>
      )}
    </PageShell>
  );
}

export function HomeRoute() {
  const profile = useAPIQuery("/api/me", ProfileSchema);
  const principals = useAPIQuery("/api/me/principals", PrincipalsSchema);
  const runs = useAPIQuery("/api/me/workflows/runs", RunsSchema);
  return <HomePage profile={profile} principals={principals} runs={runs} />;
}
