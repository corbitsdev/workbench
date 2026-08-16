// The row of connected plugins at the top of the gallery — an at-a-glance
// "what's already wired up" strip, distinct from the search/category grid
// below it. Icon chip + a status dot, never a second copy of the card.

import { Button } from "@corbits/react-ui";
import type { ResolvedPlugin } from "@workbench/connections/plugins";

import { pluginIcon } from "./plugin-meta";

type InstalledPlugin = Extract<
  ResolvedPlugin,
  { readonly status: "connected" | "needs_attention" }
>;

function isInstalled(plugin: ResolvedPlugin): plugin is InstalledPlugin {
  return plugin.status !== "not_connected";
}

export function InstalledStrip({
  plugins,
  onOpen,
}: {
  readonly plugins: readonly ResolvedPlugin[];
  readonly onOpen: (plugin: ResolvedPlugin) => void;
}) {
  const installed = plugins.filter(isInstalled);
  if (installed.length === 0) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      role="group"
      aria-label="Installed plugins"
    >
      {installed.map((plugin) => {
        const Icon = pluginIcon(plugin.descriptor.id);
        return (
          <Button
            key={plugin.descriptor.id}
            type="button"
            variant="outline"
            size="icon"
            title={`${plugin.descriptor.displayName} — ${
              plugin.status === "connected" ? "connected" : "needs attention"
            }`}
            onClick={() => onOpen(plugin)}
            className="relative text-muted-foreground hover:text-foreground"
          >
            <Icon className="size-4" />
            <span
              aria-hidden="true"
              data-state={plugin.status}
              className="absolute -bottom-0.5 -right-0.5 size-2 border border-background data-[state=connected]:bg-success data-[state=needs_attention]:bg-destructive"
            />
          </Button>
        );
      })}
    </div>
  );
}
