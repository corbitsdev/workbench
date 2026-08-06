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
  TopBar,
  TopBarTitle,
} from "@corbits/react-ui";
import type { ReactNode } from "react";

import { useAPIQuery } from "../api";
import { PrincipalsSchema, ProfileSchema, RunsSchema } from "../api";
import type { APIQuery, PrincipalsPage, Profile, RunsPage } from "../api";
import { Link } from "../navigation";
import { subtitleProp } from "../optional-props";
import { SignedOutNotice } from "../query-view";

const SHORTCUTS = [
  {
    to: "/chat",
    title: "Chat",
    description: "Talk to an agent in a streaming conversation.",
  },
  {
    to: "/runs",
    title: "Runs",
    description: "Watch the workflow runs executing right now.",
  },
  {
    to: "/library",
    title: "Library",
    description: "Browse the workflow definitions running across your benches.",
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
    <>
      <TopBar>
        <TopBarTitle
          {...subtitleProp(
            profile.kind === "ready" ? profile.data.email : undefined,
          )}
        >
          Home
        </TopBarTitle>
      </TopBar>
      <PageShell className="page-fill">
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
                <StatTile label="Active runs" value={tileValue(runs)} />
              </StatGrid>
            </Section>
            <Section
              title="Jump in"
              description="The main surfaces of this workbench."
            >
              <div className="card-grid">
                {SHORTCUTS.map((shortcut) => (
                  <Link
                    key={shortcut.to}
                    to={shortcut.to}
                    className="card-link"
                  >
                    <Card>
                      <CardHeader>
                        <CardTitle>{shortcut.title}</CardTitle>
                        <CardDescription>
                          {shortcut.description}
                        </CardDescription>
                      </CardHeader>
                    </Card>
                  </Link>
                ))}
              </div>
            </Section>
          </>
        )}
      </PageShell>
    </>
  );
}

export function HomeRoute() {
  const profile = useAPIQuery("/api/me", ProfileSchema);
  const principals = useAPIQuery("/api/me/principals", PrincipalsSchema);
  const runs = useAPIQuery("/api/me/workflows/runs", RunsSchema);
  return <HomePage profile={profile} principals={principals} runs={runs} />;
}
