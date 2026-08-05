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
import {
  AgentsSchema,
  InstancesSchema,
  PrincipalsSchema,
  ProfileSchema,
} from "../api";
import type {
  AgentsPage,
  APIQuery,
  InstancesPage,
  PrincipalsPage,
  Profile,
} from "../api";
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
    description: "Watch the agent instances running right now.",
  },
  {
    to: "/library",
    title: "Library",
    description: "Browse the agents deployed across your workspaces.",
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
  agents,
  instances,
}: {
  readonly profile: APIQuery<Profile>;
  readonly principals: APIQuery<PrincipalsPage>;
  readonly agents: APIQuery<AgentsPage>;
  readonly instances: APIQuery<InstancesPage>;
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
              description="A live snapshot of your workspaces and what is running in them."
            >
              <StatGrid>
                <StatTile label="Workspaces" value={tileValue(principals)} />
                <StatTile label="Agents" value={tileValue(agents)} />
                <StatTile label="Active runs" value={tileValue(instances)} />
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
  const agents = useAPIQuery("/api/me/agents", AgentsSchema);
  const instances = useAPIQuery("/api/me/instances", InstancesSchema);
  return (
    <HomePage
      profile={profile}
      principals={principals}
      agents={agents}
      instances={instances}
    />
  );
}
