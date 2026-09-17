// A skill, given the same dense row treatment as a plugin (owner ruling,
// CL-6090; density CL-6272.1): icon, name, its one-line description
// truncated, and a quiet view affordance.
//
// CL-8086: skills are native `kind:"skill"` hub assets now and the stock
// asset routes carry no scope/visibility flag, so the "Shared with
// everyone" / "Just you" caption the card used to mirror from the plugin
// provenance captions is gone — one flat list, no scope groups.

import { Button } from "@corbits/react-ui";
import { Lightning } from "@corbits/icons";

export type SkillCardData = {
  readonly assetId: string;
  readonly name: string;
  readonly description: string;
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
        <Lightning className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">{skill.name}</span>
        <span className="truncate text-xs text-muted-foreground">{skill.description}</span>
      </div>
      <Button type="button" size="sm" variant="ghost" onClick={onOpen}>
        View
      </Button>
    </div>
  );
}
