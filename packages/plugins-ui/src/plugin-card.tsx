// One plugin, one card: icon, name, the outcome sentence, and a single
// action that reads honestly off `ResolvedPlugin`'s status — never a
// generic "manage" button that hides what state the connector is
// actually in.

import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardTitle,
} from "@corbits/react-ui";
import type { ResolvedPlugin } from "@workbench/connections/plugins";
import { Plus } from "lucide-react";

import { pluginIcon, pluginOutcome } from "./plugin-meta";

const STATUS_BADGE: Record<
  ResolvedPlugin["status"],
  { readonly label: string; readonly tone: "success" | "danger" | "neutral" }
> = {
  connected: { label: "Connected", tone: "success" },
  needs_attention: { label: "Needs attention", tone: "danger" },
  not_connected: { label: "Not connected", tone: "neutral" },
};

/** Plain words, matching the plugin provenance labels the coordinator
 * asked skill scope badges to mirror. */
const PROVENANCE_LABEL: Record<"this-workbench" | "inherited", string> = {
  "this-workbench": "Connected here",
  inherited: "Inherited",
};

export function PluginCard({
  plugin,
  onOpen,
}: {
  readonly plugin: ResolvedPlugin;
  readonly onOpen: () => void;
}) {
  const Icon = pluginIcon(plugin.descriptor.id);
  const badge = STATUS_BADGE[plugin.status];

  return (
    <Card className="gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center border border-border text-muted-foreground"
        >
          <Icon className="size-4" />
        </span>
        {plugin.status === "not_connected" ? (
          <Button
            type="button"
            size="sm"
            variant="primary"
            aria-label={`Connect ${plugin.descriptor.displayName}`}
            onClick={onOpen}
          >
            <Plus className="size-3.5" />
          </Button>
        ) : (
          <Button type="button" size="sm" variant="outline" onClick={onOpen}>
            Manage
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <CardTitle>{plugin.descriptor.displayName}</CardTitle>
        <CardDescription>
          {pluginOutcome(plugin.descriptor.id, plugin.descriptor.displayName)}
        </CardDescription>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={badge.tone}>{badge.label}</Badge>
        {plugin.provenance !== null ? (
          <Badge tone="neutral">{PROVENANCE_LABEL[plugin.provenance]}</Badge>
        ) : null}
      </div>
    </Card>
  );
}
