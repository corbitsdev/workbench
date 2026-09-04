// One plugin, one dense data row: a small logo tile, name, the outcome
// sentence truncated to a single line, a status/provenance caption, and
// a single quiet action that reads honestly off `ResolvedPlugin`'s
// status — never a generic "manage" button that hides what state the
// connector is actually in. Density over cards: this is a directory to
// scan, not a set of tiles to admire (CL-6272.1).

import { Button } from "@corbits/react-ui";
import type { ResolvedPlugin } from "@corbits/connections/plugins";

import { pluginIcon, pluginOutcome } from "./plugin-meta";
import { PluginLogo } from "./plugin-logo";

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
    <div
      className="flex min-h-16 min-w-0 items-center gap-3 px-2 py-3"
      data-plugin-card
      data-plugin-name={plugin.descriptor.displayName}
    >
      <PluginLogo
        name={plugin.descriptor.displayName}
        icon={plugin.descriptor.icon}
        fallbackIcon={Icon}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">
          {plugin.descriptor.displayName}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {pluginOutcome(plugin.descriptor.id, plugin.descriptor.displayName)}
        </span>
      </div>
      <div className="flex flex-none items-center gap-2">
        <span className="text-xs text-muted-foreground">{caption}</span>
        {plugin.status === "not_connected" ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`Connect ${plugin.descriptor.displayName}`}
            onClick={onOpen}
          >
            Connect
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`Manage ${plugin.descriptor.displayName}`}
            onClick={onOpen}
          >
            Manage
          </Button>
        )}
      </div>
    </div>
  );
}
