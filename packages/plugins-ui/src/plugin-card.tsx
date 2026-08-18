// One plugin, one dense data row: a small logo tile, name, the outcome
// sentence truncated to a single line, a status/provenance caption, and
// a single quiet action that reads honestly off `ResolvedPlugin`'s
// status — never a generic "manage" button that hides what state the
// connector is actually in. Density over cards: this is a directory to
// scan, not a set of tiles to admire (CL-6272.1).

import { Button } from "@corbits/react-ui";
import type { ResolvedPlugin } from "@workbench/connections/plugins";
import { Plus } from "lucide-react";

import { pluginIcon, pluginOutcome } from "./plugin-meta";

const STATUS_CAPTION: Record<ResolvedPlugin["status"], string> = {
  connected: "Connected",
  needs_attention: "Needs attention",
  not_connected: "Not connected",
};

/** Plain words, matching the plugin provenance labels the coordinator
 * asked skill scope captions to mirror. */
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
  const caption =
    plugin.provenance !== null
      ? `${STATUS_CAPTION[plugin.status]} · ${PROVENANCE_LABEL[plugin.provenance]}`
      : STATUS_CAPTION[plugin.status];

  return (
    <div className="flex h-10 items-center gap-3 border-b border-border px-2 last:border-b-0">
      <span
        aria-hidden="true"
        className="flex size-5 shrink-0 items-center justify-center text-muted-foreground"
      >
        <Icon className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="shrink-0 text-sm font-medium">
          {plugin.descriptor.displayName}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {pluginOutcome(plugin.descriptor.id, plugin.descriptor.displayName)}
        </span>
      </div>
      <span className="shrink-0 text-xs text-muted-foreground">
        {caption}
      </span>
      {plugin.status === "not_connected" ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={`Connect ${plugin.descriptor.displayName}`}
          onClick={onOpen}
        >
          <Plus className="size-3.5" />
        </Button>
      ) : (
        <Button type="button" size="sm" variant="ghost" onClick={onOpen}>
          Manage
        </Button>
      )}
    </div>
  );
}
