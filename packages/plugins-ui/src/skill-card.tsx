// A skill, given the same gallery treatment as a plugin (owner ruling,
// CL-6090): icon, name, its one-line description as the outcome sentence,
// and a scope badge in the same plain words the plugin provenance badges
// use — "shared" reads as the tenant-wide set an agent can pin, mirroring
// a plugin connected at the parent tenant; "private" is yours alone, same
// shape as a plugin this workbench connected for itself.

import { Badge, Card, CardDescription, CardTitle } from "@corbits/react-ui";
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
    <Card
      className="cursor-pointer gap-3 p-4"
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
      <div className="flex flex-col gap-1">
        <CardTitle>{skill.name}</CardTitle>
        <CardDescription>{skill.description}</CardDescription>
      </div>
      <div>
        <Badge tone={skill.scope === "tenant" ? "info" : "neutral"}>
          {SCOPE_LABEL[skill.scope]}
        </Badge>
      </div>
    </Card>
  );
}
