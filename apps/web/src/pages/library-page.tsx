import {
  Card,
  CardFooter,
  CardHeader,
  CardTitle,
  EmptyState,
  PageShell,
  TopBar,
  TopBarTitle,
} from "@corbits/react-ui";
import { Bot } from "lucide-react";

import { RunsSchema, useAPIQuery } from "../api";
import { countProp } from "../optional-props";
import { purposeRuns } from "../purpose-runs";
import type { APIQuery, RunsPage, WorkflowRun } from "../api";
import { QueryView } from "../query-view";

/**
 * The hub exposes no cross-tenant definitions listing, so the library shows
 * the definitions behind the caller's running workflow runs: one card per
 * distinct definition, taken from the run summaries.
 */
function distinctDefinitions(allRuns: readonly WorkflowRun[]): WorkflowRun[] {
  const byDefinition = new Map<string, WorkflowRun>();
  for (const run of purposeRuns(allRuns)) {
    if (!byDefinition.has(run.definitionId)) {
      byDefinition.set(run.definitionId, run);
    }
  }
  return [...byDefinition.values()];
}

export function LibraryPage({ runs }: { readonly runs: APIQuery<RunsPage> }) {
  return (
    <>
      <TopBar>
        <TopBarTitle
          {...countProp(
            runs.kind === "ready"
              ? distinctDefinitions(runs.data.data).length
              : undefined,
          )}
          subtitle="Workflow definitions running across your benches"
        >
          Library
        </TopBarTitle>
      </TopBar>
      <PageShell width="full" className="page-fill">
        <QueryView query={runs} label="the library">
          {(page) => {
            const definitions = distinctDefinitions(page.data);
            return definitions.length === 0 ? (
              <EmptyState
                icon={<Bot />}
                title="The library is empty"
                description="Workflow definitions with a run executing in any of your benches appear here. None are running yet."
              />
            ) : (
              <div className="card-grid">
                {definitions.map((definition) => (
                  <Card key={definition.definitionId}>
                    <CardHeader>
                      <CardTitle>{definition.definitionName}</CardTitle>
                    </CardHeader>
                    <CardFooter className="card-footer-row">
                      <span>{definition.tenantName}</span>
                    </CardFooter>
                  </Card>
                ))}
              </div>
            );
          }}
        </QueryView>
      </PageShell>
    </>
  );
}

export function LibraryRoute() {
  const runs = useAPIQuery("/api/me/workflows/runs", RunsSchema);
  return <LibraryPage runs={runs} />;
}
