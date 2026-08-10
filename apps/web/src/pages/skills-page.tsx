import {
  LibrarySearchInput,
  PageShell,
  RichEmptyState,
  ViewToggle,
} from "@corbits/react-ui";
import type { ViewMode } from "@corbits/react-ui";
import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

import { CreateSkillDialog } from "./create-skill-dialog";

/**
 * The Skills page shell. There is no skill registry in the hub yet, so
 * this surface renders the agents-style chrome — toolbar (search + view
 * toggle), an honest empty state with a primary "Create skill" action —
 * against a list that is, for now, always empty. The create dialog
 * collects a draft but never POSTs; once a seam is real it will feed a
 * list instead of an empty state.
 *
 * The toolbar (search + view toggle) is gated behind a non-empty skills
 * list: with nothing to search or toggle, those controls would be inert
 * chrome, so the empty state's "Create skill" action is the sole
 * affordance until a registry exists.
 */
export function SkillsPage() {
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [createOpen, setCreateOpen] = useState(false);

  // No skill registry yet — the list is always empty. Kept as a local so
  // the toolbar gate reads honestly and is ready to wire to real data.
  const skills: unknown[] = [];

  // Mirror the agents page: a `workbench:skills:create` window event
  // opens the create dialog from anywhere (e.g. the command palette).
  useEffect(() => {
    const onCreate = () => setCreateOpen(true);
    window.addEventListener("workbench:skills:create", onCreate);
    return () =>
      window.removeEventListener("workbench:skills:create", onCreate);
  }, []);

  return (
    <>
      {skills.length > 0 && (
        <div className="page-toolbar">
          <LibrarySearchInput
            label="Search skills"
            value={query}
            onChange={setQuery}
          />
          <ViewToggle mode={viewMode} onChange={setViewMode} />
        </div>
      )}
      <PageShell width="full" className="page-fill">
        <RichEmptyState
          icon={<Sparkles />}
          title="No skills yet"
          description="A skill is a named, reusable capability — instructions, tools, and guardrails packaged together — that an agent definition can declare and a bench can install. There's no skill registry yet, so this page has nothing real to list."
          actions={[
            {
              label: "Create skill",
              onClick: () => setCreateOpen(true),
              variant: "primary",
            },
          ]}
        />
      </PageShell>
      <CreateSkillDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          /* No registry yet — the draft is accepted and dropped. */
        }}
      />
    </>
  );
}

/** A thin wrapper kept for parity with the other route exports; the
 * shell owns no tenant/data wiring yet, so the route is the page. */
export function SkillsRoute() {
  return <SkillsPage />;
}
