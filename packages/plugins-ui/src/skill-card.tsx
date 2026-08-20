// A skill, given the same dense row treatment as a plugin (owner ruling,
// CL-6090; density CL-6272.1): icon, name, its one-line description
// truncated, a scope caption in the same plain words the plugin
// provenance captions use — "shared" reads as the tenant-wide set an
// agent can pin, mirroring a plugin connected at the parent tenant;
// "private" is yours alone, same shape as a plugin this workbench
// connected for itself — and a quiet view affordance.

import { Button } from "@corbits/react-ui";
import { Sparkles } from "lucide-react";

export type SkillCardData = {
  readonly assetId: string;
  readonly name: string;
  readonly description: string;
  readonly scope: "private" | "tenant";
};

const SCOPE_LABEL: Record<SkillCardData["scope"], string> = {
  tenant: "Shared with everyone",
  private: "Just you",
};

export function SkillCard({
  skill,
  onOpen,
}: {
  readonly skill: SkillCardData;
  readonly onOpen: () => void;
}) {
  return (
    <div
      className="flex min-h-16 cursor-pointer items-center gap-3 border-b border-border px-2 py-3 hover:bg-muted/40"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <span
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center border border-border text-muted-foreground"
      >
        <Sparkles className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">{skill.name}</span>
        <span className="truncate text-xs text-muted-foreground">
          {skill.description}
        </span>
      </div>
      <span className="hidden shrink-0 text-xs text-muted-foreground xl:block">
        {SCOPE_LABEL[skill.scope]}
      </span>
      <Button type="button" size="sm" variant="ghost" onClick={onOpen}>
        View
      </Button>
    </div>
  );
}
