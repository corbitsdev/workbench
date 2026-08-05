import {
  Badge,
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  EmptyState,
  PageShell,
  TopBar,
  TopBarTitle,
} from "@corbits/react-ui";
import type { BadgeTone } from "@corbits/react-ui";
import { Bot } from "lucide-react";

import { AgentsSchema, useAPIQuery } from "../api";
import { countProp } from "../optional-props";
import type { Agent, AgentsPage, APIQuery } from "../api";
import { QueryView } from "../query-view";

const STATUS_TONE: Record<Agent["status"], BadgeTone> = {
  deployed: "success",
  updating: "info",
  stopped: "neutral",
  error: "danger",
};

export function LibraryPage({
  agents,
}: {
  readonly agents: APIQuery<AgentsPage>;
}) {
  return (
    <>
      <TopBar>
        <TopBarTitle
          {...countProp(
            agents.kind === "ready" ? agents.data.data.length : undefined,
          )}
          subtitle="Agents deployed across your workspaces"
        >
          Library
        </TopBarTitle>
      </TopBar>
      <PageShell className="page-fill">
        <QueryView query={agents} label="the library">
          {(page) =>
            page.data.length === 0 ? (
              <EmptyState
                icon={<Bot />}
                title="The library is empty"
                description="Agents deployed to any of your workspaces appear here. None exist yet."
              />
            ) : (
              <div className="card-grid">
                {page.data.map((agent) => (
                  <Card key={agent.id}>
                    <CardHeader>
                      <CardTitle>{agent.name}</CardTitle>
                      {agent.description == null ? null : (
                        <CardDescription>{agent.description}</CardDescription>
                      )}
                    </CardHeader>
                    <CardFooter className="card-footer-row">
                      <span>{agent.tenantName}</span>
                      <Badge tone={STATUS_TONE[agent.status]}>
                        {agent.status}
                      </Badge>
                    </CardFooter>
                  </Card>
                ))}
              </div>
            )
          }
        </QueryView>
      </PageShell>
    </>
  );
}

export function LibraryRoute() {
  const agents = useAPIQuery("/api/me/agents", AgentsSchema);
  return <LibraryPage agents={agents} />;
}
