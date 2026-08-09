import { PageShell, RichEmptyState } from "@corbits/react-ui";
import { Sparkles } from "lucide-react";

/**
 * An honest stub, not a placeholder: there is no skill registry in the hub
 * yet, so this page describes what a skill will be rather than rendering
 * invented rows against a surface with nothing real behind it.
 */
export function SkillsPage() {
  return (
    <PageShell width="full" className="page-fill">
      <RichEmptyState
        icon={<Sparkles />}
        title="Skills aren't built yet"
        description="A skill will be a named, reusable capability — instructions, tools, and guardrails packaged together — that an agent definition can declare and a bench can install. There's no skill registry in the hub yet, so this page has nothing real to list."
      />
    </PageShell>
  );
}

export function SkillsRoute() {
  return <SkillsPage />;
}
